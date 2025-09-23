// /api/enrichWubookData.js
// OBJETIVO: Enriquecer y sincronizar datos de reservas desde WuBook.
// MODOS: 'pending' | 'active' | forceUpdate
//
// ✅ Notas y Pagos unificados:
// - notes[] es la fuente de verdad (badge source: 'wubook' | 'host')
// - payments[] es la fuente de verdad (source: 'wubook' | 'host')

import axios from 'axios';
import qs from 'qs';
import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';
import { DateTime } from 'luxon';

// ===================== CONFIGURACIÓN =====================
const log = (...args) => console.log('[EnrichWubook]', ...args);
const BASE_URL_KP   = process.env.WUBOOK_BASE_URL      || 'https://kapi.wubook.net/kp';
const BASE_URL_KAPI = process.env.WUBOOK_BASE_URL_KAPI || 'https://kapi.wubook.net/kapi';
const apiKeyCache = new Map();
const TZ = 'America/Argentina/Buenos_Aires';

// ===================== HASH / DIFF HELPERS =====================
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

function getObjectDiff(obj1, obj2) {
  const diff = {};
  const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
  for (const key of allKeys) {
    if (JSON.stringify(obj1[key]) !== JSON.stringify(obj2[key])) {
      diff[key] = { from: obj1[key] ?? null, to: obj2[key] ?? null };
    }
  }
  return diff;
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
    return { nombre_huesped: 'Error al buscar nombre', customer_email: null, customer_phone: null, customer_address: null, customer_city: null, customer_country: null };
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

// ===================== NOTAS: MAP/Dedup =====================
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

// ===================== PAGOS: MAP/Dedup =====================
// Estructura unificada de payment:
// { ts, by, source, wubook_id, amount, currency, method }
function mapWubookPaymentsToUnified(arr = []) {
  return (Array.isArray(arr) ? arr : []).map(p => {
    const amt = Number(p.amount ?? p.total ?? 0);
    return {
      ts: p.created_at || p.date || Timestamp.now(),
      by: 'wubook',
      source: 'wubook',
      wubook_id: p.id ?? null,
      amount: isFinite(amt) ? amt : 0,
      currency: String(p.currency || p.ccy || 'ARS'),
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

// ===================== HANDLER PRINCIPAL =====================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { limit = 10, dryRun = false, forceUpdate = false, reservationId = null, syncMode = 'pending' } = req.body;
    log('INIT', { limit, dryRun, forceUpdate, reservationId, syncMode });

    let query = firestore.collection('Reservas');

    if (reservationId) {
      query = query.where(firestore.FieldPath.documentId(), '==', reservationId);
    } else if (forceUpdate) {
      log('Mode: forceUpdate');
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
      const { propiedad_id, id_human, nombre_huesped: bookerId } = oldDoc;
      if (!propiedad_id || !id_human) continue;

      const apiKey = await getApiKey(propiedad_id);
      if (!apiKey) continue;

      log(`Processing doc ${doc.id} (rcode: ${id_human})...`);

      const [customerData, wubookPaysRaw, wubookNotesRaw] = await Promise.all([
        fetchCustomerData(apiKey, bookerId),
        fetchPayments(apiKey, id_human),
        fetchNotes(apiKey, id_human)
      ]);

      // ======= UNIFICACIÓN DE NOTAS =======
      const unifiedNotesFromWubook = mapWubookNotesToUnified(wubookNotesRaw);
      const existingUnifiedNotes    = Array.isArray(oldDoc.notes) ? oldDoc.notes : [];
      const mergedNotes             = dedupeNotes([...existingUnifiedNotes, ...unifiedNotesFromWubook]);

      // ======= UNIFICACIÓN DE PAGOS =======
      const unifiedPaysFromWubook = mapWubookPaymentsToUnified(wubookPaysRaw);
      const existingUnifiedPays   = Array.isArray(oldDoc.payments) ? oldDoc.payments : [];
      const mergedPayments        = dedupePayments([...existingUnifiedPays, ...unifiedPaysFromWubook]);

      // Construimos el documento "nuevo"
      // (mantenemos wubook_* crudos para debugging transitorio)
      const fetchedData = {
        ...customerData,
        wubook_payments: wubookPaysRaw,
        wubook_notes: wubookNotesRaw,
        notes: mergedNotes,         // ← unificado
        payments: mergedPayments,   // ← unificado
      };

      // Hash con notas/pagos unificados
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

      // --- Historial ---
      const diff = getObjectDiff(
        { ...stripKeys(oldDoc), nombre_huesped: bookerId },
        stripKeys(newDocForHash)
      );
      const changedKeys = Object.keys(diff);

      batch.update(doc.ref, updateData);

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
    log('FATAL ERROR', error.stack);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}


