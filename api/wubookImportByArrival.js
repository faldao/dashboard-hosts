  // /api/wubookImportByArrival.js
  // OBJETIVO: Importar reservas por fecha de llegada (arrival) y guardar historial de cambios.
  // COMPORTAMIENTO INTELIGENTE:
  // 1. Si se provee 'fromDate', usa ese rango (históricas).
  // 2. Si NO se provee 'fromDate', calcula automáticamente 'mañana' y 'pasado mañana' (futuras).
  //
  // ✅ Alineado de FECHAS/TZ:
  // - Conversión EU → ISO con Luxon usando 'America/Argentina/Buenos_Aires'.
  // - Al guardar, usamos Firestore `serverTimestamp()` para created/updated/historial.
  // - NO se pisa `enrichmentStatus` en updates (solo se setea 'pending' al crear).
  // - Se agrega `propiedad_id` al contexto del historial.
  // - ⚠️ Se EXCLUYEN reservas canceladas (status/flags) antes de persistir.
  //
  // 🆕 PRECIO WUBOOK + toPay_breakdown:
  // - Se agrega `wubook_price` por room (amount pre-IVA, vat, total, currency).
  // - Si currency === 'USD' -> se completa `toPay` y `toPay_breakdown`:
  //     baseUSD = amount, ivaUSD = vat, extrasUSD = null, fxRate = null, currency='USD'.
  // - Si currency !== 'USD' -> NO se toca toPay/toPay_breakdown (quedan para conversión posterior).

  import axios from 'axios';
  import qs from 'qs';
  import crypto from 'crypto';
  import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
  import { DateTime } from 'luxon';

  // ===================== CONFIGURACIÓN Y UTILIDADES =====================
  const log = (...args) => console.log(`[ImportByArrival]`, ...args);
  const TZ = 'America/Argentina/Buenos_Aires';
  const BASE_URL = process.env.WUBOOK_BASE_URL || 'https://kapi.wubook.net/kp';
  const parseEU = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TZ });
  const euToISO = (s) => (s ? parseEU(s).toISODate() : null);
  const round2 = (n) => Number.isFinite(Number(n)) ? +Number(n).toFixed(2) : 0;
  const cur = (c) => String(c || '').trim().toUpperCase();

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

  // ===================== WuBook: fetch con paginación =====================
  async function fetchReservationsByFilter({ apiKey, filters }) {
    const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
    const limit = 64; let offset = 0; let hasMore = true; const allReservations = []; let guard = 0;
    log('Iniciando fetch paginado con filtros:', filters);
    while (hasMore) {
      guard++; if (guard > 100) { log('WARN: Failsafe guard triggered.'); break; }
      const payload = qs.stringify({ filters: JSON.stringify({ ...filters, pager: { limit, offset } }) });
      log(`WuBook POST /reservations/fetch_reservations | Página: ${guard}, Offset: ${offset}`);
      try {
        const resp = await axios.post(`${BASE_URL}/reservations/fetch_reservations`, payload, { headers });
        const items = resp?.data?.data?.reservations || [];
        allReservations.push(...items);
        hasMore = items.length === limit;
        offset += limit;
      } catch (error) {
        log('WuBook API Error:', error.response ? error.response.data : error.message);
        hasMore = false;
      }
    }
    const before = allReservations.length;
    const filtered = allReservations.filter(r => !isCancelledReservation(r));
    log(`Fetch finalizado. Total: ${before}, canceladas filtradas: ${before - filtered.length}`);
    return filtered;
  }

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
      if (!apiKey) continue;
      const roomMap = new Map();
      const depsSnap = await d.ref.collection('departamentos').get();
      depsSnap.forEach(dep => {
        const v = dep.data(); const idZak = dep.id;
        const codigo_depto = v?.codigo_depto || v?.wubook_shortname || dep.id;
        const nombre_depto = v?.nombre || v?.name || '';
        roomMap.set(idZak, { codigo_depto, nombre_depto });
      });
      log('Mapeo de Departamentos para', { propId: d.id, count: roomMap.size });
      list.push({ id: d.id, nombre: data?.nombre || d.id, apiKey, roomMap });
    }
    return list;
  }

  // ===================== Guardar lote con DIFF + historial =====================
  async function processAndSaveReservations(reservas, prop, dryRun, meta = { source: 'wubookImportByArrival', context: {} }) {
    if (!reservas || reservas.length === 0) return { upserts: 0, skipped: 0, skipped_cancelled: 0, unchanged: 0 };

    log(`Procesando ${reservas.length} reservas para la propiedad ${prop.id}`);

    let batch = firestore.batch();
    const MAX_OPS = 450; // margen bajo 500
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
    let upserts = 0, skipped = 0, skipped_cancelled = 0, unchanged = 0;

    for (const r of reservas) {
      if (isCancelledReservation(r)) { skipped_cancelled++; continue; }

      const fullName = `${r?.customer?.name || ''} ${r?.customer?.surname || ''}`.trim() || String(r?.booker) || 'N/D';
      let sourceChannel = r?.origin?.channel && r.origin.channel !== '--' ? r.origin.channel : (r?.channel_name || 'Directo/WuBook');
        const rsrvid =  r?.id ?? r?.rsrvid ?? r?.reservation_id ?? r?.rexid ?? r?.rid ?? null;

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

        // --- PRECIO WUBOOK (por room) ---
        const roomPrice = room?.price || r?.price?.rooms || null;
        const wubook_price = roomPrice ? {
          amount: round2(roomPrice.amount),
          vat: round2(roomPrice.vat),
          total: round2(roomPrice.total),
          currency: cur(roomPrice.currency || r?.price?.rooms?.currency || r?.price?.currency)
        } : null;

        // Construir doc nuevo (sin timestamps para el hash)
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

        // Si el precio viene en USD, seteamos toPay y breakdown como en mutation.setToPay
        if (wubook_price && wubook_price.currency === 'USD') {
          const baseUSD   = round2(wubook_price.amount);
          const ivaUSD    = null;
          const extrasUSD = null; // no viene de WuBook a nivel room; si más adelante querés sumar, lo hacemos
          const toPayUSD  = round2(baseUSD + ivaUSD);

          baseDoc.currency = 'USD';
          baseDoc.toPay = toPayUSD;
          baseDoc.extrasUSD = null; // campo “único” de front
          baseDoc.toPay_breakdown = {
            baseUSD,
            ivaPercent: null,
            ivaUSD,
            extrasUSD,
            fxRate: null
          };
        }

        // Leer existente para comparar
        const snap = await ref.get();
        const existed = snap.exists;
        const oldDoc = existed ? snap.data() : {};
        const createdAt = existed && oldDoc?.createdAt ? oldDoc.createdAt : now;

        const newDoc = { ...baseDoc, updatedAt: now, createdAt };
        const oldHash = existed ? (oldDoc.contentHash || hashDoc(oldDoc)) : null;
        const newHash = hashDoc(newDoc);
        const diff = existed ? diffDocs(oldDoc, newDoc) : diffDocs({}, newDoc);
        const changedKeys = Object.keys(diff);

        // Si no cambió nada, no escribimos
        if (existed && changedKeys.length === 0) {
          unchanged++;
          continue;
        }

        // Hash para futuras comparaciones
        newDoc.contentHash = newHash;

        if (!dryRun) {
          if (!existed) {
            // NUEVO: marcar pending una sola vez
            const docToCreate = { ...newDoc, enrichmentStatus: 'pending' };
            batch.set(ref, docToCreate); ops++;
          } else {
            // UPDATE: no tocar enrichmentStatus
            batch.set(ref, newDoc, { merge: true }); ops++;
          }

          // Historial con diff (agregar propiedad_id al contexto)
          const histId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const histRef = ref.collection('historial').doc(histId);
          const histDoc = {
            ts: now,
            source: meta?.source || 'wubookImportByArrival',
            context: { ...(meta?.context || {}), propiedad_id: prop.id },
            changeType: existed ? 'updated' : 'created',
            changedKeys,
            diff,
            hashFrom: oldHash,
            hashTo: newHash,
            snapshotAfter: newDoc,
            // Pequeña pista de qué campos financieros se setearon
            payload: {
              wubook_price_set: Boolean(wubook_price),
              toPay_set_auto: Boolean(baseDoc?.toPay),
            }
          };
          batch.set(histRef, histDoc); ops++;

          upserts++;
          await flushIfNeeded();
        } else {
          upserts++; // cuenta como procesado, pero no escribe
        }
      }
    }

    if (!dryRun && ops > 0) {
      log('BATCH COMMIT', { propId: prop.id, upserts, skipped, skipped_cancelled, unchanged });
      await flush();
    } else {
      log('DRY RUN o sin cambios', { propId: prop.id, upserts, skipped, skipped_cancelled, unchanged, dryRun });
    }

    return { upserts, skipped, skipped_cancelled, unchanged };
  }

  // ===================== HANDLER PRINCIPAL =====================
  export default async function handler(req, res) {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 405, 'Método no permitido');

    try {
      const { propertyIds, dryRun = false } = (req.body && req.method === 'POST') ? req.body : {};
      let { fromDate, toDate } = (req.body && req.method === 'POST') ? req.body : {};
      let mode = 'manual';

      // Lógica inteligente de rango (calculada en TZ AR para evitar desfases)
      if (!fromDate) {
        mode = 'auto_future_sync';
        const now = DateTime.now().setZone(TZ);
        fromDate = now.plus({ days: 1 }).toFormat('dd/LL/yyyy'); // Mañana
        toDate = now.plus({ days: 2 }).toFormat('dd/LL/yyyy');   // Pasado mañana
        log(`Modo automático: usando rango ${fromDate} - ${toDate}`);
      } else if (!toDate) {
        toDate = '31/12/2099'; // histórico abierto
      }

      log('INIT', { mode, fromDate, toDate, propertyIds, dryRun });

      const propiedades = await getPropertiesAndRoomMaps(propertyIds);
      if (!propiedades.length) return bad(res, 400, 'No se encontraron propiedades con api_key válidas.');

      const summary = [];

      for (const prop of propiedades) {
        log('PROP START', { id: prop.id, nombre: prop.nombre });
        const reservas = await fetchReservationsByFilter({
          apiKey: prop.apiKey,
          filters: { arrival: { from: fromDate, to: toDate } }
        });

        const result = await processAndSaveReservations(
          reservas,
          prop,
          dryRun,
          {
            source: 'wubookImportByArrival',
            context: { mode, range: { from: fromDate, to: toDate } }
          }
        );

        summary.push({
          propiedad: { id: prop.id, nombre: prop.nombre },
          mode,
          range: { from: fromDate, to: toDate },
          total_found: reservas.length,
          ...result,
          dryRun
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



