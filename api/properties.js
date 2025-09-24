// /api/properties.js
// Lista de propiedades para el selector (con opción de filtrar solo activas)

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

    const onlyActive = String(req.query.active || '').trim() === '1';

    // Colección raíz: 'propiedades'  (docs: 100, 101, 105, etc.)
    const snap = await firestore.collection('propiedades').get();

    const items = snap.docs
      .map(d => {
        const data = d.data() || {};
        return {
          id: d.id,
          nombre:
            data.nombre ||
            data.name ||
            data.displayName ||
            String(d.id),
          // flags comunes para "activo"
          _activo:
            data.activo === true ||
            data.active === true ||
            data.enabled === true ||
            data.habilitada === true ||
            data.estado === 'activo',
        };
      })
      .filter(p => {
        if (!onlyActive) return true;
        return p._activo; // si pidieron solo activas
      })
      .map(({ _activo, ...rest }) => rest); // limpio flag interno

    return ok(res, { ok: true, items });
  } catch (e) {
    console.error('[properties] error:', e);
    return bad(res, 500, e.message || 'Error leyendo propiedades');
  }
}
