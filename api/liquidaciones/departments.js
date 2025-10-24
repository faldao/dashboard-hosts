// /api/liquidaciones/departments.js
import { firestore } from '../../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return res.status(code).json({ error });
};

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'GET') return bad(res, 405, 'Método no permitido');

    const prop = String(req.query.property || req.query.propiedad_id || '').trim();
    if (!prop) return bad(res, 400, 'Parámetro property obligatorio');

    // 1) intento subcolección formal
    const subRef = firestore.collection('Propiedades').doc(prop).collection('Departamentos');
    const subSnap = await subRef.get();
    let items = subSnap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
        codigo: x.codigo || x.id_zak || d.id,
        nombre: x.nombre || x.displayName || x.codigo || d.id,
      };
    });

    // 2) fallback: inferir de reservas del último año
    if (!items.length) {
      const from = DateTime.now().minus({ years: 1 }).toISODate();
      const q = await firestore
        .collection('Reservas')
        .where('propiedad_id', '==', prop)
        .where('arrival_iso', '>=', from)
        .limit(2000)
        .get();
      const map = new Map();
      for (const d of q.docs) {
        const r = d.data() || {};
        const codigo = r.codigo_depto || r.id_zak || r.depto_id;
        if (!codigo) continue;
        const nombre = r.depto_nombre || r.nombre_depto || codigo;
        if (!map.has(codigo)) map.set(codigo, { id: codigo, codigo, nombre });
      }
      items = Array.from(map.values());
    }

    items.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    return ok(res, { ok: true, count: items.length, items });
  } catch (e) {
    console.error('[departments]', e);
    return bad(res, 500, e?.message || 'Error interno');
  }
}
