// /api/wubookSyncToday.js
// OBJETIVO: Sincronizar las reservas del día (llegadas, salidas, alojados) y guardar historial de cambios.
// Usa 'fetch_today_reservations' de WuBook. Pensado para un cron horario.
//
// ⚠️ Criterio de FECHAS/TZ:
// - Este endpoint mantiene el consumo de `fetch_today_reservations` (que define "hoy" del lado de WuBook).
// - Para CONSISTENCIA con el enriquecedor y con otros importadores, todos los timestamps y filtros locales
//   usan Luxon con TZ fija 'America/Argentina/Buenos_Aires' y Firestore `serverTimestamp()`.
// - Se agrega `propiedad_id` al contexto de historial para facilitar auditoría multi-propiedad.
// - ⚠️ Se EXCLUYEN reservas canceladas (status/flags) antes de persistir.
//
// 🆕 PRECIO WUBOOK + toPay_breakdown:
// - Se agrega `wubook_price` por room (amount pre-IVA, vat, total, currency).
// - Si currency === 'USD' -> se completa `toPay` y `toPay_breakdown` sin pisar valores host-editados.

import axios from 'axios';
import qs from 'qs';
import crypto from 'crypto';
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';
import { getPropertiesAndRoomMaps } from '../lib/fetchPropertiesAndRoomMaps.js';

// ===================== CONFIGURACIÓN Y UTILIDADES =====================
const log = (...args) => console.log(`[SyncToday]`, ...args);
const TZ = 'America/Argentina/Buenos_Aires';
const BASE_URL = process.env.WUBOOK_BASE_URL || 'https://kapi.wubook.net/kp';
const parseEU = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TZ });
const euToISO = (s) => (s ? parseEU(s).toISODate() : null);
const round2 = (n) => Number.isFinite(Number(n)) ? +Number(n).toFixed(2) : 0;
const cur = (c) => String(c || '').trim().toUpperCase();
const isNonNull = (v) => v !== undefined && v !== null;

function recomputeToPayFrom(breakdown, extrasUSDFinal) {
  const numOrZero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const b = numOrZero(breakdown?.baseUSD);
  const ivaPct = numOrNull(breakdown?.ivaPercent);
  let ivaUSD = numOrNull(breakdown?.ivaUSD);
  if (ivaUSD === null && ivaPct !== null && b > 0) {
    ivaUSD = Number((b * ivaPct / 100).toFixed(2));
  }
  const e = numOrZero(isNonNull(extrasUSDFinal) ? extrasUSDFinal : breakdown?.extrasUSD);
  const total = Number((b + (ivaUSD || 0) + e).toFixed(2));
  return { total };
}

// ---- Respuestas HTTP ----
function ok(res, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(200).json(data);
}
function bad(res, code, error) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(code).json({ error });
}

// ===================== HELPERS: DIFF & HASH =====================
const IGNORE_KEYS = new Set(['updatedAt', 'createdAt', 'contentHash', 'enrichmentStatus', 'enrichedAt']);

const sortObject = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortObject(obj[k]);
      return acc;
    }, {});
  }
  return obj;
};

const stableStringify = (obj) => JSON.stringify(sortObject(obj));

const stripKeys = (obj, ignore = IGNORE_KEYS) => {
  const out = {};
  for (const k of Object.keys(obj || {})) if (!ignore.has(k)) out[k] = obj[k];
  return out;
};

const hashDoc = (doc) =>
  crypto.createHash('sha1').update(stableStringify(stripKeys(doc))).digest('hex');

const diffDocs = (oldDoc = {}, newDoc = {}) => {
  const diff = {};
  const keys = new Set([...Object.keys(oldDoc || {}), ...Object.keys(newDoc || {})]);
  for (const k of keys) {
    if (IGNORE_KEYS.has(k)) continue;
    const a = oldDoc?.[k];
    const b = newDoc?.[k];
    if (stableStringify(a) !== stableStringify(b)) {
      diff[k] = { from: a === undefined ? null : a, to: b === undefined ? null : b };
    }
  }
  return diff;
};

// ===================== Canceladas: normalización y detección =====================
const normalizeStatus = (s) => String(s || 'unknown').toLowerCase().replace(/\s+/g, '_');
const isCancelledReservation = (r) => {
  const s = normalizeStatus(r?.status || r?.state || r?.reservation_status);
  if (s.includes('cancel')) return true;
  if (r?.is_cancelled === true || r?.cancelled === true) return true;
  if (normalizeStatus(r?.cancellation?.status).includes('cancel')) return true;
  return false;
};

// ===================== HANDLER PRINCIPAL =====================
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 405, 'Método no permitido');

  try {
    const { propertyIds, dryRun = false } = (req.body && req.method === 'POST') ? req.body : {};
    log('INIT', { propertyIds, dryRun });

    const propiedades = await getPropertiesAndRoomMaps({
      propertyIds,
      onlyActiveIfNoIds: true,
      log,
    });
    if (!propiedades.length) return bad(res, 400, 'No se encontraron propiedades con api_key de WuBook.');

    const summary = [];

    for (const prop of propiedades) {
      log('PROP START', { id: prop.id, nombre: prop.nombre, roomsMapped: prop.roomMap.size });

      // --- WuBook fetch_today_reservations ---
      let reservas = [];
      try {
        const headers = { 'x-api-key': prop.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
        log(`WuBook POST ${BASE_URL}/reservations/fetch_today_reservations`);
        const resp = await axios.post(`${BASE_URL}/reservations/fetch_today_reservations`, qs.stringify({}), { headers });
        reservas = resp?.data?.data?.reservations || [];
      } catch (error) {
        log('WuBook API Error:', error.response ? error.response.data : error.message);
      }

      const totalRaw = reservas.length;
      reservas = reservas.filter(r => !isCancelledReservation(r));
      log('Reservas filtradas canceladas', { propId: prop.id, total: reservas.length, skipped_cancelled: totalRaw - reservas.length });

      if (dryRun) {
        summary.push({ propiedad: { id: prop.id, nombre: prop.nombre }, found_today: reservas.length, dryRun: true });
        continue;
      }

      let batch = firestore.batch();
      const MAX_OPS = 450;
      let ops = 0;
      const flush = async () => {
        if (ops > 0) {
          await batch.commit();
          batch = firestore.batch();
          ops = 0;
        }
      };
      const flushIfNeeded = async () => {
        if (ops >= MAX_OPS) {
          await flush();
        }
      };

      const now = FieldValue.serverTimestamp();
      let upserts = 0, skipped = 0, unchanged = 0;

      for (const r of reservas) {
        const fullName = `${r?.customer?.name || ''} ${r?.customer?.surname || ''}`.trim() || String(r?.booker) || 'N/D';
        const sourceChannel = r?.origin?.channel && r.origin.channel !== '--' ? r.origin.channel : (r?.channel_name || 'Directo/WuBook');
        const rsrvid = r?.id ?? r?.rsrvid ?? r?.reservation_id ?? r?.rexid ?? r?.rid ?? null;

        for (const room of r?.rooms || []) {
          const idZak = String(room?.id_zak_room || room?.id_zak_room_type || '');
          const mapData = prop.roomMap.get(idZak);
          if (!idZak || !mapData) { skipped++; continue; }

          const { codigo_depto, nombre_depto } = mapData;
          const arrivalEU = room?.arrival || room?.dfrom || r?.arrival || r?.dfrom || null;
          const departureEU = room?.departure || room?.dto || r?.departure || r?.dto || null;
          if (!arrivalEU || !departureEU) { skipped++; continue; }

          const docId = `${prop.id}_${r.id_human}_${idZak}`;
          const ref = firestore.collection('Reservas').doc(docId);
          const snap = await ref.get();
          const existed = snap.exists;
          const oldDoc = existed ? snap.data() : {};
          const oldBD = oldDoc?.toPay_breakdown || {};

          const roomPrice = room?.price || r?.price?.rooms || null;
          const wubook_price = roomPrice ? {
            amount: round2(roomPrice.amount),
            vat: round2(roomPrice.vat),
            total: round2(roomPrice.total),
            currency: cur(roomPrice.currency || r?.price?.rooms?.currency || r?.price?.currency)
          } : null;

          const preservedBD = {
            baseUSD:    isNonNull(oldBD.baseUSD)    ? oldBD.baseUSD    : (wubook_price?.currency === 'USD' ? round2(wubook_price.amount) : null),
            ivaPercent: isNonNull(oldBD.ivaPercent) ? oldBD.ivaPercent : null,
            ivaUSD:     isNonNull(oldBD.ivaUSD)     ? oldBD.ivaUSD     : null,
            extrasUSD:  isNonNull(oldBD.extrasUSD)  ? oldBD.extrasUSD  : null,
            fxRate:     isNonNull(oldBD.fxRate)     ? oldBD.fxRate     : null,
          };
          const preservedExtrasTop = isNonNull(oldDoc?.extrasUSD) ? oldDoc.extrasUSD : null;

          const baseDoc = {
            id_human: r.id_human,
            rsrvid,
            propiedad_id: prop.id,
            propiedad_nombre: prop.nombre,
            nombre_huesped: fullName,
            source: sourceChannel,
            id_zak: idZak,
            codigo_depto,
            depto_nombre: nombre_depto || null,
            arrival: arrivalEU,
            arrival_iso: euToISO(arrivalEU),
            departure: departureEU,
            departure_iso: euToISO(departureEU),
            adults: room?.occupancy?.adults ?? r?.adults ?? null,
            children: room?.occupancy?.children ?? r?.children ?? 0,
            status: normalizeStatus(r?.status || 'unknown'),
            is_cancelled: false,
            ...(wubook_price ? { wubook_price } : {})
          };

          if (wubook_price && wubook_price.currency === 'USD') {
            const { total } = recomputeToPayFrom(preservedBD, preservedBD.extrasUSD);
            baseDoc.currency = 'USD';
            if (!isNonNull(oldDoc?.toPay)) baseDoc.toPay = total;
            if (!isNonNull(oldDoc?.extrasUSD)) baseDoc.extrasUSD = preservedExtrasTop;
            baseDoc.toPay_breakdown = { ...(oldBD || {}), ...preservedBD };
          }

          const createdAt = existed && oldDoc?.createdAt ? oldDoc.createdAt : now;
          const newDoc = { ...baseDoc, updatedAt: now, createdAt };
          const oldHash = existed ? (oldDoc.contentHash || hashDoc(oldDoc)) : null;
          const newHash = hashDoc(newDoc);
          const diff = existed ? diffDocs(oldDoc, newDoc) : diffDocs({}, newDoc);
          const changedKeys = Object.keys(diff);

          if (existed && changedKeys.length === 0) { unchanged++; continue; }

          newDoc.contentHash = newHash;
          if (!existed) batch.set(ref, { ...newDoc, enrichmentStatus: 'pending' });
          else batch.set(ref, newDoc, { merge: true });
          ops++;

          const histRef = ref.collection('historial').doc(`${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
          batch.set(histRef, {
            ts: now,
            source: 'wubookSyncToday',
            context: { scope: 'today', propiedad_id: prop.id },
            changeType: existed ? 'updated' : 'created',
            changedKeys,
            diff,
            hashFrom: oldHash,
            hashTo: newHash,
            snapshotAfter: newDoc,
            payload: {
              wubook_price_set: Boolean(wubook_price),
              toPay_set_auto: Boolean(baseDoc?.toPay)
            }
          });
          ops++;
          upserts++;
          await flushIfNeeded();
        }
      }

      if (ops > 0) await flush();

      summary.push({
        propiedad: { id: prop.id, nombre: prop.nombre },
        found_today: reservas.length,
        upserts, skipped, unchanged,
        dryRun: false
      });
    }

    log('DONE');
    return ok(res, { ok: true, summary });
  } catch (err) {
    log('ERROR', err?.message); console.error(err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}





