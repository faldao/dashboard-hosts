// /api/properties.js
import { firestore } from '../lib/firebaseAdmin.js';

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

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'GET') return bad(res, 405, 'Método no permitido');

    // Traemos TODAS las propiedades (no filtramos por "active")
    const snap = await firestore.collection('propiedades').get();

    const items = snap.docs.map(d => {
      const data = d.data() || {};
      return {
        id: d.id,
        nombre: data.nombre || data.name || data.displayName || String(d.id),
      };
    });

    return ok(res, { ok: true, items });
  } catch (e) {
    console.error(e);
    return bad(res, 500, e.message || 'Error leyendo propiedades');
  }
}

