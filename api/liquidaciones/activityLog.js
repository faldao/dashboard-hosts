// /api/liquidaciones/activityLog.js
import { firestore, FieldValue, authAdmin } from '../../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

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

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

    const user = await getAuthUser(req);
    if (!user) return bad(res, 401, 'No autenticado');

    const { type, message, meta } = req.body || {};
    if (!type) return bad(res, 400, 'Falta type');

    const bucket = DateTime.now().toFormat('yyyy-LL'); // p.e. 2025-07
    const col = firestore.collection('ActivityLog').doc(bucket).collection('events');
    const doc = {
      ts: FieldValue.serverTimestamp(),
      type,
      message: message || null,
      meta: meta || null,
      actor: {
        uid: user.uid,
        email: user.email || null,
        name: user.name || null,
      },
      app: 'liquidaciones',
    };
    const ref = await col.add(doc);

    return ok(res, { ok: true, id: ref.id });
  } catch (e) {
    console.error('[activityLog]', e);
    return bad(res, 500, e?.message || 'Error interno');
  }
}
