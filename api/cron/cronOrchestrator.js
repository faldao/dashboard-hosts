// /api/cronOrchestrator.js
// Orquesta en SECUENCIA con logs, métricas de duración y timeouts:
// 1) /api/wubookImportByArrival   (POST { dryRun })
// 2) /api/wubookSyncToday         (POST { dryRun })
// 3) /api/enrichWubookData        (POST { limit:500, dryRun })
// 4) /api/enrichWubookData        (POST { limit:100, dryRun, syncMode:"active" })

// /api/cronOrchestrator.js
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';

const log = (...xs) => console.log('[CronOrchestrator]', ...xs);

const BASE =
  process.env.PUBLIC_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

if (!BASE) throw new Error('No PUBLIC_BASE_URL/VERCEL_URL available');

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(code).json({ error });
};

const ms = () => Date.now();
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// ---- Firestore mutex (lock) para evitar solapes entre corridas
async function acquireLock({ ttlMs = 5 * 60 * 1000 } = {}) {
  const ref = firestore.collection('locks').doc('cronOrchestrator');
  const now = Date.now();
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const expiresAt = data?.expiresAt || 0;
    if (expiresAt > now) return { ok: false, holder: data?.holder || 'unknown' };
    tx.set(ref, {
      holder: process.env.VERCEL_URL || 'local',
      startedAt: FieldValue.serverTimestamp(),
      expiresAt: now + ttlMs,
    });
    return { ok: true };
  });
}
async function refreshLock({ ttlMs = 5 * 60 * 1000 } = {}) {
  const ref = firestore.collection('locks').doc('cronOrchestrator');
  const now = Date.now();
  await ref.set(
    {
      holder: process.env.VERCEL_URL || 'local',
      refreshedAt: FieldValue.serverTimestamp(),
      expiresAt: now + ttlMs,
    },
    { merge: true }
  );
}
async function releaseLock() {
  const ref = firestore.collection('locks').doc('cronOrchestrator');
  await ref.delete().catch(() => {});
}

// ---- HTTP POST con reintentos y timeout por paso
async function postJSON(url, body, { retries = 2, name = '', stepTimeoutMs = 120000 } = {}) {
  const payload = JSON.stringify(body ?? {});
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    const tryStart = ms();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), stepTimeoutMs);
    try {
      log(`STEP START ${name || url} (try ${attempt + 1})`);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      const dur = ms() - tryStart;
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} ${JSON.stringify(data).slice(0, 300)}`);
      log(`STEP OK ${name || url} in ${dur}ms`);
      return { ok: true, durationMs: dur, data };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const dur = ms() - tryStart;
      log(`STEP ERR ${name || url} in ${dur}ms → ${e.message}`);
      if (attempt === retries) return { ok: false, durationMs: dur, error: e.message };
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
      log(`RETRY ${name || url} in ${backoff}ms`);
      await sleep(backoff);
      attempt++;
    }
  }
  return { ok: false, durationMs: 0, error: lastErr?.message || 'unknown' };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'GET' && req.method !== 'POST') return bad(res, 405, 'Method Not Allowed');

  // Parámetros
  const qDry = String(req.query?.dryRun || '').toLowerCase();
  const bDry = typeof req.body?.dryRun === 'boolean' ? req.body.dryRun : undefined;
  const dryRun = bDry !== undefined ? bDry : qDry === 'true';

  const stepTimeoutMs = Number(req.query?.stepTimeoutMs || req.body?.stepTimeoutMs || 120000);
  const totalTimeoutMs = Number(req.query?.totalTimeoutMs || req.body?.totalTimeoutMs || 420000);
  const retries = Number(req.query?.retries || req.body?.retries || 2);

  const startedAt = new Date().toISOString();
  const startedMs = ms();
  log('INIT', { dryRun, BASE, stepTimeoutMs, totalTimeoutMs, retries });

  // Intentar lock
  const lock = await acquireLock({ ttlMs: totalTimeoutMs + 60_000 });
  if (!lock.ok) return bad(res, 423, 'Another orchestrator is running');

  // Timer de timeout global
  let totalTimedOut = false;
  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    log('TIMEOUT TOTAL alcanzado');
  }, totalTimeoutMs);

  const steps = [
    { name: 'wubookImportByArrival', url: `${BASE}/api/wubookImportByArrival`, body: { dryRun } },
    { name: 'wubookSyncToday', url: `${BASE}/api/wubookSyncToday`, body: { dryRun } },
    { name: 'enrichWubookData(500)', url: `${BASE}/api/enrichWubookData`, body: { limit: 500, dryRun } },
    { name: 'enrichWubookData(active)', url: `${BASE}/api/enrichWubookData`, body: { limit: 100, dryRun, syncMode: 'active' } },
  ];

  const results = [];
  try {
    for (const s of steps) {
      if (totalTimedOut) {
        results.push({ name: s.name, ok: false, skipped: true, error: 'total_timeout' });
        break;
      }
      // refrescar lock entre steps para evitar que expire en corridas largas
      await refreshLock({ ttlMs: totalTimeoutMs + 60_000 });

      const r = await postJSON(s.url, s.body, { name: s.name, stepTimeoutMs, retries });
      results.push({ name: s.name, ...r });

      // Continuar aunque un paso falle (cambio a break si querés cortar en el primero que falle)
      if (!r.ok) log(`WARN step failed: ${s.name}, continúo con el siguiente...`);
    }
  } catch (err) {
    log('FATAL', err?.message);
    clearTimeout(totalTimer);
    await releaseLock();
    return bad(res, 500, 'unexpected');
  }

  clearTimeout(totalTimer);
  const endedAt = new Date().toISOString();
  const totalDurationMs = ms() - startedMs;

  const summary = {
    ok: results.every((r) => r.ok || r.skipped),
    dryRun,
    startedAt,
    endedAt,
    totalDurationMs,
    stepTimeoutMs,
    totalTimeoutMs,
    retries,
    results,
  };

  await releaseLock();
  return ok(res, summary);
}
