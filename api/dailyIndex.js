// /api/dailyIndex.js
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(code).json({ error });
};

const toISODateAR = (dateLike) =>
  (dateLike ? DateTime.fromISO(String(dateLike), { zone: TZ }) : DateTime.now().setZone(TZ)).toISODate();

const normalizeStatus = (s) => String(s || 'unknown').toLowerCase().replace(/\s+/g, '_');
function isCancelledDoc(data) {
  const s =
    normalizeStatus(data?.status) ||
    normalizeStatus(data?.state) ||
    normalizeStatus(data?.reservation_status);
  if (s.includes('cancel')) return true;
  if (data?.is_cancelled === true || data?.cancelled === true) return true;
  if (normalizeStatus(data?.cancellation?.status).includes('cancel')) return true;
  return false;
}

function groupByPropAndDept(docsByBucket) {
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
      const propId = String(data?.propiedad_id || 'unknown');
      const propName = data?.propiedad_nombre || null;
      const codigo_depto = data?.codigo_depto || data?.id_zak || 'unknown';
      const nombre_depto = data?.depto_nombre || data?.nombre_depto || null;

      ensureProp(propId, propName);
      ensureDept(propId, codigo_depto, nombre_depto);

      byProp[propId][b].push(id);
      byPropDept[propId][codigo_depto][b].push(id);
    }
  }

  return { byProp, byPropDept };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'GET') return bad(res, 405, 'Método no permitido');

    const dateParam = (req.query.date || req.body?.date || '').trim();
    const rebuild = (req.query.rebuild || req.body?.rebuild || '') === '1';

    // ⬅️ aceptar ambos nombres, en query y body
    const propParamRaw =
      req.query?.propiedad_id ??
      req.query?.property ??
      req.body?.propiedad_id ??
      req.body?.property ??
      '';

    const propParam = String(propParamRaw).trim();
    const hasPropFilter = propParam !== '' && propParam.toLowerCase() !== 'all';

    const dateISO = dateParam ? toISODateAR(dateParam) : DateTime.now().setZone(TZ).toISODate();
    const rootRef = firestore.collection('DailyIndex').doc(dateISO);

    // ---------- FAST PATH: cache ----------
    if (!rebuild) {
      const existing = await rootRef.get();
      if (existing.exists) {
        if (hasPropFilter) {
          const propSnap = await rootRef.collection('props').doc(propParam).get();
          if (propSnap.exists) {
            const pd = propSnap.data() || {};
            return ok(res, {
              ok: true,
              date: dateISO,
              propiedad_id: propParam,
              propiedad_nombre: pd.propiedad_nombre || null,
              counts: pd.counts || { checkins: 0, stays: 0, checkouts: 0 },
              checkins: Array.isArray(pd.checkins) ? pd.checkins : [],
              stays: Array.isArray(pd.stays) ? pd.stays : [],
              checkouts: Array.isArray(pd.checkouts) ? pd.checkouts : [],
              fromCache: true
            });
          }
          // si no existe el subdoc, devolvemos vacío consistente
          return ok(res, {
            ok: true,
            date: dateISO,
            propiedad_id: propParam,
            propiedad_nombre: null,
            counts: { checkins: 0, stays: 0, checkouts: 0 },
            checkins: [], stays: [], checkouts: [],
            fromCache: true
          });
        }

        // Global
        return ok(res, { ok: true, date: dateISO, ...existing.data(), fromCache: true });
      }
    }

    // ---------- BUILD ----------
    const [checkInsSnapRaw, checkOutsSnapRaw, staysSnapRaw] = await Promise.all([
      firestore.collection('Reservas').where('arrival_iso', '==', dateISO).get(),
      firestore.collection('Reservas').where('departure_iso', '==', dateISO).get(),
      firestore.collection('Reservas')
        .where('arrival_iso', '<=', dateISO)
        .where('departure_iso', '>', dateISO)
        .get(), // requiere índice compuesto
    ]);

    const checkInsSnap = { docs: checkInsSnapRaw.docs.filter(d => !isCancelledDoc(d.data())) };
    const checkOutsSnap = { docs: checkOutsSnapRaw.docs.filter(d => !isCancelledDoc(d.data())) };
    let staysDocsFiltered = staysSnapRaw.docs.filter(d => !isCancelledDoc(d.data()));

    // dedupe: prioridad checkins > checkouts > stays
    const setCheckins = new Set(checkInsSnap.docs.map(d => d.id));
    const setCheckouts = new Set(checkOutsSnap.docs.map(d => d.id));
    staysDocsFiltered = staysDocsFiltered.filter(d => !setCheckins.has(d.id) && !setCheckouts.has(d.id));

    const checkinsIds = checkInsSnap.docs.map(d => d.id);
    const checkoutsIds = checkOutsSnap.docs.map(d => d.id);
    const staysIds = staysDocsFiltered.map(d => d.id);

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

    const docsByBucket = {
      checkins: checkInsSnap.docs,
      stays: staysDocsFiltered,
      checkouts: checkOutsSnap.docs
    };
    const { byProp, byPropDept } = groupByPropAndDept(docsByBucket);

    // ---------- WRITE ----------
    let batch = firestore.batch();
    let ops = 0;
    const flush = async () => { if (ops > 0) { await batch.commit(); batch = firestore.batch(); ops = 0; } };
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

      // 3) Depts por prop
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

    // ---------- RESPONSE acorde al filtro ----------
    if (hasPropFilter) {
      const b = byProp[propParam] || { checkins: [], stays: [], checkouts: [], propiedad_nombre: null };
      return ok(res, {
        ok: true,
        date: dateISO,
        propiedad_id: propParam,
        propiedad_nombre: b.propiedad_nombre || null,
        counts: {
          checkins: b.checkins.length,
          stays: b.stays.length,
          checkouts: b.checkouts.length
        },
        checkins: b.checkins,
        stays: b.stays,
        checkouts: b.checkouts,
        fromCache: false
      });
    }

    // Global
    return ok(res, { ok: true, date: dateISO, ...globalPayload, fromCache: false });
  } catch (e) {
    console.error(e);
    return bad(res, 500, e.message || 'Error building daily index');
  }
}




