// /api/reservationMutations.js
// OBJETIVO: Recibir acciones de los hosts desde el frontend y actualizar la reserva en Firestore.
// ACCIONES SOPORTADAS:
//  - "checkin"     : marca check-in (ahora o con fecha/hora pasada por payload.when)
//  - "checkout"    : marca check-out (ídem)
//  - "contact"     : marca contactado (ídem)
//  - "addNote"     : agrega nota de host (payload: { text })
//  - "addPayment"  : agrega pago de host (payload: { amount, currency, method, concept?, when? })
//  - "setToPay"    : setea total a pagar en USD con desglose (payload: { baseUSD, ivaPercent?, ivaUSD?, cleaningUSD?, fxRate? })
// Todas las acciones guardan historial de cambios (subcolección 'historial') con diff.

import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';

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
  if (!when || when === 'now') return FieldValue.serverTimestamp();
  try {
    const d = new Date(when);
    if (!isNaN(d.getTime())) return Timestamp.fromDate(d);
  } catch {}
  return FieldValue.serverTimestamp();
}
const num = (x) => {
  const n = Number(x);
  return isFinite(n) ? n : 0;
};

async function getUsdArsRateByDate(dateISO) {
  try {
    if (!dateISO) return null;
    const id = String(dateISO).slice(0, 10);
    const ref = firestore.collection('fx_rates').doc(id);
    const snap = await ref.get();
    const rate = snap.exists ? Number(snap.data()?.rate) : null;
    return isFinite(rate) && rate > 0 ? rate : null;
  } catch (e) {
    log('WARN getUsdArsRateByDate', e?.message);
    return null;
  }
}
function getReservationFxDateISO(res) {
  if (res?.arrival_iso) {
    try {
      const d = new Date(res.arrival_iso);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0,10);
    } catch {}
  }
  return new Date().toISOString().slice(0,10);
}
function computePaidUSD(payments = [], fxRate) {
  let paidUSD = 0;
  for (const p of payments || []) {
    const curr = String(p.currency || '').toUpperCase();
    const amt = num(p.amount);
    if (!amt) continue;
    if (curr === 'USD') paidUSD += amt;
    else if (curr === 'ARS' && fxRate) paidUSD += (amt / fxRate);
  }
  return { paidUSD, rateUsed: fxRate || null, note: !fxRate ? 'FX missing: USD total ignores ARS' : null };
}

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

    if (action === 'checkin') {
      update.checkin_at = toTs(payload.when ?? null);

    } else if (action === 'checkout') {
      update.checkout_at = toTs(payload.when ?? null);

    } else if (action === 'contact') {
      update.contacted_at = toTs(payload.when ?? null);

    } else if (action === 'addNote') {
      const text = String(payload?.text || '').trim();
      if (!text) return bad(res, 400, 'Texto de nota vacío');

      const unifiedNote = {
        ts: Timestamp.now(),
        by: user || 'host',
        text,
        source: 'host',
        wubook_id: null,
        sent_to_wubook: false,
      };

      const prevNotes = Array.isArray(before.notes) ? before.notes.slice(0, 1000) : [];
      update.notes = [...prevNotes, unifiedNote];
      historyPayload.note = unifiedNote;

    } else if (action === 'addPayment') {
      const amount  = Number(payload?.amount);
      const currency = String(payload?.currency || 'ARS').toUpperCase();
      const method   = String(payload?.method || 'Efectivo');
      const concept  = String(payload?.concept || '').trim() || null; // ← NUEVO
      if (!isFinite(amount) || amount <= 0) return bad(res, 400, 'Monto inválido');

      const payment = {
        ts: payload?.when ? toTs(payload.when) : Timestamp.now(),
        by: user || 'host',
        source: 'host',
        wubook_id: null,
        amount,
        currency,
        method,
        concept, // ← NUEVO (se guarda si viene, o null)
      };

      const prevPaysUnified = Array.isArray(before.payments) ? before.payments.slice(0, 1000) : [];
      update.payments = [...prevPaysUnified, payment];

      try {
        const toPayUSD = Number(before.toPay);
        const fxDateISO = getReservationFxDateISO(before);
        const fxRate = payload?.fxRate ? Number(payload.fxRate) : (await getUsdArsRateByDate(fxDateISO));
        const { paidUSD } = computePaidUSD(update.payments, isFinite(fxRate) && fxRate > 0 ? fxRate : null);

        if (isFinite(toPayUSD) && toPayUSD > 0) {
          update.payment_status = paidUSD >= toPayUSD ? 'paid' : (paidUSD > 0 ? 'partial' : 'unpaid');
        } else {
          update.payment_status = 'partial';
        }
      } catch {
        update.payment_status = before.payment_status || 'partial';
      }

      historyPayload.payment = payment;

    } else if (action === 'setToPay') {
      const baseUSD = num(payload?.baseUSD);
      const cleaningUSD = num(payload?.cleaningUSD);
      let ivaUSD = num(payload?.ivaUSD);
      const ivaPercent = num(payload?.ivaPercent);
      if (!ivaUSD && ivaPercent) ivaUSD = +(baseUSD * (ivaPercent / 100)).toFixed(2);

      const toPayUSD = +(baseUSD + ivaUSD + cleaningUSD).toFixed(2);
      if (!isFinite(toPayUSD) || toPayUSD < 0) return bad(res, 400, 'Total inválido');

      update.toPay = toPayUSD;
      update.currency = 'USD';

      const fxDateISO = getReservationFxDateISO(before);
      const fxRate =
        payload?.fxRate && isFinite(Number(payload.fxRate)) && Number(payload.fxRate) > 0
          ? Number(payload.fxRate)
          : (await getUsdArsRateByDate(fxDateISO));

      try {
        const pays = Array.isArray(before.payments) ? before.payments : [];
        const { paidUSD, rateUsed, note } = computePaidUSD(pays, isFinite(fxRate) && fxRate > 0 ? fxRate : null);
        update.payment_status = paidUSD >= toPayUSD ? 'paid' : (paidUSD > 0 ? 'partial' : 'unpaid');

        historyPayload.toPay = {
          baseUSD, ivaUSD, ivaPercent: ivaPercent || null, cleaningUSD,
          toPayUSD, fxDateISO, fxRate: rateUsed || null, fxNote: note || null
        };
      } catch {
        update.payment_status = before.payment_status || 'unpaid';
        historyPayload.toPay = { baseUSD, ivaUSD, ivaPercent: ivaPercent || null, cleaningUSD, toPayUSD, fxDateISO, fxRate: null, fxNote: 'FX not available' };
      }

    } else {
      return bad(res, 400, `Acción no soportada: ${action}`);
    }

    const afterPreview = { ...before, ...update };
    const newHash = hashDoc(afterPreview);
    update.contentHash = newHash;
    update.updatedAt = nowServer;

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
