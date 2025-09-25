// /api/reservationMutations.js
// OBJETIVO: Recibir acciones de los hosts desde el frontend y actualizar la reserva en Firestore.
// ACCIONES SOPORTADAS:
//  - "checkin"     : marca check-in (ahora o con fecha/hora pasada por payload.when)
//  - "checkout"    : marca check-out (ídem)
//  - "contact"     : marca contactado (ídem)
//  - "addNote"     : agrega nota de host (payload: { text })
//  - "addPayment"  : agrega pago de host (payload: { amount, currency, method, concept?, when? })
//  - "setToPay"    : setea total a pagar en USD con desglose (payload: { baseUSD, ivaPercent?, ivaUSD?, extrasUSD?, fxRate? })
//                     *Compat:* sigue aceptando cleaningUSD y lo mapea a extrasUSD si viene.
// Todas las acciones guardan historial de cambios (subcolección 'historial') con diff.

import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';

const log = (...args) => console.log('[ReservationMutations]', ...args);
const IGNORE_KEYS = new Set([
  'updatedAt','createdAt','contentHash','enrichmentStatus','enrichedAt','lastUpdatedAt','lastUpdatedBy'
]);

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
  return Number.isFinite(n) ? n : 0;
};

async function getUsdArsRateByDate(dateISO) {
  try {
    if (!dateISO) return null;
    const id = String(dateISO).slice(0, 10);
    const ref = firestore.collection('fx_rates').doc(id);
    const snap = await ref.get();
    const rate = snap.exists ? Number(snap.data()?.rate) : null;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
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
      const amount   = Number(payload?.amount);
      const currency = String(payload?.currency || 'ARS').toUpperCase();
      const method   = String(payload?.method || 'Efectivo');
      const concept  = String(payload?.concept || '').trim() || null;
      if (!Number.isFinite(amount) || amount <= 0) return bad(res, 400, 'Monto inválido');

      const payment = {
        ts: payload?.when ? toTs(payload.when) : Timestamp.now(),
        by: user || 'host',
        source: 'host',
        wubook_id: null,
        amount,
        currency,
        method,
        concept,
      };

      const prevPaysUnified = Array.isArray(before.payments) ? before.payments.slice(0, 1000) : [];
      update.payments = [...prevPaysUnified, payment];

      try {
        const toPayUSD  = Number(before.toPay);
        const fxDateISO = getReservationFxDateISO(before);
        const fxRate    = payload?.fxRate ? Number(payload.fxRate) : (await getUsdArsRateByDate(fxDateISO));
        const { paidUSD } = computePaidUSD(update.payments, Number.isFinite(fxRate) && fxRate > 0 ? fxRate : null);

        if (Number.isFinite(toPayUSD) && toPayUSD > 0) {
          update.payment_status = paidUSD >= toPayUSD ? 'paid' : (paidUSD > 0 ? 'partial' : 'unpaid');
        } else {
          update.payment_status = 'partial';
        }
      } catch {
        update.payment_status = before.payment_status || 'partial';
      }

      historyPayload.payment = payment;

    } else if (action === 'setToPay') {
      // --- valores previos del breakdown ---
      const prev = before?.toPay_breakdown || {};
      const prevBase   = Number.isFinite(Number(prev.baseUSD))   ? Number(prev.baseUSD)   : 0;
      const prevExtras = Number.isFinite(Number(prev.extrasUSD)) ? Number(prev.extrasUSD)
                        : (Number.isFinite(Number(before?.extrasUSD)) ? Number(before.extrasUSD) : 0);
      const prevIvaAmt = Number.isFinite(Number(prev.ivaUSD))    ? Number(prev.ivaUSD)    : 0;
      const prevIvaPct = Number.isFinite(Number(prev.ivaPercent))? Number(prev.ivaPercent): null;

      // helper: distingue undefined (no mandado) vs "" (vaciar) vs número
      const readField = (key, prevVal) => {
        if (!(key in payload)) return { calc: prevVal, store: prevVal, fromPrev: true }; // no vino -> conserva
        const raw = payload[key];
        if (raw === '' || raw === null) return { calc: 0, store: null, fromPrev: false }; // vacío -> 0 y guarda null
        const n = Number(raw);
        return Number.isFinite(n) ? { calc: n, store: +n.toFixed(2), fromPrev: false } : { calc: 0, store: null, fromPrev: false };
      };

      // base
      const baseR = readField('baseUSD', prevBase);

      // extras: prioridad extrasUSD si vino; si NO vino, mirar cleaningUSD (compat).
      let extrasR;
      if ('extrasUSD' in payload) {
        extrasR = readField('extrasUSD', prevExtras);
      } else if ('cleaningUSD' in payload) {
        extrasR = readField('cleaningUSD', prevExtras);
      } else {
        extrasR = { calc: prevExtras, store: prevExtras, fromPrev: true };
      }

      // IVA: si viene ivaUSD, manda; si no, si viene ivaPercent, recalcula con base actual;
      // si no viene ninguno, conserva ambos (monto y % previos).
      let ivaUSD_calc = prevIvaAmt, ivaUSD_store = prevIvaAmt;
      let ivaPct_calc = prevIvaPct, ivaPct_store = prevIvaPct;

      if ('ivaUSD' in payload) {
        const ivaR = readField('ivaUSD', prevIvaAmt);
        ivaUSD_calc = ivaR.calc;
        ivaUSD_store = ivaR.store;
        if (!('ivaPercent' in payload)) {
          ivaPct_store = prevIvaPct;
          ivaPct_calc  = prevIvaPct;
        }
      }

      if ('ivaPercent' in payload) {
        const raw = payload.ivaPercent;
        if (raw === '' || raw === null) {
          ivaPct_store = null;
          ivaPct_calc  = null;
          if (!('ivaUSD' in payload)) {
            ivaUSD_calc = 0; ivaUSD_store = 0;
          }
        } else {
          const p = Number(raw);
          if (Number.isFinite(p) && p >= 0) {
            ivaPct_store = p; ivaPct_calc = p;
            if (!('ivaUSD' in payload)) {
              ivaUSD_calc = +(baseR.calc * (p/100)).toFixed(2);
              ivaUSD_store = ivaUSD_calc;
            }
          } else {
            ivaPct_store = null; ivaPct_calc = null;
          }
        }
      }

      const baseUSD   = Number.isFinite(baseR.calc)   ? +baseR.calc.toFixed(2)   : 0;
      const extrasUSD = Number.isFinite(extrasR.calc) ? +extrasR.calc.toFixed(2) : 0;
      const ivaUSD    = Number.isFinite(ivaUSD_calc)  ? +ivaUSD_calc.toFixed(2)  : 0;

      const toPayUSD = +(baseUSD + ivaUSD + extrasUSD).toFixed(2);
      if (!Number.isFinite(toPayUSD) || toPayUSD < 0) return bad(res, 400, 'Total inválido');

      update.toPay     = toPayUSD;
      update.currency  = 'USD';
      // campo único de front (si usuario vació extras -> null)
      update.extrasUSD = (extrasR.store === null) ? null : +Number(extrasR.store).toFixed(2);
      update.toPay_breakdown = {
        baseUSD:  (baseR.store === null) ? null : +Number(baseR.store).toFixed(2),
        ivaPercent: (ivaPct_store === null) ? null : +Number(ivaPct_store),
        ivaUSD:  (ivaUSD_store === null) ? null : +Number(ivaUSD_store).toFixed(2),
        extrasUSD: (extrasR.store === null) ? null : +Number(extrasR.store).toFixed(2),
        fxRate: null
      };

      const fxDateISO = getReservationFxDateISO(before);
      const fxRate =
        payload?.fxRate && Number.isFinite(Number(payload.fxRate)) && Number(payload.fxRate) > 0
          ? Number(payload.fxRate)
          : (await getUsdArsRateByDate(fxDateISO));

      try {
        const pays = Array.isArray(before.payments) ? before.payments : [];
        const { paidUSD, rateUsed, note } = computePaidUSD(pays, Number.isFinite(fxRate) && fxRate > 0 ? fxRate : null);
        update.payment_status = paidUSD >= toPayUSD ? 'paid' : (paidUSD > 0 ? 'partial' : 'unpaid');
        update.toPay_breakdown.fxRate = rateUsed || null;

        historyPayload.toPay = {
          baseUSD,
          ivaUSD,
          ivaPercent: (ivaPct_store === null) ? null : +Number(ivaPct_store),
          extrasUSD,
          toPayUSD,
          fxDateISO,
          fxRate: rateUsed || null,
          fxNote: note || null,
          cleaningUSD_compat: ('cleaningUSD' in payload)
            ? (payload.cleaningUSD === '' ? null : Number(payload.cleaningUSD))
            : null
        };
      } catch {
        update.payment_status = before.payment_status || 'unpaid';
        historyPayload.toPay = {
          baseUSD,
          ivaUSD,
          ivaPercent: (ivaPct_store === null) ? null : +Number(ivaPct_store),
          extrasUSD,
          toPayUSD,
          fxDateISO,
          fxRate: null,
          fxNote: 'FX not available',
          cleaningUSD_compat: ('cleaningUSD' in payload)
            ? (payload.cleaningUSD === '' ? null : Number(payload.cleaningUSD))
            : null
        };
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

// ---- helpers de diff al final (fuera del handler) ----
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

