// /api/resolveReservations.js
// OBJETIVO: resolver una lista de IDs de 'Reservas' y devolver sus documentos.
// BLINDAJE:
//  - excluir canceladas (varias variantes de status/flags)
//  - normalizar campos esperados por el front (extrasUSD, arrays, breakdown)
//  - preservar el ORDEN de los IDs de entrada
//  - (opcional) filtrar por propiedad: req.body.propiedad_id o req.body.property

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

// --- utils ---
const isCancelled = (d = {}) => {
  const s = String(d.status || d.state || d.reservation_status || '').toLowerCase();
  if (d.is_cancelled === true || d.cancelled === true) return true;
  if (s.includes('cancel')) return true;
  if (String(d?.cancellation?.status || '').toLowerCase().includes('cancel')) return true;
  return false;
};

// Normaliza lo mínimo que el front espera
const normalizeForFront = (raw = {}) => {
  const d = { ...raw };

  // arrays esperados por el front
  if (!Array.isArray(d.notes))    d.notes = [];
  if (!Array.isArray(d.payments)) d.payments = [];

  // leer extras top-level sin forzar 0
  const topExtras = Number.isFinite(Number(d.extrasUSD)) ? Number(d.extrasUSD) : null;

  // breakdown esperable por el editor de total
  if (!d.toPay_breakdown || typeof d.toPay_breakdown !== 'object') {
    d.toPay_breakdown = {
      baseUSD:    null,
      ivaPercent: null,
      ivaUSD:     null,
      extrasUSD:  topExtras,  // usa nivel superior si existe
      fxRate:     null,
    };
  } else {
    const b = d.toPay_breakdown;
    d.toPay_breakdown = {
      baseUSD:    Number.isFinite(Number(b.baseUSD))    ? Number(b.baseUSD)    : null,
      ivaPercent: Number.isFinite(Number(b.ivaPercent)) ? Number(b.ivaPercent) : null,
      ivaUSD:     Number.isFinite(Number(b.ivaUSD))     ? Number(b.ivaUSD)     : null,
      // prioridad: breakdown.extrasUSD, luego top-level, luego null
      extrasUSD:  Number.isFinite(Number(b.extrasUSD))  ? Number(b.extrasUSD)  : topExtras,
      fxRate:     Number.isFinite(Number(b.fxRate))     ? Number(b.fxRate)     : null,
    };
  }

  // extrasUSD top-level: exponer null si no está presente o no es numérico
  if (!Object.prototype.hasOwnProperty.call(d, 'extrasUSD')) {
    d.extrasUSD = null;
  } else if (!Number.isFinite(Number(d.extrasUSD))) {
    d.extrasUSD = null;
  } else {
    d.extrasUSD = Number(d.extrasUSD);
  }

  // toPay: dejar numérico o null
  if (!Object.prototype.hasOwnProperty.call(d, 'toPay') || !Number.isFinite(Number(d.toPay))) {
    d.toPay = null;
  } else {
    d.toPay = Number(d.toPay);
  }

  return d;
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const propFilter = String(req.body?.propiedad_id || req.body?.property || '').trim();

    const ids = rawIds
      .map(x => String(x || '').trim())
      .filter(x => x.length > 0)
      .slice(0, 300);

    if (!ids.length) return ok(res, { items: [] });

    // Traemos por chunks concurrentes
    const CHUNK = 10;
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));

    const maps = await Promise.all(
      chunks.map(async (c) => {
        try {
          const refs = c.map(id => firestore.collection('Reservas').doc(id));
          const snaps = await firestore.getAll(...refs);
          const out = new Map();
          snaps.forEach((s) => {
            if (!s.exists) return;
            const d = s.data();
            if (isCancelled(d)) return; // filtrar canceladas

            // si se pide filtrar por propiedad, respetarlo
            if (propFilter && String(d?.propiedad_id || '') !== propFilter) return;

            const norm = normalizeForFront(d);   // normalizar para el front
            out.set(s.id, { id: s.id, ...norm }); // guardar por id
          });
          return out;
        } catch {
          return new Map();
        }
      })
    );

    // Reconstruir en el EXACTO orden de entrada
    const merged = new Map();
    for (const m of maps) for (const [k, v] of m.entries()) merged.set(k, v);

    const items = [];
    for (const id of ids) if (merged.has(id)) items.push(merged.get(id));

    return ok(res, {
      items,
      // _debug: { propFilter, in: ids.length, out: items.length } // opcional para debug
    });
  } catch (e) {
    return bad(res, 500, e?.message || 'Error');
  }
}



