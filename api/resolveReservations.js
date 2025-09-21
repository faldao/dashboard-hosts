// /api/resolveReservations.js
// OBJETIVO: resolver una lista de IDs de 'Reservas' y devolver sus documentos.
// BLINDAJE: excluir canceladas.

import { firestore } from '../lib/firebaseAdmin.js';

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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 300) : [];
    if (!ids.length) return ok(res, { items: [] });

    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

    const items = [];
    for (const c of chunks) {
      const snaps = await firestore.getAll(...c.map(id => firestore.collection('Reservas').doc(id)));
      snaps.forEach((s) => {
        if (!s.exists) return;
        const d = s.data();
        // Filtro canceladas
        if (d?.is_cancelled === true) return;
        if ((d?.status || '').toLowerCase() === 'cancelled') return;
        items.push({ id: s.id, ...d });
      });
    }

    return ok(res, { items });
  } catch (e) {
    return bad(res, 500, e.message || 'Error');
  }
}
