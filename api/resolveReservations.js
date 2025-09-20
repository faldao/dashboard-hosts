// /api/resolveReservations.js
import { firestore } from '../lib/firebaseAdmin.js';

export default async function handler(req, res) {
  try {
    const ids = req.method === 'POST' ? (req.body?.ids || []) : [];
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ids requerido' });
    }

    // Batches de 10 para Firestore getAll-like
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

    const out = [];
    for (const chunk of chunks) {
      const snaps = await Promise.all(
        chunk.map(id => firestore.collection('Reservas').doc(id).get())
      );
      snaps.forEach(s => s.exists && out.push({ id: s.id, ...s.data() }));
    }

    return res.status(200).json({ ok: true, items: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Error resolving reservations' });
  }
}