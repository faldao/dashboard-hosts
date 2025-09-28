// /api/cronOrchestrator.js
// Orquesta en SECUENCIA con logs, métricas de duración y timeouts:
// 1) /api/wubookImportByArrival   (POST { dryRun })
// 2) /api/wubookSyncToday         (POST { dryRun })
// 3) /api/enrichWubookData        (POST { limit:500, dryRun })
// 4) /api/enrichWubookData        (POST { limit:100, dryRun, syncMode:"active" })

const log = (...xs) => console.log("[CronOrchestrator]", ...xs);
const BASE = process.env.PUBLIC_BASE_URL || "https://dashboard-hosts.vercel.app";

// ---- Helpers HTTP ----
function ok(res, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(data);
}
function bad(res, code, error) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(code).json({ error });
}

function ms() { return Date.now(); }
function sleep(t) { return new Promise(r => setTimeout(r, t)); }

// fetch con AbortController + reintentos exponenciales + medición de tiempo
async function postJSON(url, body, {
  retries = 2,
  name = "",
  stepTimeoutMs = 120000, // 2 min por paso
} = {}) {
  const payload = JSON.stringify(body ?? {});
  let attempt = 0, lastErr;
  const started = ms();

  while (attempt <= retries) {
    const tryStart = ms();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), stepTimeoutMs);

    try {
      log(`STEP START ${name || url} (try ${attempt + 1})`);
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      const dur = ms() - tryStart;
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} ${JSON.stringify(data).slice(0,300)}`);

      log(`STEP OK ${name || url} in ${dur}ms`);
      return { ok: true, durationMs: dur, data };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const dur = ms() - tryStart;
      log(`STEP ERR ${name || url} in ${dur}ms → ${e.message}`);

      if (attempt === retries) {
        return { ok: false, durationMs: dur, error: e.message };
      }
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      log(`RETRY ${name || url} in ${backoff}ms`);
      await sleep(backoff);
      attempt++;
    }
  }
  return { ok: false, durationMs: ms() - started, error: lastErr?.message || "unknown" };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return ok(res, { ok: true });
  if (req.method !== "GET" && req.method !== "POST") return bad(res, 405, "Method Not Allowed");

  // ---- Parámetros
  const qDry = String(req.query?.dryRun || "").toLowerCase();
  const bDry = typeof req.body?.dryRun === "boolean" ? req.body.dryRun : undefined;
  const dryRun = bDry !== undefined ? bDry : (qDry === "true");

  const stepTimeoutMs = Number(req.query?.stepTimeoutMs || req.body?.stepTimeoutMs || 120000);
  const totalTimeoutMs = Number(req.query?.totalTimeoutMs || req.body?.totalTimeoutMs || 420000);
  const retries = Number(req.query?.retries || req.body?.retries || 2);

  const startedAt = new Date().toISOString();
  const startedMs = ms();
  log("INIT", { dryRun, BASE, stepTimeoutMs, totalTimeoutMs, retries });

  // Timer de timeout global
  let totalTimedOut = false;
  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    log("TIMEOUT TOTAL alcanzado");
  }, totalTimeoutMs);

  const steps = [
    { name: "wubookImportByArrival", url: `${BASE}/api/wubookImportByArrival`, body: { dryRun } },
    { name: "wubookSyncToday",       url: `${BASE}/api/wubookSyncToday`,       body: { dryRun } },
    { name: "enrichWubookData(500)", url: `${BASE}/api/enrichWubookData`,      body: { limit: 500, dryRun } },
    { name: "enrichWubookData(active)", url: `${BASE}/api/enrichWubookData`,   body: { limit: 100, dryRun, syncMode: "active" } },
  ];

  const results = [];
  try {
    for (const s of steps) {
      if (totalTimedOut) {
        results.push({ name: s.name, ok: false, skipped: true, error: "total_timeout" });
        break;
      }
      const r = await postJSON(s.url, s.body, { name: s.name, stepTimeoutMs, retries });
      results.push({ name: s.name, ...r });
      if (!r.ok) {
        // Si un paso falla, seguimos con la secuencia igualmente (si preferís cortar, hacé break)
        log(`WARN step failed: ${s.name}, continuando con el siguiente...`);
      }
    }
  } catch (err) {
    log("FATAL", err?.message);
    clearTimeout(totalTimer);
    const endedAt = new Date().toISOString();
    const totalDurationMs = ms() - startedMs;
    return bad(res, 500, "unexpected");
  }

  clearTimeout(totalTimer);
  const endedAt = new Date().toISOString();
  const totalDurationMs = ms() - startedMs;

  const summary = {
    ok: results.every(r => r.ok || r.skipped),
    dryRun,
    startedAt,
    endedAt,
    totalDurationMs,
    stepTimeoutMs,
    totalTimeoutMs,
    retries,
    results,
  };

  return ok(res, summary);
}
