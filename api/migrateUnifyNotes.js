// /api/migrateUnifyNotes.js
// OBJETIVO: Unificar notas existentes (host_notes y wubook_notes) en notes[].
// Uso (una sola vez por lote):
//   POST /api/migrateUnifyNotes
//   body:
//     {
//       "limit": 500,                 // opcional (default 200)
//       "dryRun": false,              // opcional: si true, no escribe
//       "reservationId": "docId",     // opcional: migra sólo esa reserva
//       "deleteWubookRaw": false      // opcional: si true, borra wubook_notes crudas
//     }

import { firestore, FieldValue, Timestamp } from '../lib/firebaseAdmin.js';
import crypto from 'crypto';

const log = (...args) => console.log('[MigrateNotes]', ...args);

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

function computeDiff(a = {}, b = {}) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k]; const bv = b[k];
    if (stableStringify(av) !== stableStringify(bv)) out[k] = { from: av === undefined ? null : av, to: bv === undefined ? null : bv };
  }
  return out;
}

// ---- mapeos a formato unificado ----
function mapUnified(arr = []) {
  // Ya vienen unificadas
  return (Array.isArray(arr) ? arr : [])
    .map(n => ({
      ts: n.ts || Timestamp.now(),
      by: n.by || n.source || 'host',
      text: String(n.text ?? '').trim(),
      source: n.source || 'host',
      wubook_id: n.wubook_id ?? null,
      sent_to_wubook: !!n.sent_to_wubook,
    }))
    .filter(n => n.text);
}
function mapHostNotes(arr = []) {
  return (Array.isArray(arr) ? arr : [])
    .map(n => ({
      ts: n.ts || Timestamp.now(),
      by: n.by || 'host',
      text: String(n.text ?? '').trim(),
      source: 'host',
      wubook_id: null,
      sent_to_wubook: !!n.sent_to_wubook,
    }))
    .filter(n => n.text);
}
function mapWubookRaw(arr = []) {
  // WuBook crudo: { id, remarks, created_at? }
  return (Array.isArray(arr) ? arr : [])
    .map(n => ({
      ts: n.created_at || Timestamp.now(),
      by: 'wubook',
      text: String(n.remarks ?? '').trim(),
      source: 'wubook',
      wubook_id: n.id ?? null,
      sent_to_wubook: true,
    }))
    .filter(n => n.text);
}
function dedupeNotes(arr = []) {
  const seen = new Set(); const out = [];
  for (const n of arr) {
    const key = n.wubook_id
      ? `w:${n.wubook_id}`
      : `s:${n.source}|t:${(n.ts?.seconds ?? n.ts?._seconds ?? n.ts ?? '')}|x:${(n.text||'').slice(0,160)}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(n);
  }
  // Ordenar por ts ASC
  out.sort((a,b) => {
    const sa = (a.ts?.seconds ?? a.ts?._seconds ?? 0);
    const sb = (b.ts?.seconds ?? b.ts?._seconds ?? 0);
    return sa - sb;
  });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const {
      limit = 200,
      dryRun = false,
      reservationId = null,
      deleteWubookRaw = false
    } = req.body || {};

    let query = firestore.collection('Reservas');
    if (reservationId) {
      query = query.where(firestore.FieldPath.documentId(), '==', reservationId);
    }

    const snap = await query.limit(limit).get();
    if (snap.empty) return res.status(200).json({ ok: true, processed: 0, message: 'No documents found' });

    let processed = 0;
    const batch = firestore.batch();

    for (const doc of snap.docs) {
      const before = doc.data();

      const unifiedExisting = mapUnified(before.notes);
      const hostLegacy = mapHostNotes(before.host_notes);
      const wubookLegacy = mapWubookRaw(before.wubook_notes);

      const merged = dedupeNotes([...unifiedExisting, ...hostLegacy, ...wubookLegacy]);

      // Si no hay cambios, skip
      const afterPreview = { ...before, notes: merged };
      if (!deleteWubookRaw) afterPreview.wubook_notes = before.wubook_notes;

      const newHash = hashDoc(afterPreview);
      if (newHash === before.contentHash) continue;

      if (dryRun) {
        processed++;
        continue;
      }

      const update = {
        notes: merged,
        lastUpdatedBy: 'notes_migration',
        lastUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        contentHash: newHash,
      };
      // borrar host_notes
      update.host_notes = FieldValue.delete();
      // opcionalmente borrar wubook_notes
      if (deleteWubookRaw) update.wubook_notes = FieldValue.delete();

      batch.update(doc.ref, update);

      const histRef = doc.ref.collection('historial').doc(`${Date.now()}_migrate_notes`);
      const diff = computeDiff(stripKeys(before), stripKeys(afterPreview));
      batch.set(histRef, {
        ts: FieldValue.serverTimestamp(),
        source: 'notes_migration',
        context: { deleteWubookRaw },
        changeType: 'updated',
        changedKeys: Object.keys(diff),
        diff,
        hashFrom: before.contentHash || null,
        hashTo: newHash,
      });

      processed++;
    }

    if (!dryRun && processed > 0) await batch.commit();

    return res.status(200).json({
      ok: true,
      processed,
      dryRun,
      message: dryRun
        ? `Simulated migration for ${processed} docs.`
        : `Migrated ${processed} docs successfully.`
    });
  } catch (e) {
    log('ERROR', e);
    return res.status(500).json({ ok:false, error: e.message || 'Internal error' });
  }
}
