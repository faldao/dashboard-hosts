/**
 * /api/dolarByDate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * PROPÓSITO
 *   Endpoint unificado para obtener y persistir cotizaciones:
 *   - MODO 1 (DIARIO, múltiples monedas): usa https://dolarapi.com/v1/cotizaciones
 *   - MODO 2 (HISTÓRICO USD): usa https://api.argentinadatos.com/v1/cotizaciones/dolares
 *
 * PERSISTENCIA (Firestore)
 *   Esquema: cotizaciones/<MONEDA>/<yyyy>/<mm>/<dd>/cot
 *   Campos guardados: { fecha, casa, moneda, compra, venta, fuente, createdAt, updatedAt, ... }
 *   Observación: para histórico USD se agrega `fallback: "previous"` si aplica.
 *
 * PARÁMETROS DE QUERY
 *   ► Parámetros de modo HISTÓRICO (exclusivo USD):
 *     - fecha=YYYY-MM-DD               → un solo día
 *     - lastDays=N (1..31)             → últimos N días (incluyendo hoy, orden ascendente)
 *     - from=YYYY-MM-DD&to=YYYY-MM-DD  → rango inclusivo
 *     - casa=oficial|blue|bolsa|...    → casa en ArgentinaDatos (por defecto "oficial")
 *     - fallback=previous|none         → si no hay dato exacto, usa el hábil anterior
 *     - force=true|false               → (respetado en persistencia por compat, se mergea siempre)
 *     - compact=true|false             → si es un único día y OK, devuelve objeto plano
 *
 *   ► Parámetros de modo DIARIO (múltiples monedas):
 *     - monedas=USD,EUR,BRL,...        → filtra set (si no se pasa, trae todas las devueltas por DolarApi)
 *     - compact=true|false             → si se filtra a 1 moneda, devuelve objeto plano {moneda, compra, venta, fecha, casa}
 *
 * DETECCIÓN DE MODO
 *   - Si se especifica cualquiera de: fecha | lastDays | (from & to) ⇒ MODO HISTÓRICO USD (ArgentinaDatos)
 *   - Si NO se especifican fechas ⇒ MODO DIARIO (DolarApi.com, varias monedas)
 *
 * RESPUESTAS
 *   - Histórico (resumen):
 *     {
 *       mode: "historical_usd",
 *       fuente: "api.argentinadatos.com",
 *       casa: "oficial",
 *       processed, ok, not_found, errors,
 *       results: [{ date, casa, status: "ok|not_found|error", compra, venta, fallback, saved: {path,...} }]
 *     }
 *   - Histórico (compact=true y 1 fecha válida):
 *     { fuente: "api.argentinadatos.com", casa: "oficial", fecha, compra, venta, fallback, savedPath }
 *
 *   - Diario (resumen):
 *     {
 *       mode: "daily_multi",
 *       source: "dolarapi.com",
 *       count,
 *       results: [{ moneda, casa, fecha, compra, venta, saved: {path,...} }],
 *       index: { [MONEDA]: { compra, venta, fecha, casa } }
 *     }
 *   - Diario (compact=true y monedas=USD):
 *     { fuente: "dolarapi.com", moneda: "USD", compra, venta, fecha, casa }
 *
 * EJEMPLOS
 *   - Diario (todas):              GET /api/dolarByDate
 *   - Diario (algunas):            GET /api/dolarByDate?monedas=USD,EUR,BRL
 *   - Diario (compact 1 moneda):   GET /api/dolarByDate?monedas=USD&compact=true
 *   - Histórico USD un día:        GET /api/dolarByDate?fecha=2025-09-01&casa=oficial&fallback=previous
 *   - Histórico USD últimos 3:     GET /api/dolarByDate?lastDays=3&casa=oficial
 *   - Histórico USD por rango:     GET /api/dolarByDate?from=2025-08-15&to=2025-08-31&casa=oficial
 *
 * NOTAS
 *   - DolarApi.com entrega un array con varias monedas y `fechaActualizacion` (se normaliza a YYYY-MM-DD en TZ AR).
 *   - El histórico por fecha de ArgentinaDatos se implementa solo para USD (como en la versión original).
 *   - Persistencia siempre hace `set(..., {merge:true})` para idempotencia.
 *   - Cache-Control: s-maxage=1800; stale-while-revalidate=600.
 *
 * CRON SUGERIDO
 *   - Diario a las 10:10 (AR): consulta /api/dolarByDate (opcional monedas=USD,EUR,...)
 *   - Relleno de feriados: histórico con fallback=previous para la última fecha hábil.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { DateTime, Interval } from "luxon";
import { firestore, FieldValue } from "../lib/firebaseAdmin.js";

const log = (...xs) => console.log("[Quotes]", ...xs);

const TZ = "America/Argentina/Buenos_Aires";

// --- Fuentes ---
const ARDATOS_BASE =
  process.env.BASE_URL_ARDATOS ||
  "https://api.argentinadatos.com/v1/cotizaciones/dolares";

const DOLARAPI_BASE = 
  process.env.BASE_URL_DOLARAPI ||"https://dolarapi.com/v1";

  // Sanity logs al cargar el módulo
log("ENV", {
  ARDATOS_BASE,
  DOLARAPI_BASE,
});

// ---------- HTTP helpers ----------
function ok(res, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");
  return res.status(200).json(data);
}
function bad(res, code, error, extra) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(code).json({ error, ...(extra || {}) });
}

// ---------- Utilidades de fecha ----------
function toISODateAR(isoOrTs) {
  if (!isoOrTs) return DateTime.now().setZone(TZ).toISODate();
  const d = DateTime.fromISO(String(isoOrTs), { zone: TZ });
  return d.isValid ? d.toISODate() : DateTime.now().setZone(TZ).toISODate();
}

/** Devuelve array de fechas ISO (YYYY-MM-DD) entre from/to inclusive */
function datesBetween(fromISO, toISO) {
  const from = DateTime.fromISO(fromISO, { zone: TZ }).startOf("day");
  const to = DateTime.fromISO(toISO, { zone: TZ }).startOf("day");
  if (!from.isValid || !to.isValid || from > to) return [];
  const days = Math.floor(Interval.fromDateTimes(from, to).length("days"));
  const list = [];
  for (let i = 0; i <= days; i++) list.push(from.plus({ days: i }).toISODate());
  return list;
}

// ---------- Persistencia ----------
async function saveToFirestoreGeneric({ moneda, isoDate, casa, compra, venta, fuente, extra = {} }) {
  const dt = DateTime.fromISO(isoDate, { zone: TZ });
  const yyyy = dt.toFormat("yyyy");
  const mm = dt.toFormat("MM");
  const dd = dt.toFormat("dd");

  const base = firestore.collection("cotizaciones").doc(String(moneda).toUpperCase());
  const ref = base.collection(yyyy).doc(mm).collection(dd).doc("cot");

  const snap = await ref.get();
  const exists = snap.exists;

  const payload = {
    fecha: isoDate,
    casa: (casa || "oficial").toString().toLowerCase(),
    moneda: String(moneda || "USD").toUpperCase(),
    compra: Number.isFinite(Number(compra)) ? Number(compra) : null,
    venta: Number.isFinite(Number(venta)) ? Number(venta) : null,
    fuente,
    updatedAt: FieldValue.serverTimestamp(),
    ...(exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    ...extra,
  };

  await ref.set(payload, { merge: true });
  return { path: `cotizaciones/${String(moneda).toUpperCase()}/${yyyy}/${mm}/${dd}/cot`, upserted: !exists };
}

// ---------- HISTÓRICO USD (ArgentinaDatos) ----------
async function fetchUSDByDate_AD(casa, isoDate) {
  // sanity: si por error ARDATOS_BASE apunta a dolarapi, frená
  if (ARDATOS_BASE.includes("dolarapi.com")) {
    throw new Error(
      `Misconfig: ARDATOS_BASE apunta a dolarapi (${ARDATOS_BASE}). Corrigí BASE_URL_ARDATOS.`
    );
  }
  const fechaPath = DateTime.fromISO(isoDate, { zone: TZ }).toFormat("yyyy/MM/dd");
  const url = `${ARDATOS_BASE}/${encodeURIComponent(casa)}/${fechaPath}`;
  log("fetchUSDByDate_AD →", url);
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (r.ok) return await r.json();
  if (r.status !== 404) {
    const body = await r.text();
    throw new Error(`ArgentinaDatos ${r.status}: ${body.slice(0, 240)}`);
  }
  return null; // 404
}

async function fetchUSDHistoricalFallback_AD(casa, isoDate) {
  if (ARDATOS_BASE.includes("dolarapi.com")) {
    throw new Error(
      `Misconfig: ARDATOS_BASE apunta a dolarapi (${ARDATOS_BASE}). Corrigí BASE_URL_ARDATOS.`
    );
  }
  const url = `${ARDATOS_BASE}/${encodeURIComponent(casa)}`;
  log("fetchUSDHistoricalFallback_AD →", url);
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`ArgentinaDatos hist ${r.status}`);
  const arr = await r.json();
  

  if (!Array.isArray(arr)) return null;

  let found = arr.find((x) => x?.fecha === isoDate);
  if (found) return found;

  // último hábil anterior
  found = arr
    .filter((x) => x?.fecha && x.fecha < isoDate)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))[0];
  return found ? { ...found, fallback: "previous" } : null;
}

async function processUSDHistorical({ isoDate, casa = "oficial", force = false, allowPrev = false }) {
  let q = await fetchUSDByDate_AD(casa, isoDate);
  if (!q && allowPrev) q = await fetchUSDHistoricalFallback_AD(casa, isoDate);
  if (!q) return { date: isoDate, casa, status: "not_found" };

  const saved = await saveToFirestoreGeneric({
    moneda: "USD",
    isoDate,
    casa: q?.casa || casa,
    compra: q?.compra,
    venta: q?.venta,
    fuente: "api.argentinadatos.com",
    extra: q?.fallback ? { fallback: q.fallback } : {},
  });

  return {
    date: isoDate,
    casa,
    status: "ok",
    compra: q?.compra ?? null,
    venta: q?.venta ?? null,
    fallback: q?.fallback || null,
    saved,
  };
}

// ---------- DIARIO (DolarApi.com) ----------
// GET /v1/cotizaciones -> array [{moneda:"USD", casa:"oficial", nombre:"Dólar", compra, venta, fechaActualizacion}, ...]
async function fetchDailyAllFromDolarApi() {
  // sanity inversa: que DOLARAPI_BASE no apunte a ArgentinaDatos
  if (DOLARAPI_BASE.includes("argentinadatos.com")) {
    throw new Error(
      `Misconfig: DOLARAPI_BASE apunta a ArgentinaDatos (${DOLARAPI_BASE}). Corrigí BASE_URL_DOLARAPI.`
    );
  }
  const url = `${DOLARAPI_BASE}/cotizaciones`;
  log("fetchDailyAllFromDolarApi →", url);
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`DolarApi ${r.status}: ${body.slice(0, 240)}`);
  }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Persiste varias monedas del modo diario.
 * - `monedasFilter`: Set con símbolos permitidos (USD,EUR,BRL,CLP,UYU...). Si null -> todas.
 * Devuelve resumen con lo guardado.
 */
async function processDailyAll({ monedasFilter = null }) {
  const items = await fetchDailyAllFromDolarApi();

  const results = [];
  for (const it of items) {
    const symbol = String(it.moneda || "").toUpperCase(); // p.ej. "USD","EUR"
    if (monedasFilter && !monedasFilter.has(symbol)) continue;

    // fechaActualizacion viene ISO con hora Z; nos quedamos con YYYY-MM-DD (AR)
    const isoDate = toISODateAR(it.fechaActualizacion);

    const saved = await saveToFirestoreGeneric({
      moneda: symbol,
      isoDate,
      casa: it.casa || "oficial",
      compra: it.compra,
      venta: it.venta,
      fuente: "dolarapi.com",
      extra: { nombre: it.nombre || null },
    });

    results.push({
      moneda: symbol,
      casa: it.casa || "oficial",
      fecha: isoDate,
      compra: it.compra ?? null,
      venta: it.venta ?? null,
      saved,
    });
  }

  // Construimos un pequeño índice por moneda
  const index = {};
  for (const r of results) {
    index[r.moneda] = { compra: r.compra, venta: r.venta, fecha: r.fecha, casa: r.casa };
  }

  return { source: "dolarapi.com", count: results.length, results, index };
}

// ===================================================
//                   HANDLER
// ===================================================
export default async function handler(req, res) {
  try {
    const {
      // Si especificás fechas -> entra en modo HISTÓRICO USD (ArgentinaDatos)
      fecha,                // YYYY-MM-DD
      lastDays,             // ej 3
      from, to,             // rango
      // Opciones histórico
      casa = "oficial",
      fallback = "none",    // "none" | "previous"
      force = "false",

      // Si NO hay fechas -> entra en modo DIARIO (DolarApi.com)
      // Podés limitar monedas: USD,EUR,BRL,CLP,UYU...
      monedas,              // ej: "USD,EUR"
      compact = "true",
    } = req.query;

    const isHistoricalMode = Boolean(fecha || lastDays || (from && to));
    const allowPrev = String(fallback).toLowerCase() === "previous";
    const _force = String(force).toLowerCase() === "true";

    // ------------------ MODO HISTÓRICO (USD) ------------------
    if (isHistoricalMode) {
      // Resolver fechas a procesar
      let dates = [];
      if (lastDays) {
        const n = Math.max(1, Math.min(31, parseInt(lastDays, 10) || 3));
        const today = DateTime.now().setZone(TZ).startOf("day");
        for (let i = 0; i < n; i++) dates.push(today.minus({ days: i }).toISODate());
        dates.sort(); // asc
      } else if (from && to) {
        dates = datesBetween(from, to);
      } else if (fecha) {
        dates = [toISODateAR(fecha)];
      }

      if (!dates.length) return bad(res, 400, "Fechas inválidas para histórico USD");

      const results = [];
      for (const d of dates) {
        try {
          results.push(await processUSDHistorical({ isoDate: d, casa, force: _force, allowPrev }));
        } catch (e) {
          log("ERR historic", d, e?.message);
          results.push({ date: d, casa, status: "error", error: e?.message || "error" });
        }
      }

      const summary = {
        mode: "historical_usd",
        fuente: "api.argentinadatos.com",
        casa,
        processed: results.length,
        ok: results.filter((r) => r.status === "ok").length,
        not_found: results.filter((r) => r.status === "not_found").length,
        errors: results.filter((r) => r.status === "error").length,
        results,
      };

      if (compact === "true" && results.length === 1 && results[0].status === "ok") {
        const r = results[0];
        return ok(res, {
          fuente: summary.fuente,
          casa,
          fecha: r.date,
          compra: r.compra,
          venta: r.venta,
          fallback: r.fallback || null,
          savedPath: r.saved?.path,
        });
      }
      return ok(res, summary);
    }

    // ------------------ MODO DIARIO (VARIAS MONEDAS) ------------------
    const filter =
      typeof monedas === "string" && monedas.trim().length
        ? new Set(
            monedas
              .split(",")
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean)
          )
        : null;

    const daily = await processDailyAll({ monedasFilter: filter });

    if (compact === "true" && filter && filter.size === 1) {
      const sym = [...filter][0];
      const r = daily.index[sym];
      if (r) return ok(res, { fuente: "dolarapi.com", moneda: sym, ...r });
    }

    return ok(res, { mode: "daily_multi", ...daily });
  } catch (err) {
    log("FATAL", err?.message);
    return bad(res, 500, "unexpected", { message: err?.message });
  }
}



