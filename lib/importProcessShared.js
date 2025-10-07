/**
 * lib/importProcessShared.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTENIDO
 *   Funciones compartidas por los importadores/sincronizadores:
 *   - Constantes/TZ/URLs
 *   - Helpers de parsing (EU→ISO), currency/round, estado/canceladas
 *   - Hash/diff con `contentHash` (sha1) e ignorando campos volátiles
 *   - Cálculo de totales/toPay (`recomputeToPayFrom`)
 *   - Extracción de `roomsCount` y `extrasUSD` (total y por room) desde el JSON crudo
 *   - Upsert genérico de reservas (`upsertReservations`) con historial/batching
 *   - Fetchers específicos: `fetchByArrivalRange`, `fetchToday`
 *
 * API EXPORTADA
 *   - TZ, BASE_URL, round2, cur, euToISO, isNonNull
 *   - normalizeStatus, isCancelledReservation
 *   - stableStringify, stripKeys, hashDoc, diffDocs
 *   - recomputeToPayFrom(breakdown, extrasUSDFinal)
 *   - roomsCountFromRaw(r), extrasUSDTotalFromRaw(r)
 *   - upsertReservations({ reservas, prop, dryRun?, sourceTag?, log? })
 *   - fetchByArrivalRange({ apiKey, fromDate, toDate, log? })
 *   - fetchToday({ apiKey })
 *
 * DECISIONES CLAVE
 *   - **Prorrateo de extras en el import/sync**:
 *       roomsCountRaw = r.rooms.length || 1
 *       extrasUSDTotalRaw = r.price.extras.amount (si currency === 'USD')
 *       extrasUSDPerRoomRaw = extrasUSDTotalRaw / roomsCountRaw
 *     Se escribe:
 *       • toPay_breakdown.extrasUSD (si NO estaba)
 *       • extrasUSD (top-level, si NO estaba)
 *       • wubook_extrasUSD_total / _perRoom / wubook_rooms_count (meta cruda)
 *     ⇒ El “enrich” NO debe recalcular distribución si estos campos existen.
 *
 *   - **Preservación de campos editados por host**:
 *       Si baseUSD/iva/extrasUSD/fxRate ya existen en toPay_breakdown, se respetan.
 *       Si extrasUSD top-level ya existe, NO se pisa.
 *
 *   - **Doc por HABITACIÓN**:
 *       ID: `${prop.id}_${id_human}_${id_zak}` para mantener unicidad y facilitar auditoría.
 *
 *   - **Idempotencia**:
 *       `contentHash` se calcula sobre el doc sin campos volátiles (createdAt/updatedAt/etc.)
 *       Si el hash coincide, no se escribe ni se agrega historial.
 *
 * CAMPOS QUE ESCRIBE upsertReservations()
 *   - id_human, rsrvid, propiedad_id/nombre
 *   - id_zak, codigo_depto, depto_nombre
 *   - arrival/arrival_iso, departure/departure_iso
 *   - adults/children, status (normalizado), is_cancelled: false
 *   - wubook_price { amount, vat, total, currency } (por room)
 *   - currency: 'USD' si corresponde
 *   - toPay (si no estaba), toPay_breakdown {...}
 *   - extrasUSD (si no estaba) = extrasUSDPerRoomRaw
 *   - wubook_rooms_count, wubook_extrasUSD_total, wubook_extrasUSD_perRoom
 *   - createdAt, updatedAt, contentHash
 *   - Historial: subcolección `historial` con diff, keys cambiadas y snapshotAfter
 *
 * ERRORES Y LOGGING
 *   - Los fetchers propagan errores de red con mensaje de KP.
 *   - upsertReservations devuelve métricas (upserts/skipped/unchanged/…).
 *   - Se recomienda pasar `log` del endpoint para contextualizar mensajes.
 *
 * NOTAS DE IMPLEMENTACIÓN
 *   - `getPropertiesAndRoomMaps()` debe aportar:
 *       prop.id, prop.nombre, prop.apiKey (KP), prop.roomMap (idZak → { codigo_depto, nombre_depto })
 *   - Límite de batch Firestore: usa flush automático al acercarse a ~450 ops.
 *   - TZ fija: 'America/Argentina/Buenos_Aires' para EU→ISO (Luxon).
 */
// lib/importProcessShared.js
import crypto from 'crypto';
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';
import qs from 'qs';
import axios from 'axios';

export const TZ = 'America/Argentina/Buenos_Aires';
export const BASE_URL = process.env.WUBOOK_BASE_URL || 'https://kapi.wubook.net/kp';

export const round2 = (n) => Number.isFinite(Number(n)) ? +Number(n).toFixed(2) : 0;
export const cur = (c) => String(c || '').trim().toUpperCase();
export const parseEU = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TZ });
export const euToISO = (s) => (s ? parseEU(s).toISODate() : null);
export const isNonNull = (v) => v !== undefined && v !== null;

// ---- Estado / canceladas
export const normalizeStatus = (s) => String(s || 'unknown').toLowerCase().replace(/\s+/g, '_');
export const isCancelledReservation = (r) => {
  const s = normalizeStatus(r?.status || r?.state || r?.reservation_status);
  if (s.includes('cancel')) return true;
  if (r?.is_cancelled === true || r?.cancelled === true) return true;
  if (normalizeStatus(r?.cancellation?.status).includes('cancel')) return true;
  return false;
};

// ---- Hash / diff
const IGNORE_KEYS = new Set(['updatedAt','createdAt','contentHash','enrichmentStatus','enrichedAt']);
const sortObject = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObject(obj[k]); return acc; }, {});
  }
  return obj;
};
export const stableStringify = (obj) => JSON.stringify(sortObject(obj));
export const stripKeys = (obj, ignore = IGNORE_KEYS) => {
  const out = {};
  for (const k of Object.keys(obj || {})) if (!ignore.has(k)) out[k] = obj[k];
  return out;
};
export const hashDoc = (doc) => crypto.createHash('sha1').update(stableStringify(stripKeys(doc))).digest('hex');
export const diffDocs = (oldDoc = {}, newDoc = {}) => {
  const diff = {};
  const keys = new Set([...Object.keys(oldDoc || {}), ...Object.keys(newDoc || {})]);
  for (const k of keys) {
    if (IGNORE_KEYS.has(k)) continue;
    const a = oldDoc?.[k], b = newDoc?.[k];
    if (stableStringify(a) !== stableStringify(b)) diff[k] = { from: a ?? null, to: b ?? null };
  }
  return diff;
};

// ---- Totales y breakdown
export function recomputeToPayFrom(breakdown, extrasUSDFinal) {
  const numOrZero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const b = numOrZero(breakdown?.baseUSD);
  const ivaPct = numOrNull(breakdown?.ivaPercent);
  let ivaUSD = numOrNull(breakdown?.ivaUSD);
  if (ivaUSD === null && ivaPct !== null && b > 0) ivaUSD = Number((b * ivaPct / 100).toFixed(2));
  const e = numOrZero(isNonNull(extrasUSDFinal) ? extrasUSDFinal : breakdown?.extrasUSD);
  return { total: Number((b + (ivaUSD || 0) + e).toFixed(2)) };
}

// ---- Extras/rooms desde el JSON original (reserva completa)
export const roomsCountFromRaw = (r) => Array.isArray(r?.rooms) ? r.rooms.length : 0;
export const extrasUSDTotalFromRaw = (r) => {
  const ex = r?.price?.extras;
  if (!ex) return null;
  const ccy = cur(ex.currency || r?.price?.currency);
  if (ccy !== 'USD') return null;
  const amt = Number(ex.amount);
  return Number.isFinite(amt) && amt > 0 ? round2(amt) : null;
};

// ---- Upsert genérico de reservas a Firestore (lista de reservas ya traídas de WuBook)
export async function upsertReservations({ reservas, prop, dryRun = false, sourceTag = 'wubookImport', log = console.log }) {
  if (!reservas || reservas.length === 0) return { upserts: 0, skipped: 0, skipped_cancelled: 0, unchanged: 0 };

  // filtrar canceladas
  const totalRaw = reservas.length;
  reservas = reservas.filter(r => !isCancelledReservation(r));
  const skipped_cancelled = totalRaw - reservas.length;

  let batch = firestore.batch();
  const MAX_OPS = 450;
  let ops = 0;
  const flush = async () => { if (ops > 0) { await batch.commit(); batch = firestore.batch(); ops = 0; } };
  const flushIfNeeded = async () => { if (ops >= MAX_OPS) await flush(); };

  const now = FieldValue.serverTimestamp();
  let upserts = 0, skipped = 0, unchanged = 0;

  for (const r of reservas) {
    const fullName = `${r?.customer?.name || ''} ${r?.customer?.surname || ''}`.trim() || String(r?.booker) || 'N/D';
    const sourceChannel = r?.origin?.channel && r.origin.channel !== '--' ? r.origin.channel : (r?.channel_name || 'Directo/WuBook');
    const rsrvid = r?.id ?? r?.rsrvid ?? r?.reservation_id ?? r?.rexid ?? r?.rid ?? null;

    // calcular una sola vez por reserva
    const roomsCountRaw = roomsCountFromRaw(r) || 1;
    const extrasUSDTotalRaw = extrasUSDTotalFromRaw(r); // null o número
    const extrasUSDPerRoomRaw = extrasUSDTotalRaw != null ? round2(extrasUSDTotalRaw / Math.max(1, roomsCountRaw)) : null;

    for (const room of r?.rooms || []) {
      const idZak = String(room?.id_zak_room || room?.id_zak_room_type || '');
      const mapData = prop.roomMap.get(idZak);
      if (!idZak || !mapData) { skipped++; continue; }

      const { codigo_depto, nombre_depto } = mapData;

      // ROOM-FIRST: priorizar SIEMPRE room.dfrom/dto; luego reserva
      const arrivalEU   = room?.dfrom || room?.arrival || r?.dfrom || r?.arrival || null;
      const departureEU = room?.dto   || room?.departure || r?.dto   || r?.departure || null;

      if ((r?.dfrom || r?.arrival) && (room?.dfrom || room?.arrival)) {
        const rArr = r?.dfrom || r?.arrival;
        const rmArr = room?.dfrom || room?.arrival;
        if (rArr !== rmArr) {
          log('WARN arrival mismatch', { id_human: r.id_human, rArr, rmArr, source: sourceTag });
        }
      }

      if (!arrivalEU || !departureEU) { skipped++; continue; }

      const docId = `${prop.id}_${r.id_human}_${idZak}`;
      const ref = firestore.collection('Reservas').doc(docId);
      const snap = await ref.get();
      const existed = snap.exists;
      const oldDoc = existed ? snap.data() : {};
      const oldBD = oldDoc?.toPay_breakdown || {};

      // Precio por room (o “rooms” del bloque si faltara)
      const roomPrice = room?.price || r?.price?.rooms || null;
      const wubook_price = roomPrice ? {
        amount: round2(roomPrice.amount),
        vat: round2(roomPrice.vat),
        total: round2(roomPrice.total),
        currency: cur(roomPrice.currency || r?.price?.rooms?.currency || r?.price?.currency)
      } : null;

      const extrasUSDFromImport = extrasUSDPerRoomRaw;

      // Preservas de host
      const preservedBD = {
        baseUSD:    isNonNull(oldBD.baseUSD)    ? oldBD.baseUSD    : (wubook_price?.currency === 'USD' ? round2(wubook_price.amount) : null),
        ivaPercent: isNonNull(oldBD.ivaPercent) ? oldBD.ivaPercent : null,
        ivaUSD:     isNonNull(oldBD.ivaUSD)     ? oldBD.ivaUSD     : null,
        extrasUSD:  isNonNull(oldBD.extrasUSD)  ? oldBD.extrasUSD  : extrasUSDFromImport,
        fxRate:     isNonNull(oldBD.fxRate)     ? oldBD.fxRate     : null,
      };
      const preservedExtrasTop = isNonNull(oldDoc?.extrasUSD) ? oldDoc.extrasUSD : extrasUSDFromImport;

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

        // trazabilidad de ingestión y crudo
        ingest_source: sourceTag,
        arrival_raw: arrivalEU,
        departure_raw: departureEU,

        adults: room?.occupancy?.adults ?? r?.adults ?? null,
        children: room?.occupancy?.children ?? r?.children ?? 0,
        status: normalizeStatus(r?.status || 'unknown'),
        is_cancelled: false,
        ...(wubook_price ? { wubook_price } : {}),

        // Meta cruda para auditoría / enrich
        wubook_rooms_count: roomsCountRaw,
        wubook_extrasUSD_total: extrasUSDTotalRaw,
        wubook_extrasUSD_perRoom: extrasUSDPerRoomRaw
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

      if (!dryRun) {
        if (!existed) batch.set(ref, { ...newDoc, enrichmentStatus: 'pending' });
        else          batch.set(ref, newDoc, { merge: true });
        ops++;

        const histRef = ref.collection('historial').doc(`${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        batch.set(histRef, {
          ts: now,
          source: sourceTag,
          context: { propiedad_id: prop.id },
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
      } else {
        upserts++;
      }
    }
  }

  if (!dryRun && ops > 0) await flush();
  return { upserts, skipped, skipped_cancelled, unchanged };
}

// ---- Fetches específicos (para que cada endpoint sólo llame lo que necesita)
export async function fetchByArrivalRange({ apiKey, fromDate, toDate, log = console.log }) {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
  const limit = 64; let offset = 0; let hasMore = true; const all = []; let guard = 0;
  while (hasMore) {
    guard++; if (guard > 100) break;
    const payload = qs.stringify({ filters: JSON.stringify({ arrival: { from: fromDate, to: toDate }, pager: { limit, offset } }) });
    const resp = await axios.post(`${BASE_URL}/reservations/fetch_reservations`, payload, { headers });
    const items = resp?.data?.data?.reservations || [];
    all.push(...items);
    hasMore = items.length === limit; offset += limit;
  }
  return all;
}

export async function fetchToday({ apiKey }) {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
  const resp = await axios.post(`${BASE_URL}/reservations/fetch_today_reservations`, qs.stringify({}), { headers });
  return resp?.data?.data?.reservations || [];
}
