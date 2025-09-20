// /api/enrichWubookData.js 
// OBJETIVO: Enriquecer y sincronizar datos de reservas desde WuBook.
// MODOS:
// 1. 'pending': Procesa reservas nuevas (enrichmentStatus: 'pending'). Es el modo por defecto.
// 2. 'active': Resincroniza reservas activas (aquellas cuyo check-out aún no ha ocurrido).
// 3. 'forceUpdate' (flag): Fuerza la actualización de un lote, ignorando cualquier estado.
//
// ✅ Alineado de FECHAS/TZ y logs:
// - Para filtrar "activas" se usa hoy en 'America/Argentina/Buenos_Aires' (Luxon), no UTC del server.
// - Se agrega `propiedad_id` al contexto del historial.
// - Se mantiene `serverTimestamp()` para marcas temporales del lado de Firestore.

import axios from 'axios';
import qs from 'qs';
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';
import { DateTime } from 'luxon';

// ===================== CONFIGURACIÓN Y UTILIDADES =====================
const log = (...args) => console.log('[EnrichWubook]', ...args);

// URLs de WuBook
const BASE_URL_KP = process.env.WUBOOK_BASE_URL || 'https://kapi.wubook.net/kp';
const BASE_URL_KAPI = process.env.WUBOOK_BASE_URL_KAPI || 'https://kapi.wubook.net/kapi'; //<------MODIFIQUE SOLAMENTE EL URL KAPI

const apiKeyCache = new Map();

// --- Helpers de Diff y Hash (para el historial) ---
const IGNORE_KEYS = new Set(['updatedAt', 'createdAt', 'contentHash', 'enrichmentStatus', 'enrichedAt', 'lastUpdatedAt', 'lastUpdatedBy']);
const sortObject = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortObject(obj[k]);
      return acc;
    }, {});
  }
  return obj;
};
const stableStringify = (obj) => JSON.stringify(sortObject(obj));
const stripKeys = (obj, ignore = IGNORE_KEYS) => {
  const out = {};
  for (const k of Object.keys(obj || {})) if (!ignore.has(k)) out[k] = obj[k];
  return out;
};
const hashDoc = (doc) =>
  crypto.createHash('sha1').update(stableStringify(stripKeys(doc))).digest('hex');

// --- Helper para comparar objetos (para el historial) ---
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

// ===================== TIMEZONE CONSISTENTE =====================
const TZ = 'America/Argentina/Buenos_Aires';

// ===================== HELPERS DE API WUBOOK =====================
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
  if (!bookerId || !/^\d+$/.test(String(bookerId))) {
    return { nombre_huesped: String(bookerId) };
  }
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

// ===================== HANDLER PRINCIPAL =====================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // Añadimos syncMode, con 'pending' como valor por defecto.
    const { limit = 10, dryRun = false, forceUpdate = false, reservationId = null, syncMode = 'pending' } = req.body;
    log('INIT', { limit, dryRun, forceUpdate, reservationId, syncMode });

    let query = firestore.collection('Reservas');

    if (reservationId) {
      // Prioridad 1: si se especifica un ID, se procesa solo esa reserva.
      query = query.where(firestore.FieldPath.documentId(), '==', reservationId);
    } else if (forceUpdate) {
      // Prioridad 2: forceUpdate ignora todo y procesa un lote.
      log('Mode: forceUpdate');
      // No se añade ningún 'where', tomará cualquier documento.
    } else if (syncMode === 'active') {
      // Prioridad 3: Sincronizar reservas activas.
      log('Mode: syncActive');
      // Usar "hoy" en TZ AR para evitar drifts con UTC del server.
      const today = DateTime.now().setZone(TZ).toISODate(); // 'YYYY-MM-DD'
      query = query.where('departure_iso', '>=', today);
    } else {
      // Modo por defecto: buscar las pendientes de enriquecimiento inicial.
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

      const [customerData, payments, notes] = await Promise.all([
        fetchCustomerData(apiKey, bookerId),
        fetchPayments(apiKey, id_human),
        fetchNotes(apiKey, id_human)
      ]);

      // Construimos el documento "nuevo" con los datos que acabamos de obtener.
      const fetchedData = {
        ...customerData,
        wubook_payments: payments,
        wubook_notes: notes,
      };

      // Comparamos el hash para ver si algo realmente cambió
      const newDocForHash = { ...oldDoc, ...fetchedData };
      const newHash = hashDoc(newDocForHash);

      if (newHash === oldDoc.contentHash) {
        log(`Skipping ${doc.id}, no changes detected (hash match).`);
        continue; // Si no hay cambios, no hacemos nada y pasamos al siguiente.
      }

      // --- Si hubo cambios, preparamos la actualización ---
      const updateData = {
        ...fetchedData,
        enrichmentStatus: 'completed',
        enrichedAt: oldDoc.enrichedAt || FieldValue.serverTimestamp(), // Pone la fecha solo la primera vez
        lastUpdatedBy: 'wubook_sync',
        lastUpdatedAt: FieldValue.serverTimestamp(),
        contentHash: newHash,
      };

      if (dryRun) {
        log(`[DryRun] Would update ${doc.id} because changes were detected.`);
        processedCount++;
        continue;
      }

      // --- Lógica de Historial ---
      const diff = getObjectDiff(
        { ...stripKeys(oldDoc), nombre_huesped: bookerId },
        stripKeys(newDocForHash)
      );
      const changedKeys = Object.keys(diff);

      // 1. Actualización principal
      batch.update(doc.ref, updateData);

      // 2. Registro en la subcolección 'historial' (incluimos propiedad_id en el contexto)
      const histId = `${Date.now()}_sync`;
      const histRef = doc.ref.collection('historial').doc(histId);
      const histDoc = {
        ts: FieldValue.serverTimestamp(),
        source: 'wubook_sync',
        context: { scope: 'sync', mode: syncMode, propiedad_id },
        changeType: 'updated',
        changedKeys,
        diff,
        hashFrom: oldDoc.contentHash || null,
        hashTo: newHash,
        snapshotAfter: { ...oldDoc, ...updateData },
      };
      batch.set(histRef, histDoc);

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
      message: dryRun ? `Simulated sync for ${processedCount} reservations.` : `Successfully synced ${processedCount} reservations. ${reservationsToProcess.size - processedCount} were already up-to-date.`
    });

  } catch (error) {
    log('FATAL ERROR', error.stack);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
