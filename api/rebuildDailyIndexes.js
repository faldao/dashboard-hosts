import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";

const ok = (res, data) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(code).json({ error });
};

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return ok(res, { ok: true });
    if (req.method !== "GET") return bad(res, 405, "Método no permitido");

    const now = DateTime.now().setZone(TZ);
    const today = now.toISODate();
    const tomorrow = now.plus({ days: 1 }).toISODate();

    const base = process.env.PUBLIC_BASE_URL || ""; // ej: https://dashboard-hosts.vercel.app
    const urls = [
      `${base}/api/dailyIndex?rebuild=1&date=${today}`,
      `${base}/api/dailyIndex?rebuild=1&date=${tomorrow}`
    ];

    const results = [];
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers: { accept: "application/json" } });
        const j = await r.json().catch(() => ({}));
        results.push({ url: u, status: r.status, ok: r.ok, body: j });
      } catch (e) {
        results.push({ url: u, error: e?.message || "fetch_error" });
      }
    }

    return ok(res, { ok: true, ran: results.length, results });
  } catch (e) {
    return bad(res, 500, e?.message || "Error");
  }
}
