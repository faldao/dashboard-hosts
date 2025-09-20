// /api/dailyIndex.js
// Construye/lee el índice DIARIO sin duplicar reservas y, además,
// genera las ramas por PROPIEDAD y por DEPARTAMENTO (dentro de la propiedad).
//
// Estructura creada:
//
// DailyIndex/{YYYY-MM-DD} => {
//   tz, generated_at, counts, checkins[], stays[], checkouts[]
// }
//
// DailyIndex/{YYYY-MM-DD}/props/{propId} => {
//   propiedad_nombre, counts, checkins[], stays[], checkouts[]
// }
//
// DailyIndex/{YYYY-MM-DD}/props/{propId}/depts/{codigo_depto} => {
//   depto_nombre, counts, checkins[], stays[], checkouts[]
// }
//
// Parámetros:
//   ?date=YYYY-MM-DD   (opcional; default: hoy AR)
//   ?rebuild=1         (opcional; fuerza reconstrucción aunque exista)
//
// Notas:
// - Requiere un índice compuesto en Firestore para "stays":
//   Colección: Reservas
//   Campos: arrival_iso Asc, departure_iso Asc
//
// - No duplica información de Reservas: solo guarda arrays de IDs.
//
// - El handler siempre responde con el documento GLOBAL del día, para tu front.
//

import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';

const ok = (res, data) => res.status(200).json(data);
const bad = (res, code, error) => res.status(code).json({ error });

// Helpers utilitarios
const toISODateAR = (dateLike) =>
  (dateLike ? DateTime.fromISO(String(dateLike), { zone: TZ }) : DateTime.now().setZone(TZ)).toISODate();

/** Agrupa un array de docs de Reservas en mapas por prop y por depto */
function groupByPropAndDept(docsByBucket) {
  // docsByBucket: { checkins: [doc], stays: [doc], checkouts: [doc] }
  const byProp = {};      // { propId: { propiedad_nombre, checkins:[], stays:[], checkouts:[] } }
  const byPropDept = {};  // { propId: { [codigo_depto]: { depto_nombre, checkins:[], stays:[], checkouts:[] } } }

  const ensureProp = (propId, nombre) => {
    if (!byProp[propId]) byProp[propId] = {
      propiedad_nombre: nombre || null,
      checkins: [], stays: [], checkouts: []
    };
    if (!byPropDept[propId]) byPropDept[propId] = {};
  };
  const ensureDept = (propId, codigo_depto, nombre_depto) => {
    if (!byPropDept[propId][codigo_depto]) {
      byPropDept[propId][codigo_depto] = {
        depto_nombre: nombre_depto || codigo_depto || null,
        checkins: [], stays: [], checkouts: []
      };
    }
  };

  const buckets = ['checkins','stays','checkouts'];
  for (const b of buckets) {
    for (const d of docsByBucket[b]) {
      const id = d.id;
      const data = d.data();
      const propId = data?.propiedad_id || 'unknown';
      const propName = data?.propiedad_nombre || null;
      const codigo_depto = data?.codigo_depto || data?.id_zak || 'unknown';
      const depto_nombre = data?.depto_nombre || data?.nombre_depto || null;

      ensureProp(propId, propName);
      ensureDept(propId, codigo_depto, depto_nombre);

      byProp[propId][b].push(id);
      byPropDept[propId][codigo_depto][b].push(id);
    }
  }

  return { byProp, byPropDept };
}

export default async function handler(req, res) {
  try {
    const dateParam = (req.query.date || req.body?.date || '').trim();
    const rebuild = (req.query.rebuild || req.body?.rebuild || '') === '1';
    const dateISO = dateParam ? toISODateAR(dateParam) : DateTime.now().setZone(TZ).toISODate();

    const rootRef = firestore.collection('DailyIndex').doc(dateISO);

    if (!rebuild) {
      const existing = await rootRef.get();
      if (existing.exists) {
        // Ya existe: devolvemos el doc global tal cual.
        return ok(res, { ok: true, date: dateISO, ...existing.data(), fromCache: true });
      }
    }

    // --- Construcción del día (3 consultas) ---
    // 1) Llegan hoy
    const [checkInsSnap, checkOutsSnap, staysSnap] = await Promise.all([
      firestore.collection('Reservas').where('arrival_iso', '==', dateISO).get(),
      firestore.collection('Reservas').where('departure_iso', '==', dateISO).get(),
      firestore.collection('Reservas')
        .where('arrival_iso', '<=', dateISO)
        .where('departure_iso', '>', dateISO)
        .get(), // requiere índice compuesto
    ]);

    const checkinsIds = checkInsSnap.docs.map(d => d.id);
    const checkoutsIds = checkOutsSnap.docs.map(d => d.id);
    const staysIds = staysSnap.docs.map(d => d.id);

    // --- Payload GLOBAL ---
    const globalPayload = {
      tz: TZ,
      generated_at: FieldValue.serverTimestamp(),
      checkins: checkinsIds,
      stays: staysIds,
      checkouts: checkoutsIds,
      counts: {
        checkins: checkinsIds.length,
        stays: staysIds.length,
        checkouts: checkoutsIds.length
      }
    };

    // --- Agrupación por PROPIEDAD y DEPARTAMENTO ---
    const docsByBucket = {
      checkins: checkInsSnap.docs,
      stays: staysSnap.docs,
      checkouts: checkOutsSnap.docs
    };
    const { byProp, byPropDept } = groupByPropAndDept(docsByBucket);

    // --- Escrituras en batch ---
    let batch = firestore.batch();
    let ops = 0;
    const flush = async () => {
      if (ops > 0) { await batch.commit(); batch = firestore.batch(); ops = 0; }
    };
    const flushIfNeeded = async () => { if (ops >= 450) await flush(); };

    // 1) Global
    batch.set(rootRef, globalPayload, { merge: true }); ops++;

    // 2) Props
    for (const [propId, buckets] of Object.entries(byProp)) {
      const counts = {
        checkins: buckets.checkins.length,
        stays: buckets.stays.length,
        checkouts: buckets.checkouts.length,
      };
      const propPayload = {
        propiedad_nombre: buckets.propiedad_nombre || null,
        counts,
        checkins: buckets.checkins,
        stays: buckets.stays,
        checkouts: buckets.checkouts,
      };
      const propRef = rootRef.collection('props').doc(propId);
      batch.set(propRef, propPayload, { merge: true }); ops++;
      await flushIfNeeded();

      // 3) Depts de esa propiedad
      const depts = byPropDept[propId] || {};
      for (const [codigo_depto, b] of Object.entries(depts)) {
        const dCounts = {
          checkins: b.checkins.length,
          stays: b.stays.length,
          checkouts: b.checkouts.length,
        };
        const deptPayload = {
          depto_nombre: b.depto_nombre || codigo_depto,
          counts: dCounts,
          checkins: b.checkins,
          stays: b.stays,
          checkouts: b.checkouts,
        };
        const deptRef = propRef.collection('depts').doc(codigo_depto);
        batch.set(deptRef, deptPayload, { merge: true }); ops++;
        await flushIfNeeded();
      }
    }

    if (ops > 0) await flush();

    // Devolvemos el GLOBAL (lo que consume tu front)
    return ok(res, { ok: true, date: dateISO, ...globalPayload, fromCache: false });
  } catch (e) {
    console.error(e);
    return bad(res, 500, e.message || 'Error building daily index');
  }
}

