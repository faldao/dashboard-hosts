// /api/reservationMutations.js
// ──────────────────────────────────────────────────────────────────────────────
// OBJETIVO (host UI → Firestore)
//   Recibir acciones desde el frontend y mutar documentos de `Reservas`.
//   Además, normalizar pagos para poder calcular el estado de pago en USD.
//
// ACCIONES SOPORTADAS
//   - "checkin"      → marca check-in (ahora o payload.when)
//   - "checkout"     → marca check-out (ídem)
//   - "contact"      → marca contactado (ídem)
//   - "addNote"      → agrega nota (payload: { text })
//   - "addPayment"   → agrega pago (payload: { amount, currency, method, concept?, when?, fxRate? })
//   - "setToPay"     → setea total USD y desglose
//                      (payload: { baseUSD, ivaPercent?, ivaUSD?, extrasUSD?, fxRate?, cleaningUSD? })
// ──────────────────────────────────────────────────────────────────────────────

import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';

const log = (...args) => console.log('[ReservationMutations]', ...args);
const IGNORE_KEYS = new Set([
  'updatedAt','createdAt','contentHash','enrichmentStatus','enrichedAt','lastUpdatedAt','lastUpdatedBy'
]);

// ── utils de serialización estable ───────────────────────────────────────────
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────
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

// ── helpers genéricos ────────────────────────────────────────────────────────
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

// ── tipo de cambio ───────────────────────────────────────────────────────────
function getFxFromReservation(res) {
  const fx = res?.usd_fx_on_checkin || {};
  const buy = Number(fx.compra), sell = Number(fx.venta);
  if (Number.isFinite(buy) && Number.isFinite(sell) && buy > 0 && sell > 0) return +((buy+sell)/2).toFixed(4);
  if (Number.isFinite(sell) && sell > 0) return +sell.toFixed(4);
  if (Number.isFinite(buy) && buy > 0) return +buy.toFixed(4);
  return null;
}
async function getUsdArsRateByDate(dateISO) {
  try {
    if (!dateISO) return null;
    const ref = firestore.collection('fx_rates').doc(String(dateISO).slice(0,10));
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
async function resolveFxRateForReservation(res, payloadFxRate) {
  const fromRes = getFxFromReservation(res);
  if (Number.isFinite(fromRes) && fromRes > 0) return fromRes;
  const fromFxColl = await getUsdArsRateByDate(getReservationFxDateISO(res));
  if (Number.isFinite(fromFxColl) && fromFxColl > 0) return fromFxColl;
  const fromPayload = Number(payloadFxRate);
  if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;
  return null;
}

// normaliza pagos a USD (usa usd_equiv si viene de ARS)
function computePaidUSD(payments = []) {
  let paidUSD = 0;
  for (const p of payments || []) {
    const curr = String(p.currency || '').toUpperCase();
    const amt = num(p.amount);
    if (!amt) continue;
    if (curr === 'USD') paidUSD += amt;
    else if (curr === 'ARS') {
      const ue = Number(p.usd_equiv);
      if (Number.isFinite(ue) && ue > 0) paidUSD += ue;
    }
  }
  return paidUSD;
}

// ─────────────────────────────────────────────────────────────────────────────
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
        ts: Timestamp.now(), by: user || 'host', text, source: 'host',
        wubook_id: null, sent_to_wubook: false,
      };
      const prevNotes = Array.isArray(before.notes) ? before.notes.slice(0, 1000) : [];
      update.notes = [...prevNotes, unifiedNote];
      historyPayload.note = unifiedNote;

    } else if (action === 'addPayment') {
      const amount  = Number(payload?.amount);
      const currency = String(payload?.currency || 'ARS').toUpperCase();
      const method  = String(payload?.method || 'Efectivo');
      const concept = String(payload?.concept || '').trim() || null;
      if (!Number.isFinite(amount) || amount <= 0) return bad(res, 400, 'Monto inválido');

      const payment = {
        ts: payload?.when ? toTs(payload.when) : Timestamp.now(),
        by: user || 'host', source: 'host',
        wubook_id: null, amount, currency, method, concept,
      };

      if (currency === 'ARS') {
        const fxRate = await resolveFxRateForReservation(before, payload?.fxRate);
        if (Number.isFinite(fxRate) && fxRate > 0) {
          payment.usd_equiv = +(amount / fxRate).toFixed(2);
          payment.fxRateUsed = +fxRate;
        } else {
          payment.usd_equiv = null;
          payment.fxRateUsed = null;
        }
      }

      const prevPays = Array.isArray(before.payments) ? before.payments.slice(0, 1000) : [];
      const newPays  = [...prevPays, payment];
      update.payments = newPays;

      try {
        const toPayUSD = Number(before.toPay);
        const paidUSD  = computePaidUSD(newPays);
        if (Number.isFinite(toPayUSD) && toPayUSD > 0) {
          update.payment_status = paidUSD >= toPayUSD ? 'paid' : (paidUSD > 0 ? 'partial' : 'unpaid');
        } else {
          update.payment_status = paidUSD > 0 ? 'partial' : 'unpaid';
        }
      } catch {
        update.payment_status = before.payment_status || 'partial';
      }

      historyPayload.payment = payment;

    } else if (action === 'setToPay') {
      // ── valores previos del breakdown
      const prev = before?.toPay_breakdown || {};
      const prevBase   = Number.isFinite(Number(prev.baseUSD))   ? Number(prev.baseUSD)   : 0;
      const prevExtras = Number.isFinite(Number(prev.extrasUSD)) ? Number(prev.extrasUSD)
                           : (Number.isFinite(Number(before?.extrasUSD)) ? Number(before.extrasUSD) : 0);
      const prevIvaAmt = Number.isFinite(Number(prev.ivaUSD))    ? Number(prev.ivaUSD)    : 0;
      const prevIvaPct = Number.isFinite(Number(prev.ivaPercent))? Number(prev.ivaPercent): null;

      // helper: distingue undefined vs ""/null vs número
      const readField = (key, prevVal) => {
        if (!(key in payload))       return { calc: prevVal, store: prevVal, fromPrev: true };
        const raw = payload[key];
        if (raw === '' || raw === null) return { calc: 0, store: null, fromPrev: false };
        const n = Number(raw);
        return Number.isFinite(n) ? { calc: +n.toFixed(2), store: +n.toFixed(2), fromPrev: false }
                                  : { calc: 0, store: null, fromPrev: false };
      };

      // base / extras
      const baseR   = readField('baseUSD',   prevBase);
      let   extrasR;
      if ('extrasUSD' in payload) extrasR = readField('extrasUSD', prevExtras);
      else if ('cleaningUSD' in payload) extrasR = readField('cleaningUSD', prevExtras);
      else extrasR = { calc: prevExtras, store: prevExtras, fromPrev: true };

      // IVA (mantenemos ambos modos, percent/amount)
      let ivaUSD_calc  = prevIvaAmt, ivaUSD_store  = prevIvaAmt;
      let ivaPct_calc  = prevIvaPct, ivaPct_store  = prevIvaPct;

      if ('ivaUSD' in payload) {
        const r = readField('ivaUSD', prevIvaAmt);
        ivaUSD_calc = r.calc; ivaUSD_store = r.store;
      }
      if ('ivaPercent' in payload) {
        const raw = payload.ivaPercent;
        if (raw === '' || raw === null) {
          ivaPct_calc = null; ivaPct_store = null;
          // si no mandaron ivaUSD, entonces el importe queda 0
          if (!('ivaUSD' in payload)) { ivaUSD_calc = 0; ivaUSD_store = 0; }
        } else {
          const p = Number(raw);
          if (Number.isFinite(p) && p >= 0) {
            ivaPct_calc = p; ivaPct_store = p;
            // si no mandaron ivaUSD explícito, calcularlo desde base
            if (!('ivaUSD' in payload)) {
              ivaUSD_calc = +(baseR.calc * (p/100)).toFixed(2);
              ivaUSD_store = ivaUSD_calc;
            }
          } else {
            ivaPct_calc = null; ivaPct_store = null;
          }
        }
      }

      const baseUSD   = +baseR.calc;
      const extrasUSD = +extrasR.calc;
      const ivaUSD    = Number.isFinite(ivaUSD_calc) ? +ivaUSD_calc : 0;

      const toPayUSD = +(baseUSD + extrasUSD + ivaUSD).toFixed(2);
      if (!Number.isFinite(toPayUSD) || toPayUSD < 0) return bad(res, 400, 'Total inválido');

      update.toPay   = toPayUSD;
      update.currency = 'USD';
      update.extrasUSD = (extrasR.store === null) ? null : +Number(extrasR.store).toFixed(2);
      update.toPay_breakdown = {
        baseUSD: (baseR.store === null) ? null : +Number(baseR.store).toFixed(2),
        ivaPercent: (ivaPct_store === null) ? null : +Number(ivaPct_store),
        ivaUSD: (ivaUSD_store === null) ? null : +Number(ivaUSD_store).toFixed(2),
        extrasUSD: (extrasR.store === null) ? null : +Number(extrasR.store).toFixed(2),
        fxRate: null
      };

      // TC asociado (para auditoría/recalcular estado)
      const fxRate =
        payload?.fxRate && Number.isFinite(Number(payload.fxRate)) && Number(payload.fxRate) > 0
          ? Number(payload.fxRate)
          : await resolveFxRateForReservation(before, null);

      try {
        const pays    = Array.isArray(before.payments) ? before.payments : [];
        const paidUSD = computePaidUSD(pays);
        update.payment_status = paidUSD >= toPayUSD ? 'paid' : (paidUSD > 0 ? 'partial' : 'unpaid');
        update.toPay_breakdown.fxRate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : null;

        historyPayload.toPay = {
          baseUSD, ivaUSD,
          ivaPercent: (ivaPct_store === null) ? null : +Number(ivaPct_store),
          extrasUSD, toPayUSD,
          fxRate: update.toPay_breakdown.fxRate,
          cleaningUSD_compat: ('cleaningUSD' in payload)
            ? (payload.cleaningUSD === '' ? null : Number(payload.cleaningUSD))
            : null
        };
      } catch {
        update.payment_status = before.payment_status || 'unpaid';
        historyPayload.toPay = {
          baseUSD, ivaUSD,
          ivaPercent: (ivaPct_store === null) ? null : +Number(ivaPct_store),
          extrasUSD, toPayUSD,
          fxRate: null,
          cleaningUSD_compat: ('cleaningUSD' in payload)
            ? (payload.cleaningUSD === '' ? null : Number(payload.cleaningUSD))
            : null
        };
      }

    } else {
      return bad(res, 400, `Acción no soportada: ${action}`);
    }

    // Hash + batch write + historial
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

// ---- helpers de diff --------------------------------------------------------
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
