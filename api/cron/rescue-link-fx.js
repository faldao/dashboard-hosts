// /api/cron/rescue-link-fx.js
// Vercel Scheduled Function: recorre últimos 3 días (AR) y linkea TC.
// Llama a /api/linkUsdFxToReservations con dryRun=false.

// Si preferís setear un dominio fijo, definí RESCUE_BASE_URL en Vercel.
// Si no, usamos VERCEL_URL (preview/prod) y le agregamos https://

import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";

export default async function handler(req, res) {
  try {
    // Construcción de base URL
    const BASE =
      process.env.RESCUE_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

    if (!BASE) {
      return res
        .status(500)
        .json({ error: "No RESCUE_BASE_URL/VERCEL_URL available" });
    }

    // Rango: hoy (AR) y 2 días atrás
    const end = DateTime.now().setZone(TZ).toISODate();
    const start = DateTime.fromISO(end, { zone: TZ }).minus({ days: 2 }).toISODate();

    const body = {
      since: start,
      until: end,
      dryRun: false,
      force: false,
      pageSize: 500,
      // Opcional: limitar por propiedades si defines PROPERTY_IDS="100,101"
      ...(process.env.PROPERTY_IDS
        ? { propertyIds: process.env.PROPERTY_IDS.split(",").map(s => s.trim()).filter(Boolean) }
        : {}),
    };

    const headers = { "Content-Type": "application/json" };
    //if (process.env.AUTH_TOKEN) headers["Authorization"] = `Bearer ${process.env.AUTH_TOKEN}`;

    const url = `${BASE.replace(/\/+$/, "")}/api/linkUsdFxToReservations`;

    console.log("[RescueFX] POST", url, body);
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // 2 min de timeout “manual”
      signal: AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined,
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error("[RescueFX] ERROR", resp.status, data);
      return res.status(resp.status).json({ ok: false, data });
    }

    console.log("[RescueFX] OK", {
      range: data?.range,
      totals: data?.totals,
      dryRun: data?.dryRun,
      force: data?.force,
      lastQuoteDate: data?.lastQuoteDate,
    });

    return res.status(200).json({ ok: true, ...data });
  } catch (err) {
    console.error("[RescueFX] FATAL", err?.message);
    return res.status(500).json({ ok: false, error: err?.message || "Internal error" });
  }
}
