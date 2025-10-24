// /api/liquidaciones/accountingMutations.js
import { firestore, FieldValue, authAdmin } from '../../lib/firebaseAdmin.js';
import crypto from 'crypto';

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  

  return res.status(code).json({ error });
};

const stable = (o) =>
  JSON.stringify(
    Object.keys(o || {})
      .sort()
      .reduce((a, k) => ((a[k] = o[k]), a), {})
  );
const hashDoc = (doc) => crypto.createHash('sha1').update(stable(doc)).digest('hex');

async function getAuthUser(req) {
  try {
    const h = req.headers?.authorization || req.headers?.Authorization || '';
    const m = h.match(/^Bearer\s+([A-Za-z0-9\-\._~\+\/]+=*)$/i);
    if (!m) return null;
    const decoded = await authAdmin.verifyIdToken(m[1]);
    const name = decoded.name || decoded.displayName || null;
    return { uid: decoded.uid, email: decoded.email || null, name };
  } catch {
    return null;
  }
}

const n = (x) => (Number.isFinite(Number(x)) ? +Number(x) : null);

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

    const authUser = await getAuthUser(req);
    if (!authUser) return bad(res, 401, 'No autenticado');

    const { id, payload = {} } = req.body || {};
    if (!id) return bad(res, 400, 'Falta id');

    const ref = firestore.collection('Reservas').doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) return bad(res, 404, 'Reserva no encontrada');

    const before = snap.data() || {};

    // leer editables
    const bruto = n(payload.brutoUSD);
    const comis = n(payload.comisionCanalUSD);
    const tasa = n(payload.tasaLimpiezaUSD);
    const costo = n(payload.costoFinancieroUSD);
    const obs = typeof payload.observaciones === 'string' ? payload.observaciones : undefined;

    // merge con existentes (no pisar si viene null/undefined)
    const prevAcc = before.accounting || {};
    const acc = {
      brutoUSD: bruto ?? prevAcc.brutoUSD ?? null,
      comisionCanalUSD: comis ?? prevAcc.comisionCanalUSD ?? null,
      tasaLimpiezaUSD: tasa ?? prevAcc.tasaLimpiezaUSD ?? null,
      costoFinancieroUSD: costo ?? prevAcc.costoFinancieroUSD ?? null,
      observaciones: obs !== undefined ? obs : (prevAcc.observaciones || ''),
    };

    const sum = (x) => (Number.isFinite(Number(x)) ? +Number(x) : 0);
    const netoUSD =
      +(sum(acc.brutoUSD) + sum(acc.comisionCanalUSD) + sum(acc.tasaLimpiezaUSD) + sum(acc.costoFinancieroUSD)).toFixed(2);

    const update = {
      accounting: { ...acc, netoUSD },
      lastUpdatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: authUser.name || authUser.email || authUser.uid || 'host',
      lastUpdatedByUid: authUser.uid || null,
      lastUpdatedByEmail: authUser.email || null,
      updatedAt: FieldValue.serverTimestamp(),
      contentHash: hashDoc({ ...(before || {}), accounting: { ...acc, netoUSD } }),
    };

    const batch = firestore.batch();
    batch.update(ref, update);

    // historial
    const histRef = ref.collection('historial').doc(`${Date.now()}_setAccounting`);
    batch.set(histRef, {
      ts: FieldValue.serverTimestamp(),
      source: 'host_ui',
      context: {
        action: 'setAccounting',
        by: update.lastUpdatedBy,
        byUid: authUser.uid || null,
        byEmail: authUser.email || null,
      },
      changeType: 'updated',
      payload: { accounting: update.accounting },
    });

    await batch.commit();
    return ok(res, { ok: true, id, netoUSD });
  } catch (e) {
    console.error('[accountingMutations]', e);
    return bad(res, 500, e?.message || 'Error interno');
  }
}
