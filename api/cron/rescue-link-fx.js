/*
 * ==============================================================================
 * CRON JOB: rescue-link-fx
 * ==============================================================================
 * PROPÓSITO:
 *   Ejecuta un POST interno a /api/linkUsdFxToReservations con rango chico,
 *   pasando el AUTH_TOKEN si existe. Pensado para correr por Vercel Cron.
 *
 * POLÍTICA:
 * - Este endpoint está "abierto" (sin auth propia).
 * - Si existe AUTH_TOKEN en env, se envía como Authorization: Bearer <token>.
 * - Si no existe, se llama igual (el endpoint protegido permite sin token en dev/preview).
 * ==============================================================================
 */

import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return res.status(200).end();

    console.log("[RescueFX] Endpoint de cron invocado.");

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
    const start = DateTime.fromISO(end, { zone: TZ })
      .minus({ days: 2 })
      .toISODate();

    const body = {
      since: start,
      until: end,
      dryRun: false, // ejecuta real
      force: false,
      pageSize: 500,
      ...(process.env.PROPERTY_IDS
        ? {
            propertyIds: process.env.PROPERTY_IDS.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
    };

    const headers = { "Content-Type": "application/json" };

    // AUTH_TOKEN no se usa: no enviamos Authorization en el fetch interno
    console.log("[RescueFX] AUTH_TOKEN no se enviará en la llamada interna (deshabilitado).");

    const url = `${BASE.replace(/\/+$/, "")}/api/linkUsdFxToReservations`;

    console.log("[RescueFX] POST", url, body);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), 120000);

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    }).catch((e) => {
      console.error("[RescueFX] FETCH THROW", e?.message);
      throw e;
    });

    clearTimeout(timeout);

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error("[RescueFX] ERROR en fetch interno", {
        status: resp.status,
        body: data,
      });
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
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Internal error" });
  }
}

