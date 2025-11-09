/**
 * /api/linkUsdFxToReservations.js
 * ──────────────────────────────────────────────────────────────────────────────
 * PROPÓSITO
 *   Proceso INDEPENDIENTE que "linkea" (anota) la cotización USD del día de
 *   check-in en cada documento de la colección `Reservas`.
 *
 *   La fuente NO es una API externa, sino las cotizaciones ya persistidas en
 *   Firestore por tu endpoint de cotizaciones:
 *     cotizaciones / USD / yyyy / mm / dd / cot
 *
 *   Para cada reserva con `arrival_iso == YYYY-MM-DD`, se escribe:
 *     usd_fx_on_checkin: {
 *       casa, fecha, compra, venta,
 *       fuente,             // "cotizaciones:firestore" o "cotizaciones:firestore:fallback"
 *       origen_fecha,       // fecha real de la cotización usada (puede diferir de fecha check-in)
 *       setAt: serverTimestamp()
 *     }
 *
 *   Solo se escribe si el campo NO existe (idempotente) o si `force=true`.
 *
 * FUNCIONALIDAD ADICIONAL
 *   - Si para el día de hoy no hay cotización en Firestore y ya pasaron las
 *     10:10 AM (hora AR), se usa la última cotización previa encontrada.
 *     En ese caso:
 *       • fuente = "cotizaciones:firestore:fallback"
 *       • origen_fecha = fecha de la cotización efectivamente usada
 *     Esto evita que reservas con check-in hoy queden sin tipo de cambio.
 *
 * ESTRATEGIA GENERAL
 *   1) Consulta/usa un meta de progreso: `cotizaciones_meta / USD`
 *        { lastQuoteDate: "YYYY-MM-DD", lastLinkedDate: "YYYY-MM-DD" }
 *
 *   2) Determina un rango a procesar (según params o meta).
 *
 *   3) Para cada fecha del rango:
 *        • Si hay cotización → se usa.
 *        • Si es HOY y no hay cotización y ya pasaron las 10:10 AR →
 *             se busca la última cotización previa y se usa como fallback.
 *        • Si no hay cotización ni fallback → marca `no_quote`.
 *
 *   4) Actualiza `usd_fx_on_checkin` en reservas, respetando `force`/`dryRun`.
 *
 *   5) Al finalizar, si `dryRun=false`, actualiza `cotizaciones_meta/USD.lastLinkedDate = end`.
 *
 * PARÁMETROS (query o body, GET/POST)
 *   - since=YYYY-MM-DD       Inicio del rango (opcional)
 *   - until=YYYY-MM-DD       Fin del rango (opcional, default: hoy)
 *   - propertyIds=100,101    Filtro opcional de propiedades
 *   - force=true|false       Reescribe aunque ya exista (default: false)
 *   - dryRun=true|false      No escribe, solo simula (default: true)
 *   - pageSize=500           Lecturas por página (50..1000)
 *   - backfillDays=7         Backfill inicial si no hay lastLinkedDate (0..60)
 *
 * RESPUESTA (resumen)
 *   {
 *     ok: true,
 *     dryRun, force,
 *     range: { start, end },
 *     lastQuoteDate,
 *     lastLinkedDateBefore,
 *     propertyIdsCount,
 *     totals: { dates, updated, matched, skippedExisting, no_quote_days },
 *     perDate: [ { date, status, matched?, skippedExisting?, updated? } ]
 *   }
 *
 * CRON SUGERIDO
 *   - Diario 10:15 AR (después de persistir cotizaciones)
 *   - Refuerzo opcional 13:15 AR.
 *
 * NOTAS
 *   - Este proceso NO genera nuevas cotizaciones; solo linkea desde Firestore.
 *   - Incluye fallback automático después de 10:10 AR si falta cotización del día.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { firestore, FieldValue } from "../lib/firebaseAdmin.js";
import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";
const stamp = () => DateTime.now().setZone(TZ).toISO();
const LOGP = "LinkFX";

const log = (msg, extra = {}) =>
  console.log(`[${LOGP}] ${stamp()} ${msg}`, Object.keys(extra).length ? extra : "");
const warn = (msg, extra = {}) =>
  console.warn(`[${LOGP}] ${stamp()} ${msg}`, Object.keys(extra).length ? extra : "");
const err = (msg, extra = {}) =>
  console.error(`[${LOGP}] ${stamp()} ${msg}`, Object.keys(extra).length ? extra : "");

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function ok(res, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(200).json(data);
}
function bad(res, code, error) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(code).json({ error });
}

// ── Utils de fecha ───────────────────────────────────────────────────────────
const toISO = (s) => {
  const d = DateTime.fromISO(String(s || ""), { zone: TZ });
  return d.isValid ? d.toISODate() : null;
};

// ── Lectura de cotización ────────────────────────────────────────────────────
async function getQuoteDoc(dateISO) {
  const d = DateTime.fromISO(dateISO, { zone: TZ });
  const yyyy = d.toFormat("yyyy");
  const mm = d.toFormat("MM");
  const dd = d.toFormat("dd");
  const ref = firestore
    .collection("cotizaciones").doc("USD")
    .collection(yyyy).doc(mm)
    .collection(dd).doc("cot");
  const snap = await ref.get();
  return snap.exists ? { id: ref.path, _sourceDate: dateISO, ...snap.data() } : null;
}

async function findLastQuoteDateFromFirestore(maxLookbackDays = 365) {
  for (let i = 0; i <= maxLookbackDays; i++) {
    const d = DateTime.now().setZone(TZ).minus({ days: i }).toISODate();
    const q = await getQuoteDoc(d);
    if (q && Number.isFinite(Number(q.venta))) return d;
  }
  return null;
}

// busca cotización previa a una fecha
async function findPrevQuoteDate(beforeISO, maxLookbackDays = 7) {
  const start = DateTime.fromISO(beforeISO, { zone: TZ });
  for (let i = 1; i <= maxLookbackDays; i++) {
    const d = start.minus({ days: i }).toISODate();
    const q = await getQuoteDoc(d);
    if (q && Number.isFinite(Number(q.venta))) return d;
  }
  return null;
}

// ── Meta ─────────────────────────────────────────────────────────────────────
async function readMeta() {
  const ref = firestore.collection("cotizaciones_meta").doc("USD");
  const snap = await ref.get();
  return snap.exists ? { ref, data: snap.data() || {} } : { ref, data: {} };
}
async function writeMeta(update) {
  const { ref } = await readMeta();
  await ref.set(
    { ...update, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ── Iterador de fechas ──────────────────────────────────────────────────────
function* dateRangeIterator(startISO, endISO) {
  let d = DateTime.fromISO(startISO, { zone: TZ }).startOf("day");
  const end = DateTime.fromISO(endISO, { zone: TZ }).startOf("day");
  while (d <= end) {
    yield d.toISODate();
    d = d.plus({ days: 1 });
  }
}

// ── Actualiza reservas ──────────────────────────────────────────────────────
async function updateReservationsForDate({
  dateISO,
  quote,
  propertyIds,
  force,
  dryRun,
  pageSize = 500,
  usedFallback = false,
  fallbackFrom = null,
}) {
  log("DATE_START", { dateISO, usedFallback, fallbackFrom });

  const baseQuery = firestore.collection("Reservas").where("arrival_iso", "==", dateISO);

  const chunks = [];
  if (Array.isArray(propertyIds) && propertyIds.length > 0) {
    for (let i = 0; i < propertyIds.length; i += 10)
      chunks.push(propertyIds.slice(i, i + 10));
  } else chunks.push(null);

  let matched = 0, skippedExisting = 0, updated = 0;

  for (const sub of chunks) {
    let q = baseQuery;
    if (Array.isArray(sub)) q = q.where("propiedad_id", "in", sub);

    let cursor = null;
    while (true) {
      let qry = q.limit(pageSize);
      if (cursor) qry = qry.startAfter(cursor);

      const snap = await qry.get();
      if (snap.empty) break;

      let batch = firestore.batch(), ops = 0;

      for (const doc of snap.docs) {
        matched++;
        const d = doc.data() || {};
        if (d.usd_fx_on_checkin && !force) { skippedExisting++; continue; }
        if (dryRun) { updated++; continue; }

        const payload = {
          usd_fx_on_checkin: {
            casa: (quote.casa || "oficial").toString().toLowerCase(),
            fecha: dateISO,
            compra: Number.isFinite(Number(quote.compra)) ? Number(quote.compra) : null,
            venta:  Number.isFinite(Number(quote.venta))  ? Number(quote.venta)  : null,
            fuente: usedFallback ? "cotizaciones:firestore:fallback" : "cotizaciones:firestore",
            origen_fecha: quote._sourceDate || fallbackFrom || dateISO,
            setAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        };

        batch.set(doc.ref, payload, { merge: true });
        ops++; updated++;

        if (ops >= 450) { await batch.commit(); batch = firestore.batch(); ops = 0; }
      }
      if (!dryRun && ops > 0) await batch.commit();

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }
  }

  log("DATE_DONE", { dateISO, matched, skippedExisting, updated });
  return { dateISO, matched, skippedExisting, updated };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    log("REQUEST_IN", { method: req.method, query: req.query });

    if (req.method === "OPTIONS") return ok(res, { ok: true });
    if (!["GET", "POST"].includes(req.method)) return bad(res, 405, "Método no permitido");

    const q = req.method === "GET" ? req.query : (req.body || {});
    const since = toISO(q.since);
    const untilInput = toISO(q.until);
    const force = String(q.force).toLowerCase() === "true";
    const dryRun = q.dryRun === undefined ? true : String(q.dryRun).toLowerCase() === "true";
    const pageSize = Math.max(50, Math.min(1000, Number(q.pageSize) || 500));
    const backfillDays = Math.max(0, Math.min(60, Number(q.backfillDays) || 7));
    const propertyIds =
      typeof q.propertyIds === "string"
        ? q.propertyIds.split(",").map(s => s.trim()).filter(Boolean)
        : Array.isArray(q.propertyIds) ? q.propertyIds : [];

    const meta = await readMeta();
    const lastLinkedDate = meta.data.lastLinkedDate || null;
    let lastQuoteDate = meta.data.lastQuoteDate || await findLastQuoteDateFromFirestore(365);
    if (!lastQuoteDate) return bad(res, 400, "No hay cotizaciones USD en Firestore");

    let start =
      since ||
      (lastLinkedDate
        ? DateTime.fromISO(lastLinkedDate, { zone: TZ }).plus({ days: 1 }).toISODate()
        : DateTime.fromISO(lastQuoteDate, { zone: TZ }).minus({ days: backfillDays }).toISODate());

    let end = untilInput || DateTime.now().setZone(TZ).toISODate();

    const now = DateTime.now().setZone(TZ);
    const today = now.toISODate();
    const afterCutoff = now.hour > 10 || (now.hour === 10 && now.minute >= 10);

    if (end > today) end = today;
    if (end > lastQuoteDate) {
      if (end !== today) end = lastQuoteDate;
      else if (!afterCutoff) end = lastQuoteDate;
    }

    log("RANGE_COMPUTED", { start, end, today, lastQuoteDate, afterCutoff });

    if (start > end) return ok(res, { ok: true, reason: "No work", range: { start, end } });

    const perDate = [];
    for (const d of dateRangeIterator(start, end)) {
      let qd = await getQuoteDoc(d);
      let usedFallback = false, fallbackFrom = null;

      if (!qd) {
        const isToday = d === today;
        if (isToday && afterCutoff) {
          fallbackFrom = await findPrevQuoteDate(d, 7);
          if (fallbackFrom) {
            qd = await getQuoteDoc(fallbackFrom);
            usedFallback = !!qd;
            if (qd) log("DATE_FALLBACK_QUOTE", { date: d, fallbackFrom });
          }
        }
        if (!qd) { perDate.push({ date: d, status: "no_quote" }); continue; }
      } else {
        log("DATE_HAS_QUOTE", { date: d, casa: qd.casa, compra: qd.compra, venta: qd.venta });
      }

      const r = await updateReservationsForDate({
        dateISO: d, quote: qd, propertyIds, force, dryRun, pageSize, usedFallback, fallbackFrom,
      });
      perDate.push({ date: d, status: "ok", matched: r.matched, skippedExisting: r.skippedExisting, updated: r.updated });
    }

    if (!dryRun) await writeMeta({ lastLinkedDate: end, lastQuoteDate });

    const summary = {
      ok: true, dryRun, force,
      range: { start, end }, lastQuoteDate, lastLinkedDateBefore: lastLinkedDate,
      propertyIdsCount: propertyIds.length,
      totals: {
        dates: perDate.length,
        updated: perDate.reduce((s, x) => s + (x.updated || 0), 0),
        matched: perDate.reduce((s, x) => s + (x.matched || 0), 0),
        skippedExisting: perDate.reduce((s, x) => s + (x.skippedExisting || 0), 0),
        no_quote_days: perDate.filter(x => x.status === "no_quote").length,
      },
      perDate,
    };
    log("DONE", { range: summary.range, totals: summary.totals });
    return ok(res, summary);
  } catch (e) {
    err("UNHANDLED_ERROR", { message: e?.message, stack: e?.stack });
    return bad(res, 500, e.message || "Error interno");
  }
}

// --- auth relax: si AUTH_TOKEN está definido se valida, si no está permitimos (modo prueba) ---
const authHeader = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
const hostHeader = (req.headers?.host || req.headers["x-forwarded-host"] || "").replace(/:\d+$/, "");
console.log("[linkUsdFx] incoming auth present:", Boolean(req.headers?.authorization), "host:", hostHeader, "VERCEL_URL:", process.env.VERCEL_URL);
if (process.env.AUTH_TOKEN) {
  const tokenOk = authHeader && authHeader === process.env.AUTH_TOKEN;
  const fromSelf = process.env.VERCEL_URL && hostHeader === (process.env.VERCEL_URL || "").replace(/^https?:\/\//, "");
  if (!tokenOk && !fromSelf) {
    console.warn("[linkUsdFx] unauthorized request - auth failed");
    return res.status ? res.status(401).json({ error: "unauthorized" }) : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
} else {
  console.log("[linkUsdFx] no AUTH_TOKEN set - allowing request");
}
// --- fin auth ---
