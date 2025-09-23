// /api/reservationMutations.js
// OBJETIVO: Recibir acciones de los hosts desde el frontend y actualizar la reserva en Firestore.
// ACCIONES SOPORTADAS:
//  - "checkin"     : marca check-in (ahora o con fecha/hora pasada por payload.when)
//  - "checkout"    : marca check-out (ídem)
//  - "contact"     : marca contactado (ídem)
//  - "addNote"     : agrega nota de host (payload: { text })
//  - "addPayment"  : agrega pago de host (payload: { amount, currency, method })
// Todas las acciones guardan historial de cambios (subcolección 'historial') con diff.

import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';

// ------------------ helpers comunes (alineados con tus otros endpoints) ------------------
const log = (...args) => console.log('[ReservationMutations]', ...args);
const IGNORE_KEYS = new Set(['updatedAt','createdAt','contentHash','enrichmentStatus','enrichedAt','lastUpdatedAt','lastUpdatedBy']);

const sortObject = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObject(obj[k]); return acc; }, {});
  }
  return obj;
};
const stableStringify = (obj) => JSON.stringify(sortObject(obj));
const stripKeys = (obj, ignore = IGNORE_KEYS) => {
  const out = {};
  for (const k of Object.keys(obj || {})) if (!ignore.has(k)) out[k] = obj[k];
  return out;
};
const hashDoc = (doc) => crypto.createHash('sha1').update(stableStringify(stripKeys(doc))).digest('hex');

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

function toTs(when) {
  // when puede venir null/"now" => serverTimestamp; ISO string => Timestamp.fromDate
  if (!when || when === 'now') return FieldValue.serverTimestamp();
  try {
    const d = new Date(when);
    if (!isNaN(d.getTime())) return Timestamp.fromDate(d);
  } catch {}
  return FieldValue.serverTimestamp();
}

// ------------------ lógica principal ------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

  try {
    const { id, action, payload = {}, user = 'host' } = req.body || {};
    if (!id || !action) return bad(res, 400, 'Faltan parámetros: id y action son obligatorios');

    const ref = firestore.collection('Reservas').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return bad(res, 404, 'Reserva no encontrada');

    const before = snap.data();
    const nowServer = FieldValue.serverTimestamp();

    let update = { lastUpdatedBy: user || 'host', lastUpdatedAt: nowServer };
    let historyPayload = {};
    let changeTag = action;

    // -------- acciones --------
    if (action === 'checkin') {
      update.checkin_at = toTs(payload.when ?? null);
      // nada más: las cards/chips leen checkin_at
    } else if (action === 'checkout') {
      update.checkout_at = toTs(payload.when ?? null);
      // idem: chips leen checkout_at
    } else if (action === 'contact') {
      update.contacted_at = toTs(payload.when ?? null);
    }  else if (action === 'addNote') {
  const text = String(payload?.text || '').trim();
  if (!text) return bad(res, 400, 'Texto de nota vacío');

  const nowTs = Timestamp.now();
  const who = user || 'host';

  const unifiedNote = {
    ts: nowTs,
    by: who,
    text,
    source: 'host',
    wubook_id: null,
    sent_to_wubook: false,
      };
      // guardamos en arreglo 'host_notes' y en subcolección 'historial' con snapshot
      const prevNotes = Array.isArray(before.host_notes) ? before.host_notes.slice(0, 1000) : [];
      update.host_notes = [...prevNotes, note];
      historyPayload.note = note;
    } else if (action === 'addPayment') {
      const amount = Number(payload?.amount);
      const currency = String(payload?.currency || 'ARS');
      const method = String(payload?.method || 'Efectivo');
      if (!isFinite(amount) || amount <= 0) return bad(res, 400, 'Monto inválido');

      const payment = {
        ts: Timestamp.now(),
        by: user || 'host',
        amount,
        currency,
        method,
        source: 'host',
      };
      const prevPays = Array.isArray(before.host_payments) ? before.host_payments.slice(0, 500) : [];
      update.host_payments = [...prevPays, payment];

      // Heurística simple de estado de pago si no existe lógica de saldo:
      // - si existía payment_status === 'paid' lo mantenemos
      // - si sumatoria >= toPay (si existe), marcamos 'paid', si no 'partial'
      try {
        const toPay = Number(before.toPay);
        const totalPaid = prevPays.reduce((s, p) => s + (Number(p.amount) || 0), 0) + amount;
        if (isFinite(toPay) && toPay > 0) {
          update.payment_status = totalPaid >= toPay ? 'paid' : 'partial';
        } else {
          update.payment_status = 'partial';
        }
      } catch {
        update.payment_status = before.payment_status || 'partial';
      }
      historyPayload.payment = payment;
    } else {
      return bad(res, 400, `Acción no soportada: ${action}`);
    }

    // -------- re-calcular hash y registrar historial con diff --------
    const afterPreview = { ...before, ...update };
    const newHash = hashDoc(afterPreview);
    update.contentHash = newHash;
    update.updatedAt = nowServer;

    // batch para update + historial
    const batch = firestore.batch();
    batch.update(ref, update);

    const histRef = ref.collection('historial').doc(`${Date.now()}_${action}`);
    const diff = computeDiff(stripKeys(before), stripKeys(afterPreview));
    const histDoc = {
      ts: nowServer,
      source: 'host_ui',
      context: { action, by: user },
      changeType: 'updated',
      changedKeys: Object.keys(diff),
      diff,
      payload: historyPayload,
      hashFrom: before.contentHash || null,
      hashTo: newHash,
    };
    batch.set(histRef, histDoc);

    await batch.commit();

    return ok(res, { ok: true, id, action, updated: Object.keys(update) });
  } catch (err) {
    log('ERROR', err?.message);
    return bad(res, 500, err?.message || 'Error interno');
  }
}

// diff básico (alineado a lo que ya usás)
function computeDiff(a = {}, b = {}) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (stableStringify(av) !== stableStringify(bv)) {
      out[k] = { from: av === undefined ? null : av, to: bv === undefined ? null : bv };
    }
  }
  return out;
}

