// /api/dolarByDate.js
// Trae y PERSISTE cotizaciones del dólar desde ArgentinaDatos.
// Esquema Firestore: cotizaciones / USD / {yyyy} / {mm} / {dd} (doc "cot")

import { DateTime, Interval } from "luxon";
import { firestore, FieldValue } from "../lib/firebaseAdmin.js";

const log = (...xs) => console.log("[DolarByDate]", ...xs);

// Host correcto de ArgentinaDatos:
const BASE =
  process.env.BASE_URL_DOLARAPI ||
  "https://api.argentinadatos.com/v1/cotizaciones/dolares";

const TZ = "America/Argentina/Buenos_Aires";

function ok(res, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
  return res.status(200).json(data);
}
function bad(res, code, error, extra) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(code).json({ error, ...(extra || {}) });
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

/** Llama a casa/fecha; si 404, pide histórico por casa y filtra por fecha; opcional fallback previous */
async function fetchQuote(casa, isoDate, fallbackPrevious = false) {
  const fechaPath = DateTime.fromISO(isoDate, { zone: TZ }).toFormat("yyyy/MM/dd");
  const urlByDate = `${BASE}/${encodeURIComponent(casa)}/${fechaPath}`;
  log("Fetch by date:", urlByDate);

  let r = await fetch(urlByDate, { headers: { accept: "application/json" } });
  if (r.ok) return await r.json();

  if (r.status !== 404) {
    const body = await r.text();
    throw new Error(`Upstream error ${r.status}: ${body.slice(0, 200)}`);
  }

  // Fallback histórico
  const urlHist = `${BASE}/${encodeURIComponent(casa)}`;
  log("Fetch historical:", urlHist);
  const rh = await fetch(urlHist, { headers: { accept: "application/json" } });
  if (!rh.ok) throw new Error(`Hist error ${rh.status}`);
  const arr = await rh.json();

  if (Array.isArray(arr)) {
    let found = arr.find((x) => x?.fecha === isoDate);
    if (!found && fallbackPrevious) {
      // último día hábil anterior
      found = arr
        .filter((x) => x?.fecha && x.fecha < isoDate)
        .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))[0];
      if (found) found.fallback = "previous";
    }
    if (found) return found;
  }
  return null;
}

/** Persiste en Firestore: cotizaciones / USD / yyyy / mm / dd / cot */
async function saveToFirestoreUSD(isoDate, quote, force = false) {
  const dt = DateTime.fromISO(isoDate, { zone: TZ });
  const yyyy = dt.toFormat("yyyy");
  const mm = dt.toFormat("MM");
  const dd = dt.toFormat("dd");

  const base = firestore.collection("cotizaciones").doc("USD");
  const ref = base.collection(yyyy).doc(mm).collection(dd).doc("cot");

  const snap = await ref.get();
  const exists = snap.exists;

  const payload = {
    fecha: quote?.fecha ?? isoDate,
    casa: (quote?.casa || "oficial").toString().toLowerCase(),
    moneda: quote?.moneda || "USD",
    compra: Number(quote?.compra ?? null),
    venta: Number(quote?.venta ?? null),
    fuente: "api.argentinadatos.com",
    updatedAt: FieldValue.serverTimestamp(),
    ...(exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    ...(quote?.fallback ? { fallback: quote.fallback } : {}),
  };

  if (!exists || force) {
    await ref.set(payload, { merge: true });
    return { path: `cotizaciones/USD/${yyyy}/${mm}/${dd}/cot`, upserted: true };
  } else {
    // si existe y no es force, solo merge si hay cambios relevantes
    await ref.set(payload, { merge: true });
    return { path: `cotizaciones/USD/${yyyy}/${mm}/${dd}/cot`, upserted: false };
  }
}

/** Procesa una fecha: consulta, guarda y devuelve resumen */
async function processDate({ casa, isoDate, force, fallbackPrevious }) {
  const quote = await fetchQuote(casa, isoDate, fallbackPrevious);
  if (!quote) {
    log("No data for", casa, isoDate);
    return { date: isoDate, casa, status: "not_found" };
  }
  const saved = await saveToFirestoreUSD(isoDate, quote, force);
  log("Saved", saved.path, { compra: quote.compra, venta: quote.venta });
  return {
    date: isoDate,
    casa,
    status: "ok",
    compra: quote.compra,
    venta: quote.venta,
    fallback: quote.fallback || null,
    saved,
  };
}

export default async function handler(req, res) {
  try {
    const {
      // modos
      fecha,          // modo single
      lastDays,       // ej: 3
      from, to,       // modo rango
      // opciones
      casa = "oficial",
      force = "false",
      compact = "true",
      fallback = "none", // "none" | "previous"
    } = req.query;

    const _force = String(force).toLowerCase() === "true";
    const fallbackPrevious = String(fallback).toLowerCase() === "previous";

    // ----- Resolver fechas a procesar -----
    let dates = [];
    if (lastDays) {
      const n = Math.max(1, Math.min(31, parseInt(lastDays, 10) || 3));
      const today = DateTime.now().setZone(TZ).startOf("day");
      for (let i = 0; i < n; i++) dates.push(today.minus({ days: i }).toISODate());
      dates.sort(); // asc
    } else if (from && to) {
      dates = datesBetween(from, to);
    } else if (fecha) {
      dates = [DateTime.fromISO(fecha, { zone: TZ }).toISODate()];
    } else {
      return bad(res, 400, "Falta 'fecha' o 'lastDays' o 'from'+'to'");
    }

    log("INIT", { mode: lastDays ? "lastDays" : from && to ? "range" : "single", casa, dates, force: _force, fallback });

    // ----- Procesar (batch secuencial simple) -----
    const results = [];
    for (const d of dates) {
      try {
        results.push(await processDate({ casa, isoDate: d, force: _force, fallbackPrevious }));
      } catch (e) {
        log("ERR process", d, e.message);
        results.push({ date: d, casa, status: "error", error: e.message });
      }
    }

    // ----- Respuesta -----
    const summary = {
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
  } catch (err) {
    log("FATAL", err?.message);
    return bad(res, 500, "unexpected", { message: err?.message });
  }
}

