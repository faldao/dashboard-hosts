/**
 * /api/enrichWubookData.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OBJETIVO
 *   Enriquecer y sincronizar datos de reservas desde WuBook sin tocar EXTRAS.
 *   Este endpoint SOLO unifica/actualiza:
 *     • Cliente (nombre y contactos)       ← KP /customers/fetch_one
 *     • Pagos (payments[])                 ← KAPI /payments/get_payments
 *     • Notas (notes[])                    ← KAPI /notes/get_notes
 *   Recalcula `toPay` usando el `toPay_breakdown` existente (incluido su
 *   `extrasUSD` SI YA EXISTE), pero NO crea ni modifica extras.
 *
 *   Adicionalmente, cuando detecta pagos en WuBook que no están registrados
 *   previamente en Firestore, crea documentos individuales en la subcolección
 *   "payments" de la reserva. La creación de estos docs:
 *     - Usa el mismo esquema/criterio que /api/reservationMutations.js
 *     - Evita duplicados usando una clave estable (wubook_id cuando existe,
 *       o una clave construida a partir de ts+amount+currency+method)
 *     - Pone timestamps (FieldValue.serverTimestamp) y guarda el raw original
 *     - Se ejecuta tanto en el flujo de procesamiento por reservationId como
 *       en el batch por query
 *
 * MODOS: 'pending' | 'active' | forceUpdate
 *
 * ✅ Notas y Pagos unificados (fuente de verdad):
 *   - notes[]    (source: 'wubook' | 'host') con dedupe estable
 *   - payments[] (source: 'wubook' | 'host') con dedupe estable
 *
 * ❌ EXTRAS:
 *   - NO carga ni modifica extras[] ni extrasUSD.
 *   - NO llama a KP /reservations/get_extras ni recalcula prorrateos.
 *
 * TOTALES
 *   - `toPay` se recalcula a partir de:
 *       baseUSD + iva (por % o ivaUSD) + extrasUSD (si ya existía)
 *
 * IDEMPOTENCIA
 *   - Se calcula `contentHash` (sha1) para evitar escrituras si no hay cambios.
 *
 * TZ
 *   - Luxon con zona fija 'America/Argentina/Buenos_Aires' para filtros.
 */

import axios from 'axios';
import qs from 'qs';
import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';
import { DateTime } from 'luxon';

// ===================== CONFIG =====================
const log = (...args) => console.log('[EnrichWubook]', ...args);
const BASE_URL_KP   = process.env.WUBOOK_BASE_URL      || 'https://kapi.wubook.net/kp';
const BASE_URL_KAPI = process.env.WUBOOK_BASE_URL_KAPI || 'https://kapi.wubook.net/kapi';
const apiKeyCache = new Map();
const TZ = 'America/Argentina/Buenos_Aires';

// ===================== HASH / DIFF =====================
const IGNORE_KEYS = new Set([
  'updatedAt','createdAt','contentHash','enrichmentStatus',
  'enrichedAt','lastUpdatedAt','lastUpdatedBy'
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

function getObjectDiff(obj1, obj2) {
  const diff = {};
  const allKeys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);
  for (const key of allKeys) {
    if (JSON.stringify(obj1?.[key]) !== JSON.stringify(obj2?.[key])) {
      diff[key] = { from: obj1?.[key] ?? null, to: obj2?.[key] ?? null };
    }
  }
  return diff;
}

// === Helpers para preservar campos editados por host ===
const isNonNull = (v) => v !== undefined && v !== null;
const preserveNonNull = (oldVal, incomingVal) => (isNonNull(oldVal) ? oldVal : incomingVal);

// === helpers numéricos para toPay ===
const numOrZero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Recalcula total a pagar (base + iva + extras). El IVA se aplica SOLO a la base.
 *  NO modifica `extrasUSD`; usa el valor existente en breakdown si está presente. */
function recomputeToPayFrom(breakdown, extrasUSDFinal) {
  const b = numOrZero(breakdown?.baseUSD);
  const ivaPct = numOrNull(breakdown?.ivaPercent);
  let ivaUSD = numOrNull(breakdown?.ivaUSD);
  if (ivaUSD === null && ivaPct !== null && b > 0) {
    ivaUSD = Number((b * ivaPct / 100).toFixed(2));
  }
  const e = numOrZero(extrasUSDFinal);
  const total = Number((b + (ivaUSD || 0) + e).toFixed(2));
  return { total, baseUSD: b, ivaPercent: ivaPct, ivaUSD: (ivaUSD ?? 0), extrasUSD: e };
}

// ===================== API HELPERS =====================
async function getApiKey(propId) {
  if (apiKeyCache.has(propId)) return apiKeyCache.get(propId);
  const snap = await firestore.collection('propiedades').doc(propId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  const apiKey = data?.api_key || data?.integraciones?.wubook_apiKey || data?.integraciones?.wubook?.apiKey;
  if (apiKey) apiKeyCache.set(propId, apiKey);
  return apiKey;
}

async function fetchCustomerData(apiKey, bookerId) {
  if (!bookerId || !/^\d+$/.test(String(bookerId))) return { nombre_huesped: String(bookerId) };
  try {
    const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
    const payload = qs.stringify({ id: bookerId });
    const resp = await axios.post(`${BASE_URL_KP}/customers/fetch_one`, payload, { headers });
    const mainInfo = resp.data?.data?.main_info;
    const contacts = resp.data?.data?.contacts;
    if (!mainInfo) return { nombre_huesped: 'Cliente no encontrado (sin main_info)' };
    const fullName = `${mainInfo.name || ''} ${mainInfo.surname || ''}`.trim() || 'Cliente Anónimo';
    return {
      nombre_huesped: fullName,
      customer_email: contacts?.email || null,
      customer_phone: contacts?.phone || null,
      customer_address: mainInfo?.address || null,
      customer_city: mainInfo?.city || null,
      customer_country: mainInfo?.country || null,
    };
  } catch (error) {
    log(`Error fetching customer ${bookerId}:`, error.response?.data || error.message);
    return {
      nombre_huesped: 'Error al buscar nombre',
      customer_email: null, customer_phone: null,
      customer_address: null, customer_city: null, customer_country: null
    };
  }
}

async function fetchPayments(apiKey, rcode) {
  try {
    const payload = qs.stringify({ rcode });
    const resp = await axios.post(`${BASE_URL_KAPI}/payments/get_payments`, payload, { auth: { username: apiKey, password: '' } });
    return resp.data?.data || [];
  } catch (error) {
    log(`Error fetching payments for rcode ${rcode}:`, error.response?.data || error.message);
    return [];
  }
}

async function fetchNotes(apiKey, rcode) {
  try {
    const payload = qs.stringify({ rcode });
    const resp = await axios.post(`${BASE_URL_KAPI}/notes/get_notes`, payload, { auth: { username: apiKey, password: '' } });
    return resp.data?.data || [];
  } catch (error) {
    log(`Error fetching notes for rcode ${rcode}:`, error.response?.data || error.message);
    return [];
  }
}

// ===================== MAP / DEDUPE =====================
// Notes
function mapWubookNotesToUnified(arr = []) {
  return (Array.isArray(arr) ? arr : []).map(n => ({
    ts: n.created_at || Timestamp.now(),
    by: 'wubook',
    text: String(n.remarks ?? '').trim(),
    source: 'wubook',
    wubook_id: n.id ?? null,
    sent_to_wubook: true,
  })).filter(n => n.text);
}
function dedupeNotes(arr = []) {
  const seen = new Set(); const out = [];
  for (const n of arr) {
    const key = n.wubook_id
      ? `w:${n.wubook_id}`
      : `s:${n.source}|t:${(n.ts?.seconds ?? n.ts?._seconds ?? n.ts ?? '')}|x:${(n.text||'').slice(0,120)}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(n);
  }
  out.sort((a,b) => (a.ts?.seconds ?? a.ts?._seconds ?? 0) - (b.ts?.seconds ?? b.ts?._seconds ?? 0));
  return out;
}

// Payments
function mapWubookPaymentsToUnified(arr = []) {
  return (Array.isArray(arr) ? arr : []).map(p => {
    const amt = Number(p.amount ?? p.total ?? 0);
    return {
      ts: p.created_at || p.date || Timestamp.now(),
      by: 'wubook',
      source: 'wubook',
      wubook_id: p.id ?? null,
      amount: Number.isFinite(amt) ? amt : 0,
      currency: (p.currency || p.ccy || null),   // no asumir USD si falta
      method: String(p.method || p.type || 'unknown')
    };
  }).filter(p => p.amount > 0);
}
function dedupePayments(arr = []) {
  const seen = new Set(); const out = [];
  for (const p of arr) {
    const key = p.wubook_id
      ? `w:${p.wubook_id}`
      : `s:${p.source}|t:${(p.ts?.seconds ?? p.ts?._seconds ?? p.ts ?? '')}|a:${p.amount}|c:${p.currency}|m:${p.method}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  out.sort((a,b) => (a.ts?.seconds ?? a.ts?._seconds ?? 0) - (b.ts?.seconds ?? b.ts?._seconds ?? 0));
  return out;
}

// ===================== HANDLER =====================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { limit = 10, dryRun = false, forceUpdate = false, reservationId = null, syncMode = 'pending' } = req.body;
    log('INIT', { limit, dryRun, forceUpdate, reservationId, syncMode });

    // ---- Si viene reservationId, procesamos ese doc puntual
    if (reservationId) {
      const doc = await firestore.collection('Reservas').doc(String(reservationId)).get();
      if (!doc.exists) {
        return res.status(200).json({ ok: true, message: 'Reservation not found.', processed: 0 });
      }
      const singleOld = doc.data();
      const { propiedad_id, id_human, nombre_huesped: bookerId } = singleOld || {};
      if (!propiedad_id || !id_human) {
        return res.status(200).json({ ok: true, message: 'Doc missing propiedad_id/id_human.', processed: 0 });
      }
      const apiKey = await getApiKey(propiedad_id);
      if (!apiKey) {
        return res.status(200).json({ ok: true, message: 'No apiKey for propiedad.', processed: 0 });
      }

      const [customerData, wubookPaysRaw, wubookNotesRaw] = await Promise.all([
        fetchCustomerData(apiKey, bookerId),
        fetchPayments(apiKey, id_human),
        fetchNotes(apiKey, id_human),
      ]);

      // ======= UNIFICACIÓN =======
      const unifiedNotesFromWubook = mapWubookNotesToUnified(wubookNotesRaw);
      const existingUnifiedNotes   = Array.isArray(singleOld.notes) ? singleOld.notes : [];
      const mergedNotes            = dedupeNotes([...existingUnifiedNotes, ...unifiedNotesFromWubook]);

      const unifiedPaysFromWubook  = mapWubookPaymentsToUnified(wubookPaysRaw);
      const existingUnifiedPays    = Array.isArray(singleOld.payments) ? singleOld.payments : [];
      const mergedPayments         = dedupePayments([...existingUnifiedPays, ...unifiedPaysFromWubook]);

      // ======= TOTAL: NO tocar extras; usar el breakdown existente =======
      const currentBD = singleOld?.toPay_breakdown || {};
      const preservedBD = {
        baseUSD:    preserveNonNull(currentBD.baseUSD,    currentBD.baseUSD ?? null),
        ivaPercent: preserveNonNull(currentBD.ivaPercent, currentBD.ivaPercent ?? null),
        ivaUSD:     preserveNonNull(currentBD.ivaUSD,     currentBD.ivaUSD ?? null),
        // 👇 NO introducir extras nuevos; solo preservar si ya existe
        extrasUSD:  preserveNonNull(currentBD.extrasUSD,  currentBD.extrasUSD ?? null),
        fxRate:     preserveNonNull(currentBD.fxRate,     currentBD.fxRate ?? null),
      };
      const { total: newToPay } = recomputeToPayFrom(preservedBD, preservedBD.extrasUSD);
      const newBreakdown = { ...currentBD, ...preservedBD };

      // 🔹 info de solo lectura para UI (sin extras)
      const wubookOriginal = {
        baseUSD: numOrNull(currentBD?.baseUSD) ?? null,
        ivaPercent: numOrNull(currentBD?.ivaPercent) ?? null,
        ivaUSD: numOrNull(currentBD?.ivaUSD) ?? null,
      };
      const wubook_priceUSD =
        numOrNull(singleOld?.wubook_priceUSD) ??
        numOrNull(singleOld?.wubook_price?.amount) ?? null;

      const fetchedData = {
        ...customerData,
        wubook_payments: wubookPaysRaw,
        wubook_notes: wubookNotesRaw,

        // fuente de verdad unificada
        notes: mergedNotes,
        payments: mergedPayments,

        // operativos (sin tocar extras)
        toPay: newToPay,
        toPay_breakdown: newBreakdown,

        // solo lectura para UI
        wubook_original: wubookOriginal,
        wubook_priceUSD: wubook_priceUSD ?? null,
      };

      const newDocForHash = { ...singleOld, ...fetchedData };
      const newHash = hashDoc(newDocForHash);
      if (newHash === singleOld.contentHash) {
        log(`Skipping ${doc.id}, no changes detected (hash match).`);
        return res.status(200).json({ ok: true, dryRun, processed: 0, totalFound: 1, message: 'Already up-to-date.' });
      }

      const updateData = {
        ...fetchedData,
        enrichmentStatus: 'completed',
        enrichedAt: singleOld.enrichedAt || FieldValue.serverTimestamp(),
        lastUpdatedBy: 'wubook_sync',
        lastUpdatedAt: FieldValue.serverTimestamp(),
        contentHash: newHash,
      };

      if (dryRun) {
        log(`[DryRun] Would update ${doc.id} (changes detected).`);
        return res.status(200).json({ ok: true, dryRun, processed: 1, totalFound: 1, message: 'Simulated.' });
      }

      const diff = getObjectDiff(
        { ...stripKeys(singleOld), nombre_huesped: singleOld?.nombre_huesped },
        stripKeys(newDocForHash)
      );
      const changedKeys = Object.keys(diff);

      const batch = firestore.batch();

      // --- crear docs individuales para pagos nuevos en subcolección "payments"
      const paymentKey = (p) => p.wubook_id
        ? `w:${p.wubook_id}`
        : `s:${(p.ts?.seconds ?? p.ts?._seconds ?? p.ts ?? '')}|a:${p.amount}|c:${p.currency}|m:${p.method}`;
      const existingKeys = new Set((existingUnifiedPays || []).map(paymentKey));
      const newPaymentsFromWubook = (unifiedPaysFromWubook || []).filter(p => !existingKeys.has(paymentKey(p)));
      for (const np of newPaymentsFromWubook) {
        const payDocRef = doc.ref.collection('payments').doc();
        batch.set(payDocRef, {
          ts: np.ts || FieldValue.serverTimestamp(),
          by: np.by || 'wubook',
          byUid: np.byUid || null,
          byEmail: np.byEmail || null,
          source: np.source || 'wubook',
          wubook_id: np.wubook_id || null,
          amount: Number.isFinite(Number(np.amount)) ? Number(np.amount) : 0,
          currency: np.currency || null,
          method: np.method || null,
          concept: np.concept || np.note || null,
          usd_equiv: Number.isFinite(Number(np.usd_equiv)) ? Number(np.usd_equiv) : null,
          fxRateUsed: Number.isFinite(Number(np.fxRateUsed)) ? Number(np.fxRateUsed) : null,
          createdAt: FieldValue.serverTimestamp(),
          raw: np,
        });
      }
      // --- end pagos individuales

      batch.update(doc.ref, updateData);
      const histRef = doc.ref.collection('historial').doc(`${Date.now()}_sync`);
      batch.set(histRef, {
        ts: FieldValue.serverTimestamp(),
        source: 'wubook_sync',
        context: { scope: 'sync', mode: syncMode, propiedad_id },
        changeType: 'updated',
        changedKeys,
        diff,
        hashFrom: singleOld.contentHash || null,
        hashTo: newHash,
        snapshotAfter: { ...singleOld, ...updateData },
      });
      await batch.commit();

      return res.status(200).json({
        ok: true, dryRun, processed: 1, totalFound: 1,
        message: 'Successfully synced 1 reservation (by id).'
      });
    }

    // ---- Query por modo
    let query = firestore.collection('Reservas');
    if (forceUpdate) {
      log('Mode: forceUpdate');
      // sin filtros: procesa lo que devuelva el limit
    } else if (syncMode === 'active') {
      log('Mode: syncActive');
      const today = DateTime.now().setZone(TZ).toISODate();
      query = query.where('departure_iso', '>=', today);
    } else {
      log('Mode: pending (default)');
      query = query.where('enrichmentStatus', '==', 'pending');
    }

    const reservationsToProcess = await query.limit(limit).get();
    if (reservationsToProcess.empty) {
      log('DONE - No reservations found for the selected mode.');
      return res.status(200).json({ ok: true, message: 'No reservations found for the selected mode.', processed: 0 });
    }
    log(`Found ${reservationsToProcess.size} reservations to process.`);

    const batch = firestore.batch();
    let processedCount = 0;

    for (const doc of reservationsToProcess.docs) {
      const oldDoc = doc.data();
      const { propiedad_id, id_human, nombre_huesped: bookerId } = oldDoc || {};
      if (!propiedad_id || !id_human) continue;

      const apiKey = await getApiKey(propiedad_id);
      if (!apiKey) continue;

      log(`Processing doc ${doc.id} (rcode: ${id_human})...`);

      const [customerData, wubookPaysRaw, wubookNotesRaw] = await Promise.all([
        fetchCustomerData(apiKey, bookerId),
        fetchPayments(apiKey, id_human),
        fetchNotes(apiKey, id_human),
      ]);

      // ======= UNIFICACIÓN =======
      const unifiedNotesFromWubook = mapWubookNotesToUnified(wubookNotesRaw);
      const existingUnifiedNotes   = Array.isArray(oldDoc.notes) ? oldDoc.notes : [];
      const mergedNotes            = dedupeNotes([...existingUnifiedNotes, ...unifiedNotesFromWubook]);

      const unifiedPaysFromWubook  = mapWubookPaymentsToUnified(wubookPaysRaw);
      const existingUnifiedPays    = Array.isArray(oldDoc.payments) ? oldDoc.payments : [];
      const mergedPayments         = dedupePayments([...existingUnifiedPays, ...unifiedPaysFromWubook]);

      // ======= TOTAL: NO tocar extras; usar el breakdown existente =======
      const currentBD = oldDoc?.toPay_breakdown || {};
      const preservedBD = {
        baseUSD:    preserveNonNull(currentBD.baseUSD,    currentBD.baseUSD ?? null),
        ivaPercent: preserveNonNull(currentBD.ivaPercent, currentBD.ivaPercent ?? null),
        ivaUSD:     preserveNonNull(currentBD.ivaUSD,     currentBD.ivaUSD ?? null),
        extrasUSD:  preserveNonNull(currentBD.extrasUSD,  currentBD.extrasUSD ?? null),
      };
      const { total: newToPay } = recomputeToPayFrom(preservedBD, preservedBD.extrasUSD);
      const newBreakdown = { ...currentBD, ...preservedBD };

      const wubookOriginal = {
        baseUSD: numOrNull(currentBD?.baseUSD) ?? null,
        ivaPercent: numOrNull(currentBD?.ivaPercent) ?? null,
        ivaUSD: numOrNull(currentBD?.ivaUSD) ?? null,
      };
      const wubook_priceUSD =
        numOrNull(oldDoc?.wubook_priceUSD) ??
        numOrNull(oldDoc?.wubook_price?.amount) ?? null;

      const fetchedData = {
        ...customerData,
        wubook_payments: wubookPaysRaw,
        wubook_notes: wubookNotesRaw,

        // fuente de verdad unificada
        notes: mergedNotes,
        payments: mergedPayments,

        // operativos (sin tocar extras)
        toPay: newToPay,
        toPay_breakdown: newBreakdown,

        // solo lectura para UI
        wubook_original: wubookOriginal,
        wubook_priceUSD: wubook_priceUSD ?? null
      };

      // Evitar updates innecesarios
      const newDocForHash = { ...oldDoc, ...fetchedData };
      const newHash = hashDoc(newDocForHash);
      if (newHash === oldDoc.contentHash) {
        log(`Skipping ${doc.id}, no changes detected (hash match).`);
        continue;
      }

      const updateData = {
        ...fetchedData,
        enrichmentStatus: 'completed',
        enrichedAt: oldDoc.enrichedAt || FieldValue.serverTimestamp(),
        lastUpdatedBy: 'wubook_sync',
        lastUpdatedAt: FieldValue.serverTimestamp(),
        contentHash: newHash,
      };

      if (dryRun) {
        log(`[DryRun] Would update ${doc.id} (changes detected).`);
        processedCount++;
        continue;
      }

      const diff = getObjectDiff(
        { ...stripKeys(oldDoc), nombre_huesped: oldDoc?.nombre_huesped },
        stripKeys(newDocForHash)
      );
      const changedKeys = Object.keys(diff);

      batch.update(doc.ref, updateData);

      // --- crear docs individuales para pagos nuevos en subcolección "payments" (batch global)
      const paymentKey = (p) => p.wubook_id
        ? `w:${p.wubook_id}`
        : `s:${(p.ts?.seconds ?? p.ts?._seconds ?? p.ts ?? '')}|a:${p.amount}|c:${p.currency}|m:${p.method}`;
      const existingKeys = new Set((existingUnifiedPays || []).map(paymentKey));
      const newPaymentsFromWubook = (unifiedPaysFromWubook || []).filter(p => !existingKeys.has(paymentKey(p)));
      for (const np of newPaymentsFromWubook) {
        const payDocRef = doc.ref.collection('payments').doc();
        batch.set(payDocRef, {
          ts: np.ts || FieldValue.serverTimestamp(),
          by: np.by || 'wubook',
          byUid: np.byUid || null,
          byEmail: np.byEmail || null,
          source: np.source || 'wubook',
          wubook_id: np.wubook_id || null,
          amount: Number.isFinite(Number(np.amount)) ? Number(np.amount) : 0,
          currency: np.currency || null,
          method: np.method || null,
          concept: np.concept || np.note || null,
          usd_equiv: Number.isFinite(Number(np.usd_equiv)) ? Number(np.usd_equiv) : null,
          fxRateUsed: Number.isFinite(Number(np.fxRateUsed)) ? Number(np.fxRateUsed) : null,
          createdAt: FieldValue.serverTimestamp(),
          raw: np,
        });
      }
      // --- end pagos individuales

      const histRef = doc.ref.collection('historial').doc(`${Date.now()}_sync`);
      batch.set(histRef, {
        ts: FieldValue.serverTimestamp(),
        source: 'wubook_sync',
        context: { scope: 'sync', mode: syncMode, propiedad_id },
        changeType: 'updated',
        changedKeys,
        diff,
        hashFrom: oldDoc.contentHash || null,
        hashTo: newHash,
        snapshotAfter: { ...oldDoc, ...updateData },
      });

      processedCount++;
    }

    if (!dryRun && processedCount > 0) {
      await batch.commit();
      log(`Batch commit successful for ${processedCount} documents.`);
    } else if (processedCount === 0 && reservationsToProcess.size > 0) {
      log('All processed reservations were up-to-date. No batch commit needed.');
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      processed: processedCount,
      totalFound: reservationsToProcess.size,
      message: dryRun
        ? `Simulated sync for ${processedCount} reservations.`
        : `Successfully synced ${processedCount} reservations. ${reservationsToProcess.size - processedCount} were already up-to-date.`
    });

  } catch (error) {
    log('FATAL ERROR', error?.stack || error?.message);
    return res.status(500).json({ ok: false, error: error?.message || 'Unexpected error' });
  }
}





