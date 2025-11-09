// /api/cron/rescue-link-fx.js
/*
 * ==============================================================================
 * CRON JOB: rescue-link-fx
 * ==============================================================================
 * PROPÓSITO:
 * Este es un endpoint de Vercel Cron Job diseñado para ejecutarse
 * automáticamente (ej. una vez al día).
 *
 * FUNCIONAMIENTO:
 * 1. Determina un rango de fechas (generalmente los últimos 3 días).
 * 2. Construye la URL base del propio sitio (usando VERCEL_URL).
 * 3. Realiza una llamada interna (un POST) al endpoint
 * /api/linkUsdFxToReservations, pasándole el rango de fechas y
 * el AUTH_TOKEN para autenticarse.
 *
 * AUTENTICACIÓN (MODIFICADO):
 * Este endpoint *no* tiene autenticación propia (está "abierto").
 * Se asume que es "seguridad por oscuridad" y que solo Vercel Cron
 * conoce la URL.
 * Sin embargo, *sí* envía el AUTH_TOKEN al endpoint
 * /api/linkUsdFxToReservations, que es el que sí está protegido.
 * ==============================================================================
 */

import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";

export default async function handler(req, res) {
  try {
    // validar método OPTIONS rápido
    if (req.method === "OPTIONS") return res.status(200).end();

    // --- MODIFICACIÓN: Bloque de autenticación de "rescue-link-fx" eliminado ---
    // Este endpoint ahora es "abierto", pero solo llama a un endpoint
    // protegido, al cual le pasa el token.
    console.log("[RescueFX] Endpoint de cron invocado.");

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
    const start = DateTime.fromISO(end, { zone: TZ })
      .minus({ days: 2 })
      .toISODate();

    const body = {
      since: start,
      until: end,
      dryRun: false, // Forzamos la ejecución real
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

    // --- MODIFICACIÓN: Inyectar el token de autenticación ---
    // Le pasamos el token de entorno al header 'Authorization'
    // para la llamada interna a /api/linkUsdFxToReservations.
    if (process.env.AUTH_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.AUTH_TOKEN}`;
      console.log("[RescueFX] Auth token agregado al fetch interno.");
    } else {
      // Si no hay token, la llamada interna probablemente fallará si
      // linkUsdFxToReservations lo requiere.
      console.warn(
        "[RescueFX] AUTH_TOKEN no está definido. La llamada interna puede fallar."
      );
    }

    const url = `${BASE.replace(/\/+$/, "")}/api/linkUsdFxToReservations`;

    console.log("[RescueFX] POST", url, body);
    const resp = await fetch(url, {
      method: "POST",
      headers, // 'headers' ahora contiene el token
      body: JSON.stringify(body),
      // 2 min de timeout “manual”
      signal: AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined,
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // Si el fetch falla (ej. 401 del otro endpoint), lo logueamos
      console.error(
        "[RescueFX] ERROR en fetch interno",
        { status: resp.status, body: data }
      );
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
