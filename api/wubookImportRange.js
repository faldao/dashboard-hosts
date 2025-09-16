// api/wubookImportRange.js (Vercel)
// Recupera reservas desde WuBook (rango dd/mm/yyyy) y las guarda en Firestore
// usando la librería compartida /lib/firebaseAdmin.js
// Escribe en: /Hosting/Reservas/items/{propiedadId}_{id_human}_{id_zak_room}
// Incluye: nombre del departamento y fechas en dd/mm/yyyy + YYYY-MM-DD
// Usa estructura real: /propiedades/{propId}/departamentos/{idZak}
//   - En propiedad: api_key (WuBook)
//   - En departamento: nombre (nombre del dpto), opcional codigo_depto / wubook_shortname

import axios from 'axios';
import qs from 'qs';
import { firestore, Timestamp } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

// ===================== LOG =====================
const log = (...args) => console.log(`[NOMBRE SUB PROCESO]`, ...args);
// ===============================================

// ===================== CONFIG =====================
const TZ = 'America/Argentina/Buenos_Aires';
const BASE_URL = process.env.WUBOOK_BASE_URL || 'https://kapi.wubook.net/kp';
// const OLD_BASE_URL = process.env.WUBOOK_OLD_BASE_URL || 'https://kapi.wubook.net/kapi';
// (OLD_BASE_URL se usará si más adelante traemos pagos/notas históricas)
// ==================================================

// ---- Utilidades de fecha ----
const parseEU = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TZ });
const fmtEU = (dt) => dt.setZone(TZ).toFormat('dd/LL/yyyy');
const euToISO = (s) => parseEU(s).toFormat('yyyy-LL-dd');

// ---- Respuestas HTTP ----
function ok(res, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(200).json(data);
}
function bad(res, code, error) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(code).json({ error });
}

// ---- WuBook: fetch con paginación (64) ----
async function fetchReservationsByFilter({ apiKey, filters }) {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
  const limit = 64;
  let offset = 0;
  let hasMore = true;
  const all = [];
  let guard = 0;

  while (hasMore) {
    guard++; if (guard > 500) break; // failsafe
    const payload = qs.stringify({ filters: JSON.stringify({ ...filters, pager: { limit, offset } }) });
    log('WuBook POST /reservations/fetch_reservations', { offset, limit, filters });
    const resp = await axios.post(`${BASE_URL}/reservations/fetch_reservations`, payload, { headers });
    const items = resp?.data?.data?.reservations || [];
    log('WuBook RESP count', items.length);
    all.push(...items);
    hasMore = items.length === limit;
    offset += limit;
  }
  log('WuBook TOTAL items acumulados', all.length);
  return all;
}

// ---- Firestore: leer propiedades y mapeo de rooms ----
// Estructura real (según captura):
// /propiedades/{propId}  -> { api_key, ... }
// /propiedades/{propId}/departamentos/{idZak} -> { nombre, codigo_depto?, wubook_shortname? }
async function getPropertiesAndRoomMaps(propertyIds) {
  const propsCol = firestore.collection('propiedades'); // <-- minúsculas
  let propDocs = [];
  if (Array.isArray(propertyIds) && propertyIds.length) {
    const snaps = await Promise.all(propertyIds.map((id) => propsCol.doc(id).get()));
    propDocs = snaps.filter((s) => s.exists);
  } else {
    const snap = await propsCol.get();
    propDocs = snap.docs;
  }

  log('Propiedades encontradas', propDocs.length);

  const list = [];
  for (const d of propDocs) {
    const data = d.data();
    const apiKey = data?.api_key || data?.integraciones?.wubook_apiKey || data?.integraciones?.wubook?.apiKey;
    if (!apiKey) { log('Propiedad sin api_key, se omite', d.id); continue; }

    // Construir mapa id_zak_room -> { codigo_depto, nombre_depto }
    const roomMap = new Map();
    const depsSnap = await propsCol.doc(d.id).collection('departamentos').get();
    log('Departamentos leídos', { propId: d.id, count: depsSnap.size });
    for (const dep of depsSnap.docs) {
      const v = dep.data();
      const idZak = String(v?.id_zak_room ?? dep.id);
      const codigo_depto = v?.codigo_depto || v?.wubook_shortname || dep.id;
      const nombre_depto = v?.nombre || v?.name || '';
      roomMap.set(idZak, { codigo_depto, nombre_depto });
    }

    list.push({ id: d.id, nombre: data?.nombre || d.id, apiKey, roomMap });
  }
  log('Propiedades con api_key listas', list.map(p => p.id));
  return list;
}

// ---- Handler principal ----
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

  try {
    const { fromDate, toDate, propertyIds, dryRun = false } = req.body || {};
    log('INIT', { fromDate, toDate, propertyIds, dryRun });

    // Validación de entradas
    if (!fromDate || !toDate) { log('VALIDATION ERROR', 'faltan fechas'); return bad(res, 400, 'fromDate y toDate son requeridos (dd/mm/yyyy)'); }
    const fromDT = parseEU(fromDate);
    const toDT = parseEU(toDate);
    if (!fromDT.isValid || !toDT.isValid) { log('VALIDATION ERROR', 'formato inválido'); return bad(res, 400, 'Formato de fecha inválido (usar dd/mm/yyyy)'); }

    const propiedades = await getPropertiesAndRoomMaps(propertyIds);
    if (!propiedades.length) { log('NO PROPERTIES WITH API KEY'); return bad(res, 400, 'No hay propiedades con api_key de WuBook'); }

    // Rangear día por día (WuBook requiere días exactos en dd/mm/yyyy)
    const days = [];
    for (let d = fromDT; d <= toDT; d = d.plus({ days: 1 })) days.push(d);
    log('DÍAS A PROCESAR', days.map(d => fmtEU(d)));

    const summary = [];

    for (const prop of propiedades) {
      log('PROP START', { id: prop.id, nombre: prop.nombre });
      const arrivalsAll = [];
      const departuresAll = [];

      for (const day of days) {
        const dayEU = fmtEU(day); // dd/mm/yyyy
        log('FETCH DAY', { propId: prop.id, day: dayEU });
        const arr = await fetchReservationsByFilter({ apiKey: prop.apiKey, filters: { arrival: { from: dayEU, to: dayEU } } });
        const dep = await fetchReservationsByFilter({ apiKey: prop.apiKey, filters: { departure: { from: dayEU, to: dayEU } } });
        log('FETCH OK', { day: dayEU, arr: arr.length, dep: dep.length });
        arrivalsAll.push(...arr);
        departuresAll.push(...dep);
      }

      // Unificar por id_human (la reserva puede aparecer en ambos filtros)
      const byId = new Map();
      for (const r of [...arrivalsAll, ...departuresAll]) byId.set(r.id_human, r);
      const reservas = Array.from(byId.values());
      log('MERGE RESERVAS', { propId: prop.id, total: reservas.length });

      // Lote de escritura
      const batch = firestore.batch();
      const now = Timestamp.now();
      let upserts = 0;

      for (const r of reservas) {
        const fullName = `${r?.customer?.name || ''} ${r?.customer?.surname || ''}`.trim() || r?.booker || 'N/D';
        const arrivalEU = r?.arrival || null;      // dd/mm/yyyy
        const departureEU = r?.departure || null;  // dd/mm/yyyy
        const arrivalISO = arrivalEU ? euToISO(arrivalEU) : null;
        const departureISO = departureEU ? euToISO(departureEU) : null;

        for (const room of r?.rooms || []) {
          const idZak = String(room?.id_zak_room || '');
          const mapData = prop.roomMap.get(idZak) || { codigo_depto: idZak, nombre_depto: '' };
          const { codigo_depto, nombre_depto } = mapData;

          const docId = `${prop.id}_${r.id_human}_${idZak}`;
          const ref = firestore.collection('Hosting').doc('Reservas').collection('items').doc(docId);

          const doc = {
            id_human: r.id_human,
            id_zak_room: room?.id_zak_room || null,
            propiedad_id: prop.id,
            propiedad_nombre: prop.nombre,
            codigo_depto,
            depto_nombre: nombre_depto || null,
            arrival: arrivalEU,
            arrival_iso: arrivalISO,
            departure: departureEU,
            departure_iso: departureISO,
            nombre_huesped: fullName,
            adults: r?.adults ?? room?.adults ?? null,
            children: r?.children ?? room?.children ?? null,
            source: r?.channel_name || r?.origin || 'WuBook',
            updatedAt: now,
            createdAt: now,
          };

          batch.set(ref, doc, { merge: true });
          upserts++;
          if (upserts % 100 === 0) log('UPSERT PROGRESO', { propId: prop.id, upserts });
        }
      }

      if (!dryRun && upserts > 0) {
        log('BATCH COMMIT', { propId: prop.id, upserts });
        await batch.commit();
      } else {
        log('DRY RUN o sin cambios', { propId: prop.id, upserts, dryRun });
      }

      summary.push({ propiedad: { id: prop.id, nombre: prop.nombre }, arrivals: arrivalsAll.length, departures: departuresAll.length, upserts, dryRun });
      log('PROP DONE', summary[summary.length - 1]);
    }

    log('DONE', { fromDate, toDate, processed: propiedades.length });
    return ok(res, { ok: true, fromDate, toDate, processed: propiedades.length, summary });
  } catch (err) {
    log('ERROR', err?.message);
    console.error(err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}
