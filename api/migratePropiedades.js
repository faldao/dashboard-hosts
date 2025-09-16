// api/migratePropiedades.js
// Migra /propiedades (y su subcolección /departamentos) desde un
// proyecto Firestore ORIGEN a otro DESTINO, ejecutándose en Vercel.
// - DESTINO: se toma de /lib/firebaseAdmin.js (FIREBASE_SERVICE_ACCOUNT_JSON)
// - ORIGEN: se inyecta con env FB_SA_ORIGEN_JSON (JSON completo del service account)
//
// Seguridad: requiere header x-admin-token que matchee MIGRATION_TOKEN (env).
// Paginación: por ID de documento (orderBy(__name__)), usando startAfterId + limit.
// Uso:
//  POST /api/migratePropiedades
//  Body JSON: { "limit": 50, "startAfterId": "<docId>", "propIds": ["100","200"], "dryRun": false }
//  - Si propIds viene, migra solo esas (máx 10 por request si usás where in; aquí iteramos 1x1 para evitar límites).
//  - Devuelve nextStartAfterId si hay más.

import admin from 'firebase-admin';
import { firestore as dbDest } from '../lib/firebaseAdmin.js';

// ===================== LOG =====================
const log = (...args) => console.log('[MigratePropiedades]', ...args);
// ===============================================

// ---- Obtiene Firestore ORIGEN (app nombrada) ----
function getDbOrigen() {
  const raw = process.env.FB_SA_ORIGEN_JSON;
  if (!raw) throw new Error('FB_SA_ORIGEN_JSON no está definida');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    // normaliza private_key con \n si fuese necesario
    const tmp = JSON.parse(raw.replace(/\\n/g, '\n'));
    creds = { ...tmp, private_key: (tmp.private_key || '').replace(/\\n/g, '\n') };
  }

  try {
    return admin.app('origen').firestore();
  } catch (_) {
    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: creds.project_id,
        clientEmail: creds.client_email,
        privateKey: creds.private_key,
      }),
    }, 'origen');
    return app.firestore();
  }
}

// ---- Helpers HTTP ----
function ok(res, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  return res.status(200).json(data);
}
function bad(res, code, error) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  return res.status(code).json({ error });
}

// ---- Copia un doc de propiedad + su subcolección /departamentos ----
async function copyPropWithDeps(dbO, propId, { dryRun }) {
  const propRefO = dbO.collection('propiedades').doc(propId);
  const snap = await propRefO.get();
  if (!snap.exists) return { propId, ok: false, reason: 'no_existe_origen' };

  const data = snap.data();
  log('PROP', propId, '→', data?.nombre || '');

  if (!dryRun) {
    await dbDest.collection('propiedades').doc(propId).set(data, { merge: true });
  }

  // Subcolección departamentos
  const depsSnap = await propRefO.collection('departamentos').get();
  let written = 0;
  if (depsSnap.empty) return { propId, ok: true, deps: 0 };

  // batch en bloques de ~400 para evitar límite de 500 ops
  let batch = dbDest.batch();
  let ops = 0;

  for (const dep of depsSnap.docs) {
    const destRef = dbDest.collection('propiedades').doc(propId).collection('departamentos').doc(dep.id);
    if (!dryRun) batch.set(destRef, dep.data(), { merge: true });
    ops++; written++;
    if (ops >= 400) {
      if (!dryRun) await batch.commit();
      batch = dbDest.batch();
      ops = 0;
    }
  }
  if (ops > 0 && !dryRun) await batch.commit();

  return { propId, ok: true, deps: written };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');

  // auth simple por header
  const token = req.headers['x-admin-token'];
  if (!process.env.MIGRATION_TOKEN || token !== process.env.MIGRATION_TOKEN) {
    return bad(res, 401, 'No autorizado');
  }

  try {
    const { limit = 50, startAfterId = null, propIds = null, dryRun = false } = req.body || {};
    log('INIT', { limit, startAfterId, dryRun, sel: Array.isArray(propIds) ? propIds.length : 0 });

    const dbO = getDbOrigen();

    let processed = [];
    let nextStartAfterId = null;

    if (Array.isArray(propIds) && propIds.length) {
      // Modo “lista cerrada”: copiar solo esos IDs
      for (const id of propIds) {
        const r = await copyPropWithDeps(dbO, id, { dryRun });
        processed.push(r);
      }
    } else {
      // Modo paginado por ID
      let q = dbO.collection('propiedades').orderBy(admin.firestore.FieldPath.documentId()).limit(limit);
      if (startAfterId) q = q.startAfter(startAfterId);
      const snap = await q.get();

      if (snap.empty) {
        return ok(res, { ok: true, processed: 0, items: [], hasMore: false });
      }

      for (const doc of snap.docs) {
        const r = await copyPropWithDeps(dbO, doc.id, { dryRun });
        processed.push(r);
      }

      const last = snap.docs[snap.docs.length - 1];
      nextStartAfterId = last?.id || null;
    }

    const hasMore = nextStartAfterId !== null && !(Array.isArray(propIds) && propIds.length);
    log('DONE', { count: processed.length, nextStartAfterId, hasMore });

    return ok(res, { ok: true, dryRun, items: processed, nextStartAfterId, hasMore });
  } catch (e) {
    log('ERROR', e?.message);
    console.error(e);
    return bad(res, 500, e?.message || 'Error interno');
  }
}
