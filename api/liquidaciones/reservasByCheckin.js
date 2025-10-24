// /api/liquidaciones/reservasByCheckin.js
import { firestore } from '../../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res.status(code).json({ error });
};

const toISO = (s) =>
  s ? DateTime.fromISO(String(s), { zone: TZ }).toISODate() : null;

const norm = (x) => String(x || '').trim();

const normalizeStatus = (s) =>
  String(s || 'unknown').toLowerCase().replace(/\s+/g, '_');
const isCancelled = (data) => {
  const s =
    normalizeStatus(data?.status) ||
    normalizeStatus(data?.state) ||
    normalizeStatus(data?.reservation_status);
  if (s.includes('cancel')) return true;
  if (data?.is_cancelled === true || data?.cancelled === true) return true;
  if (normalizeStatus(data?.cancellation?.status).includes('cancel'))
    return true;
  return false;
};

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method !== 'GET') return bad(res, 405, 'Método no permitido');

    const property = norm(req.query.property || req.query.propiedad_id || 'all');
    const deptIdsCsv = norm(req.query.deptIds || '');
    const fromISO = toISO(req.query.from);
    const toISOd = toISO(req.query.to);

    if (!fromISO || !toISOd)
      return bad(res, 400, 'Parámetros inválidos: from, to son obligatorios');

    // query base: arrival_iso within [from, to]
    let q = firestore
      .collection('Reservas')
      .where('arrival_iso', '>=', fromISO)
      .where('arrival_iso', '<=', toISOd);

    if (property && property !== 'all') {
      q = q.where('propiedad_id', '==', property);
    }

    const snap = await q.get();
    let docs = snap.docs.filter((d) => !isCancelled(d.data()));

    // filtro por deptos si viene
    const deptSet =
      deptIdsCsv.length > 0
        ? new Set(
            deptIdsCsv
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        : null;

    if (deptSet) {
      docs = docs.filter((d) => {
        const data = d.data() || {};
        const cod =
          data.codigo_depto || data.id_zak || data.depto_id || data.nombre_depto;
        return cod && deptSet.has(String(cod));
      });
    }

    // payload
    const items = docs.map((d) => {
      const r = d.data() || {};
      const pays = Array.isArray(r.payments) ? r.payments : [];
      return {
        id: d.id,
        id_human: r.id_human || null,
        propiedad_id: r.propiedad_id || null,
        propiedad_nombre: r.propiedad_nombre || null,

        depto_id: r.depto_id || null,
        depto_codigo: r.codigo_depto || r.id_zak || null,
        depto_nombre: r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || null,

        arrival_iso: r.arrival_iso || null,
        departure_iso: r.departure_iso || null,

        channel_name: r.channel_name || r.source || null,
        nombre_huesped: r.nombre_huesped || r.customer_name || null,

        // moneda de la reserva (por simplicidad)
        currency: (r.currency || 'ARS').toUpperCase(),

        // contable (si ya hubiera algo previo)
        accounting: r.accounting || null,

        // por si hace falta en UI
        payments: pays.map((p) => ({
          amount: Number(p.amount) || 0,
          currency: String(p.currency || '').toUpperCase() || 'ARS',
          method: p.method || null,
          concept: p.concept || null,
          ts: p.ts || null,
        })),
      };
    });

    // agrupación util opcional (por moneda y por depto) — el front puede ignorarla
    const groups = { ARS: {}, USD: {} };
    for (const it of items) {
      const mon = it.currency === 'USD' ? 'USD' : 'ARS';
      const key = it.depto_codigo || it.depto_nombre || 'unknown';
      if (!groups[mon][key]) groups[mon][key] = { depto: it.depto_nombre, list: [] };
      groups[mon][key].list.push(it);
    }

    return ok(res, {
      ok: true,
      filters: { property, deptIds: deptIdsCsv || null, from: fromISO, to: toISOd },
      count: items.length,
      items,
      groups,
    });
  } catch (e) {
    console.error('[reservasByCheckin]', e);
    return bad(res, 500, e?.message || 'Error interno');
  }
}
