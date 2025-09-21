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

import axios from 'axios';
import qs from 'qs';
import crypto from 'crypto';
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

// ===================== CONFIGURACIÓN Y UTILIDADES =====================
const log = (...args) => console.log(`[SyncToday]`, ...args);
const TZ = 'America/Argentina/Buenos_Aires';
const BASE_URL = process.env.WUBOOK_BASE_URL || 'https://kapi.wubook.net/kp';
const parseEU = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TZ });
const euToISO = (s) => (s ? parseEU(s).toISODate() : null);

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

// ===================== Firestore: propiedades y mapeo de rooms =====================
async function getPropertiesAndRoomMaps(propertyIds) {
  const propsCol = firestore.collection('propiedades');
  let propDocs = [];
  if (Array.isArray(propertyIds) && propertyIds.length) {
    const snaps = await Promise.all(propertyIds.map((id) => propsCol.doc(id).get()));
    propDocs = snaps.filter((s) => s.exists);
  } else {
    const snap = await propsCol.get();
    propDocs = snap.docs;
  }
  const list = [];
  for (const d of propDocs) {
    const data = d.data();
    const apiKey = data?.api_key || data?.integraciones?.wubook_apiKey || data?.integraciones?.wubook?.apiKey;
    if (!apiKey) { continue; }
    const roomMap = new Map();
    const depsSnap = await d.ref.collection('departamentos').get();
    for (const dep of depsSnap.docs) {
      const v = dep.data(); const idZak = dep.id;
      const codigo_depto = v?.codigo_depto || v?.wubook_shortname || dep.id;
      const nombre_depto = v?.nombre || v?.name || '';
      roomMap.set(idZak, { codigo_depto, nombre_depto });
    }
    log('Mapeo de Departamentos para', { propId: d.id, count: roomMap.size });
    list.push({ id: d.id, nombre: data?.nombre || d.id, apiKey, roomMap });
  }
  return list;
}

// ===================== HANDLER PRINCIPAL =====================
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 405, 'Método no permitido');

  try {
    const { propertyIds, dryRun = false } = (req.body && req.method === 'POST') ? req.body : {};
    log('INIT', { propertyIds, dryRun });

    const propiedades = await getPropertiesAndRoomMaps(propertyIds);
    if (!propiedades.length) { return bad(res, 400, 'No se encontraron propiedades con api_key de WuBook.'); }

    const summary = [];

    for (const prop of propiedades) {
      log('PROP START', { id: prop.id, nombre: prop.nombre, roomsMapped: prop.roomMap.size });

      // --- WuBook fetch_today_reservations ---
      let reservas = [];
      try {
        const payload = qs.stringify({});
        const headers = { 'x-api-key': prop.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
        log(`WuBook POST ${BASE_URL}/reservations/fetch_today_reservations`);
        const resp = await axios.post(`${BASE_URL}/reservations/fetch_today_reservations`, payload, { headers });
        reservas = resp?.data?.data?.reservations || [];
      } catch (error) {
        log('WuBook API Error en fetch_today_reservations:', error.response ? error.response.data : error.message);
      }

      // Filtramos canceladas desde ya
      const totalRaw = reservas.length;
      reservas = reservas.filter(r => !isCancelledReservation(r));
      log('Reservas encontradas (filtradas canceladas)', { propId: prop.id, total: reservas.length, skipped_cancelled: totalRaw - reservas.length });

      // DRY RUN: no escribe, solo informa
      if (dryRun) {
        const sample_ids = reservas.slice(0, 5).map(r => r.id_human);
        summary.push({ propiedad: { id: prop.id, nombre: prop.nombre }, found_today: reservas.length, skipped_cancelled: totalRaw - reservas.length, dryRun: true, sample_ids });
        log('DRY RUN: Finalizando después de la consulta.', summary[summary.length - 1]);
        continue;
      }

      // --- Batch con flushing seguro ---
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
          log('BATCH FLUSH (por límite de operaciones)', { propId: prop.id, ops });
          await flush();
        }
      };

      // Usamos serverTimestamp() para consistencia global
      const now = FieldValue.serverTimestamp();
      let upserts = 0; let skipped = 0; let unchanged = 0; let skipped_cancelled = 0;

      for (const r of reservas) {
        if (isCancelledReservation(r)) { skipped_cancelled++; continue; }

        const fullName = `${r?.customer?.name || ''} ${r?.customer?.surname || ''}`.trim() || String(r?.booker) || 'N/D';
        let sourceChannel = r?.origin?.channel && r.origin.channel !== '--' ? r.origin.channel : (r?.channel_name || 'Directo/WuBook');

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

          // Doc base (sin timestamps para hash)
          const baseDoc = {
            id_human: r.id_human,
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
            is_cancelled: false, // pasó filtro
          };

          // Leer existente y comparar
          const snap = await ref.get();
          const existed = snap.exists;
          const oldDoc = existed ? snap.data() : {};
          const createdAt = existed && oldDoc?.createdAt ? oldDoc.createdAt : now;

          const newDoc = { ...baseDoc, updatedAt: now, createdAt };
          const oldHash = existed ? (oldDoc.contentHash || hashDoc(oldDoc)) : null;
          const newHash = hashDoc(newDoc);
          const diff = existed ? diffDocs(oldDoc, newDoc) : diffDocs({}, newDoc);
          const changedKeys = Object.keys(diff);

          if (existed && changedKeys.length === 0) {
            unchanged++;
            continue;
          }

          newDoc.contentHash = newHash;

          // --- Lógica de Escritura Inteligente ---
          if (!existed) {
            // NUEVO: set completo y marcar enrichmentStatus = 'pending' SOLO al crear
            const docToCreate = {
              ...newDoc,
              enrichmentStatus: 'pending',
            };
            batch.set(ref, docToCreate);
          } else {
            // UPDATE: merge sin tocar enrichmentStatus
            batch.set(ref, newDoc, { merge: true });
          }
          ops++;

          // Historial con diff (agregamos propiedad_id en context)
          const histId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const histRef = ref.collection('historial').doc(histId);
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
          }); ops++;

          upserts++;
          await flushIfNeeded();
        }
      }

      if (ops > 0) {
        log('BATCH COMMIT', { propId: prop.id, upserts, skipped, skipped_cancelled, unchanged });
        await flush();
      } else {
        log('Sin cambios para commitear', { propId: prop.id, upserts, skipped, skipped_cancelled, unchanged });
      }

      summary.push({
        propiedad: { id: prop.id, nombre: prop.nombre },
        found_today: reservas.length,
        upserts, skipped, skipped_cancelled, unchanged,
        dryRun: false
      });
      log('PROP DONE', summary[summary.length - 1]);
    }

    log('DONE');
    return ok(res, { ok: true, summary });
  } catch (err) {
    log('ERROR', err?.message); console.error(err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}



