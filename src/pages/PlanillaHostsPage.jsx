import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { DateTime } from "luxon";
import PopoverPortal from "../components/PopoverPortal";
import ExportBottomExcel from "../components/ExportBottomExcel"; 
import { Link } from 'react-router-dom';


const TZ = "America/Argentina/Buenos_Aires";

/* ---------- helpers ---------- */

// Lee el TC desde r.usd_fx_on_checkin y devuelve: { rate, date, casa }
const getUsdFx = (r) => {
  const fx = r?.usd_fx_on_checkin || {};
  const buy = Number(fx.compra);
  const sell = Number(fx.venta);
  let rate = null;
  if (Number.isFinite(buy) && Number.isFinite(sell)) rate = (buy + sell) / 2;
  else if (Number.isFinite(sell)) rate = sell;
  else if (Number.isFinite(buy)) rate = buy;
  return {
    rate,
    date: fx.fecha || null,
    casa: fx.casa || "oficial",
  };
};

// Formatea dinero sin símbolo fijo (dejo el sufijo de moneda afuera)
const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "-";
};


const fmtDate = (iso) => (iso ? DateTime.fromISO(iso, { zone: TZ }).toISODate() : "");
const cls = (...xs) => xs.filter(Boolean).join(" ");
const toFlag = (cc) => {
  if (!cc || typeof cc !== "string" || cc.length !== 2) return null;
  const A = 127397;
  const up = cc.toUpperCase();
  return String.fromCodePoint(...[...up].map((c) => c.charCodeAt(0) + A));
};
/*-------------------------- Puertita ------------------------------*/
const ExitIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    {/* puerta */}
    <path d="M4 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4" />
    {/* flecha salir */}
    <path d="M12 12h8" />
    <path d="M17 7l5 5-5 5" />
  </svg>
);

/* --------------------- Lapicito--------------------------*/
const PencilIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

const toLocalIso = (dateStr, timeStr) => {
  // Combina "YYYY-MM-DD" + "HH:mm" como ISO con zona AR para backend
  if (!dateStr) return null;
  const [h, m] = (timeStr || "00:00").split(":").map(Number);
  const dt = DateTime.fromISO(dateStr, { zone: TZ }).set({
    hour: h || 0,
    minute: m || 0,
    second: 0,
    millisecond: 0,
  });
  return dt.isValid ? dt.toISO() : null;
};
const getPayments = (r) => (r && Array.isArray(r.payments) ? r.payments : []);
const groupPaymentsByCurrency = (payments = []) => {
  const map = new Map();
  for (const p of payments) {
    const cur = String(p.currency || 'ARS').toUpperCase();
    if (!map.has(cur)) map.set(cur, []);
    map.get(cur).push(p);
  }
  // orden: moneda asc; dentro de cada moneda, más recientes arriba
  return [...map.entries()].map(([cur, list]) => [cur, list.sort((a, b) => {
    const sa = (a.ts ? (a.ts.seconds ?? a.ts._seconds ?? 0) : 0);
    const sb = (b.ts ? (b.ts.seconds ?? b.ts._seconds ?? 0) : 0);
    return sb - sa;
  })]);
};
const sumAmount = (list = []) => list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
//recupera notas//
const getNotes = (r) => (r && Array.isArray(r.notes) ? r.notes : []);
// Convierte Timestamps/firestore/json a texto corto
const fmtTS = (ts) => {
  if (!ts) return "";
  // Firestore Timestamp (admin o web)
  if (ts.seconds || ts._seconds) {
    const s = ts.seconds ?? ts._seconds;
    return DateTime.fromSeconds(Number(s), { zone: TZ }).toFormat("dd/MM HH:mm");
  }
  // ISO string o Date
  try {
    const d = DateTime.fromISO(String(ts), { zone: TZ });
    if (d.isValid) return d.toFormat("dd/MM HH:mm");
  } catch { }
  return "";
};

// === Helpers de pago (badge y normalización numérica)
const payBadge = (status) =>
  status === "paid" ? <span className="badge badge--paid">Pago</span> :
    status === "partial" ? <span className="badge badge--partial">Parcial</span> :
      <span className="badge badge--unpaid">Impago</span>;

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ---------- Chip reutilizable ---------- */
const Chip = ({ label, active, tone = "sky" }) => {
  const onClass = tone === "amber" ? "chip--amber" : "chip--sky";
  return <span className={cls("chip", active ? onClass : "chip--off")}>{label}</span>;
};

/* ---------- data hook ---------- */

        // Endpoint mínimo del backend que devuelva { items: [{id, nombre}] }
        // Lectura de la colección 'propiedades' con filtro activo=true.
function useActiveProperties() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
       const { data } = await axios.get("/api/properties?");
       // Soporta {items:[...]} ó directamente [...]
       const raw = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
       const items = raw.map(p => ({
         id: p.id || p?.uid || p?.docId,
        nombre: p.nombre || p?.name || String(p.id || p?.uid || p?.docId || "")
       })).filter(p => p.id);
        const seen = new Set();
        const clean = items.filter(p => p?.id && !seen.has(p.id) && (seen.add(p.id), true));
        setList(clean);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return { list, loading };
}



function useDaily(dateISO, propertyId) {
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(null);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState("checkins");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const fetchTab = async (t, indexDoc) => {
    const ids = indexDoc?.[t] || [];
    if (!ids?.length) {
      setItems([]);
      return;
    }
    // Pasamos propiedad_id al backend para que (si quiere) use ese dato
    const body = { ids };
    if (propertyId && propertyId !== "all") body.propiedad_id = propertyId;

    const { data } = await axios.post("/api/resolveReservations", body);
    const list = Array.isArray(data.items) ? data.items : [];

    // Orden natural por propiedad (sólo en "Todas")
    const norm = (s) => (s ? String(s).toLowerCase() : "");
    const cmp = (a, b) => {
      const pa = norm(a.propiedad_nombre) || norm(a.propiedad_id);
      const pb = norm(b.propiedad_nombre) || norm(b.propiedad_id);
      if (pa !== pb) return pa.localeCompare(pb);

      const da = norm(a.depto_nombre || a.nombre_depto || a.codigo_depto || a.id_zak);
      const db = norm(b.depto_nombre || b.nombre_depto || b.codigo_depto || b.id_zak);
      if (da !== db) return da.localeCompare(db);

      const aa = a.arrival_iso || "";
      const ab = b.arrival_iso || "";
      if (aa !== ab) return aa < ab ? -1 : 1;

      return String(a.id_human || a.id).localeCompare(String(b.id_human || b.id));
    };

    const sorted = propertyId === "all" ? [...list].sort(cmp) : list;
    setItems(sorted);
  };

  const loadDay = async (t = tab) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ date: dateISO });
      const propParam = propertyId && propertyId !== "all" ? propertyId : "all";
      q.set("property", propParam);

      const { data } = await axios.get(`/api/dailyIndex?${q.toString()}`);
      setIdx(data);
      await fetchTab(t, data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDay(); /* eslint-disable-next-line */ }, [dateISO, propertyId]);

  const setActiveTab = async (t) => {
    setTab(t);
    setPage(1);
    if (idx) await fetchTab(t, idx);
  };

  const refetch = async () => {
    if (idx) await fetchTab(tab, idx);
    else await loadDay(tab);
  };

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page]);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  return { loading, idx, items: paged, counts: idx?.counts || {}, tab, setActiveTab, page, setPage, totalPages, refetch };
}


/* ---------- UI: Tabs ---------- */
function Tabs({ tab, onChange, counts }) {
  const Btn = ({ id, label }) => {
    const isActive = tab === id;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        className={cls("tab", isActive && "tab--active")}
        onClick={() => onChange(id)}
      >
        <span>{label}</span>
        <span className="tab__count">{counts?.[id] ?? 0}</span>
      </button>
    );
  };

  return (
    <div role="tablist" aria-label="Reservas" className="tabsbar">
      <Btn id="checkins" label="Check-ins" />
      <Btn id="stays" label="Stays" />
      <Btn id="checkouts" label="Check-outs" />
      <div className="tabsbar__spacer" />
    </div>
  );
}

/* ---------- UI: Paginator ---------- */
function Paginator({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pager">
      <button type="button" className="pager__btn" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>←</button>
      <span className="pager__label">Página {page} / {totalPages}</span>
      <button type="button" className="pager__btn" onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>→</button>
    </div>
  );
}

/* ---------- UI: ActionButton con popover ---------- */

function ActionButton({ r, type, active, defaultDateISO, defaultTimeHHmm, tone, isOpen, onToggle, onDone }) {
  const btnRef = useRef(null);               // ⟵ ANCLA
  const [d, setD] = useState(defaultDateISO || "");
  const [t, setT] = useState(defaultTimeHHmm || "");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const label = type === "contact" ? "Contactado" : type === "checkin" ? "Check-in" : "Check-out";
  const btnClass = cls("pill-btn", !active ? "pill-btn--neutral" :
    tone === "amber" ? "pill-btn--amber-active" :
      tone === "sky" ? "pill-btn--sky-active" : "pill-btn--gray-active");

  const confirm = async () => {
    try {
      setSubmitting(true);
      let whenISO;
      if (type === "contact") {
        whenISO = d && t ? toLocalIso(d, t) : null;
      } else if (type === "checkin") {
        whenISO = toLocalIso(d || (r.arrival_iso || ""), t || "15:00");
      } else {
        whenISO = toLocalIso(d || (r.departure_iso || ""), t || "11:00");
      }
      await axios.post("/api/reservationMutations", { id: r.id, action: type, payload: { when: whenISO }, user: "host" });
      const clean = (note || "").trim();
      if (clean) await axios.post("/api/reservationMutations", { id: r.id, action: "addNote", payload: { text: clean }, user: "host" });
      setNote("");
      onDone?.();
    } finally { setSubmitting(false); }
  };

  return (
    <div className="pill-wrap" onClick={(e) => e.stopPropagation()}>
      <button ref={btnRef} type="button" className={btnClass} onClick={onToggle} disabled={submitting}>
        {label}
      </button>

      <PopoverPortal anchorRef={btnRef} open={isOpen} onClose={onToggle} placement="top-right" maxWidth={300}>
        <div className="mini-popover__row">
          <label className="mini-popover__lab">Fecha</label>
          <input type="date" className="mini-popover__field" value={d} onChange={(e) => setD(e.target.value)} />
        </div>
        <div className="mini-popover__row">
          <label className="mini-popover__lab">Hora</label>
          <input type="time" className="mini-popover__field" value={t} onChange={(e) => setT(e.target.value)} />
        </div>
        <div className="mini-popover__row mini-popover__row--note">
          <label className="mini-popover__lab">Nota (opcional)</label>
          <textarea className="mini-popover__field h-16" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Agregar nota…" />
        </div>
        <div className="mini-popover__actions">
          <button type="button" className="mini-popover__btn mini-popover__btn--muted" onClick={onToggle} disabled={submitting}>Cancelar</button>
          <button type="button" className="mini-popover__btn mini-popover__btn--ok" onClick={confirm} disabled={submitting}>
            {submitting ? "Guardando…" : "Confirmar"}
          </button>
        </div>
      </PopoverPortal>
    </div>
  );
}


/* -------------------boton registro de pagos -----------------------------*/

function PaymentAddButton({ r, isOpen, onToggle, onDone }) {
  const btnRef = useRef(null);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState((r.currency || "ARS").toUpperCase());
  const [method, setMethod] = useState("Efectivo");
  const [concept, setConcept] = useState("");             // NUEVO
  const [sending, setSending] = useState(false);

  const save = async () => {
    const val = Number(amount);
    if (!isFinite(val) || val <= 0) return;
    try {
      setSending(true);
      await axios.post("/api/reservationMutations", {
        id: r.id,
        action: "addPayment",
        payload: {
          amount: val,
          currency: (currency || "ARS").toUpperCase(),
          method,
          concept: concept || undefined,                  // NUEVO
          // quitamos fecha/hora: 'when' va como null
          when: null
        },
        user: "host",
      });
      setAmount(""); setConcept("");                      // limpiar inputs
      onDone?.();
    } finally { setSending(false); }
  };

  return (
    <div className="pay-addwrap" onClick={(e) => e.stopPropagation()}>
      <button ref={btnRef} type="button" className="pay-addbtn" title="Agregar pago" onClick={onToggle}>+</button>

      <PopoverPortal anchorRef={btnRef} open={isOpen} onClose={onToggle} placement="top-right" maxWidth={320}>
        <div className="mini-popover__title">Agregar pago</div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Monto</label>
          <input className="mini-popover__field" type="number" step="0.01" min="0"
                 value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Moneda</label>
          <select className="mini-popover__field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option>ARS</option><option>USD</option><option>EUR</option><option>BRL</option><option>CLP</option>
          </select>
        </div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Método</label>
          <select className="mini-popover__field" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option><option>MercadoPago</option><option>Otro</option>
          </select>
        </div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Concepto</label>
          <input className="mini-popover__field" type="text" maxLength={80}
                 value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Ej. seña, saldo, limpieza…" />
        </div>

        <div className="mini-popover__actions">
          <button type="button" className="mini-popover__btn mini-popover__btn--muted" onClick={onToggle}>Cancelar</button>
          <button type="button" className="mini-popover__btn mini-popover__btn--ok"
                  onClick={save} disabled={!(Number(amount) > 0) || sending}>
            {sending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </PopoverPortal>
    </div>
  );
}


/* ----------------------------Boton de agregado de notas --------------------------------*/

function NoteAddButton({ r, isOpen, onToggle, onDone }) {
  const btnRef = useRef(null);              // ⟵ ANCLA
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  const save = async () => {
    const clean = (note || "").trim();
    if (!clean) return;
    try {
      setSending(true);
      await axios.post("/api/reservationMutations", { id: r.id, action: "addNote", payload: { text: clean }, user: "host" });
      setNote("");
      onDone?.();
    } finally { setSending(false); }
  };

  return (
    <div className="notes-addwrap" onClick={(e) => e.stopPropagation()}>
      <button ref={btnRef} type="button" className="notes-addbtn" title="Agregar nota" onClick={onToggle}>+</button>

      <PopoverPortal anchorRef={btnRef} open={isOpen} onClose={onToggle} placement="top-right" maxWidth={340}>
        <div className="mini-popover__title">Agregar nota</div>
        <div className="mini-popover__row mini-popover__row--note">
          <label className="mini-popover__lab">Nueva nota</label>
          <textarea className="mini-popover__field h-24" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Escribí tu nota…" />
        </div>
        <div className="mini-popover__actions">
          <button type="button" className="mini-popover__btn mini-popover__btn--muted" onClick={onToggle} disabled={sending}>Cancelar</button>
          <button type="button" className="mini-popover__btn mini-popover__btn--ok" onClick={save} disabled={sending || !note.trim()}>
            {sending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </PopoverPortal>
    </div>
  );
}


/*------------------- Armado de lista de pagos ------------------- */
function PaymentsList({ r }) {
  const payments = getPayments(r);
  if (!payments.length) return <div className="payments-empty">Sin pagos</div>;

  const groups = groupPaymentsByCurrency(payments);

  return (
    <div className="payments-list">
      {groups.map(([cur, list], gi) => (
        <div key={cur}>
          <div className="pay-group-head">
            <span>Moneda: <span className="pay-cur">{cur}</span></span>
            <span className="pay-total">Subtotal: {sumAmount(list).toFixed(2)} {cur}</span>
          </div>

          {list.map((p, i) => (
            <div key={gi + "_" + i} className="pay-item">
              <div className="pay-left">
                <span className="chip chip--off">{p.method || "—"}</span>
                {p.concept ? <span className="chip chip--off">{p.concept}</span> : null}
                <span className="pay-meta">{p.by ? p.by : "host"} · {fmtTS(p.ts)}</span>
              </div>
              <div className="pay-amt">{Number(p.amount || 0).toFixed(2)} {cur}</div>
            </div>
          ))}

          {gi < groups.length - 1 && <div className="pay-sep" />}
        </div>
      ))}
    </div>
  );
}


/* --------- Nueva Línea 4: editor de toPay en USD + badge ---------- */


function ToPayLine({ r, onRefresh, isOpen, onToggle, onDone, fx, currency, onToggleCurrency }) {
  const editBtnRef = useRef(null);

  // helpers locales
  const nOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const isPos = (n) => typeof n === "number" && isFinite(n) && n > 0;

  // --- lectura segura del breakdown + fallback a top-level
  const bd = r?.toPay_breakdown || {};

  const baseBD    = nOrNull(bd.baseUSD);
  const extrasBD  = nOrNull(bd.extrasUSD);
  const extrasTop = nOrNull(r?.extrasUSD);
  const ivaBD     = nOrNull(bd.ivaUSD);
  const ivaPct    = nOrNull(bd.ivaPercent);

  const baseUSD   = baseBD;
  const extrasUSD = (extrasBD !== null ? extrasBD : extrasTop);

  const ivaUSD =
    ivaBD !== null
      ? ivaBD
      : (baseUSD !== null && ivaPct !== null ? Number((baseUSD * ivaPct / 100).toFixed(2)) : null);

  // --- estados del editor
  const [baseUSDIn, setBaseUSDIn]     = useState(baseUSD !== null ? String(baseUSD.toFixed(2)) : "");
  const [extrasUSDIn, setExtrasUSDIn] = useState(extrasUSD !== null ? String(extrasUSD.toFixed(2)) : "");
  const [ivaMode, setIvaMode]         = useState(ivaPct !== null ? "percent" : "amount");
  const [ivaPercent, setIvaPercent]   = useState(ivaPct !== null ? String(ivaPct) : "21");
  const [ivaUSDIn, setIvaUSDIn]       = useState(ivaUSD !== null ? String(ivaUSD.toFixed(2)) : "");

  useEffect(() => {
    const bd2 = r?.toPay_breakdown || {};
    const b   = nOrNull(bd2.baseUSD);
    const e   = (nOrNull(bd2.extrasUSD) !== null ? nOrNull(bd2.extrasUSD) : nOrNull(r?.extrasUSD));
    const ia  = nOrNull(bd2.ivaUSD);
    const ip  = nOrNull(bd2.ivaPercent);

    const ivaCalc = ia !== null ? ia : (b !== null && ip !== null ? Number((b * ip / 100).toFixed(2)) : null);

    setBaseUSDIn(b !== null ? String(b.toFixed(2)) : "");
    setExtrasUSDIn(e !== null ? String(e.toFixed(2)) : "");
    setIvaMode(ip !== null ? "percent" : "amount");
    setIvaPercent(ip !== null ? String(ip) : "21");
    setIvaUSDIn(ivaCalc !== null ? String(ivaCalc.toFixed(2)) : "");
  }, [isOpen, r?.id, r?.contentHash]);

  const toNumOrNull = (s) => {
    if (s === "" || s === null || s === undefined) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const onSave = async () => {
    const payload = {};
    const b = toNumOrNull(baseUSDIn);
    const e = toNumOrNull(extrasUSDIn);

    if (b !== null) payload.baseUSD = b;
    if (e !== null) payload.extrasUSD = e;

    if (ivaMode === "percent") {
      const p = toNumOrNull(ivaPercent);
      if (p !== null) payload.ivaPercent = p;
    } else {
      const a = toNumOrNull(ivaUSDIn);
      if (a !== null) payload.ivaUSD = a;
    }

    await axios.post("/api/reservationMutations", { id: r.id, action: "setToPay", user: "host", payload });
    onDone?.(); onRefresh?.();
  };

  // --- desglose
  const parts = [];
  if (isPos(baseUSD))   parts.push(baseUSD.toFixed(2));
  if (isPos(extrasUSD)) parts.push(`+ ${extrasUSD.toFixed(2)}`);
  if (isPos(ivaUSD))    parts.push(`VAT ${ivaUSD.toFixed(2)}`);
  const breakdownText = parts.join(" ");

  // --- totales con TC
  const totalUSD = (typeof r.toPay === "number" && isFinite(r.toPay)) ? r.toPay : null;
  const fxRate = Number(fx?.rate);
  const totalARS = (totalUSD !== null && Number.isFinite(fxRate)) ? totalUSD * fxRate : null;
  const showUSD = currency === "USD";

  return (
    <>
      <div className="left__line4" onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Total */}
        <span className="toPay-view" style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className="toPay-cur">{showUSD ? "USD" : "ARS"}</span>
          <strong>{money(showUSD ? totalUSD : totalARS)}</strong>
        </span>

        {/* Desglose condicional */}
        {breakdownText && (
          <span className="toPay-breakdown" style={{ marginLeft: 8, opacity: 0.8, fontSize: 12 }}>
            {breakdownText}
          </span>
        )}

        {/* Toggle USD ⇄ ARS */}
        <button
          type="button"
          className="toPay-btn toPay-btn--switch"
          onClick={onToggleCurrency}
          title="Cambiar moneda"
          style={{ marginLeft: 8 }}
        >
          <span style={{ fontWeight: showUSD ? 700 : 400 }}>USD</span>
          <span aria-hidden style={{ padding: "0 6px" }}>↔</span>
          <span style={{ fontWeight: showUSD ? 400 : 700, opacity: showUSD ? 0.6 : 1 }}>ARS</span>
        </button>

        {/* Edit pencil */}
        <button
          ref={editBtnRef}
          type="button"
          className="toPay-btn toPay-btn--icon"
          aria-label="Editar total"
          title="Editar total"
          onClick={onToggle}
        >
          <PencilIcon />
        </button>

        {payBadge(r.payment_status || "unpaid")}

        {/* Chip de tipo de cambio, alineado a la derecha */}
        {Number.isFinite(fxRate) && (
          <span
            className="chip chip--off"
            title={`TC ${fxRate.toFixed(2)} (${fx?.casa || "oficial"} · ${fx?.date || "-"})`}
            style={{ marginLeft: "auto" }}
          >
            TC: {fxRate.toFixed(2)}
          </span>
        )}
      </div>

      <PopoverPortal anchorRef={editBtnRef} open={isOpen} onClose={onToggle} placement="bottom-left" maxWidth={360}>
        <div className="mini-popover__title">Total a pagar (USD)</div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Base USD</label>
          <input
            className="mini-popover__field"
            type="number" step="0.01" min="0"
            value={baseUSDIn === "" ? "" : baseUSDIn}
            onChange={(e) => setBaseUSDIn(e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">IVA</label>

          <label className="flex items-center gap-1">
            <input
              type="radio" name={`ivaMode_${r.id}`} value="percent"
              checked={ivaMode === "percent"} onChange={() => setIvaMode("percent")}
            />
            <span>%</span>
          </label>
          <input
            className="mini-popover__field mini-popover__field--xs"
            type="number" step="0.01" min="0"
            value={ivaPercent}
            onChange={(e) => setIvaPercent(e.target.value)}
            placeholder="21"
            disabled={ivaMode !== "percent"}
          />

          <label className="flex items-center gap-1 ml-2">
            <input
              type="radio" name={`ivaMode_${r.id}`} value="amount"
              checked={ivaMode === "amount"} onChange={() => setIvaMode("amount")}
            />
            <span>USD</span>
          </label>
          <input
            className="mini-popover__field mini-popover__field--s"
            type="number" step="0.01" min="0"
            value={ivaUSDIn === "" ? "" : ivaUSDIn}
            onChange={(e) => setIvaUSDIn(e.target.value)}
            placeholder="0.00"
            disabled={ivaMode !== "amount"}
          />
        </div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Extras (USD)</label>
          <input
            className="mini-popover__field"
            type="number" step="0.01" min="0"
            value={extrasUSDIn === "" ? "" : extrasUSDIn}
            onChange={(e) => setExtrasUSDIn(e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div className="mini-popover__actions">
          <button type="button" className="mini-popover__btn mini-popover__btn--muted" onClick={onToggle}>Cancelar</button>
          <button type="button" className="mini-popover__btn mini-popover__btn--ok" onClick={onSave}>Guardar</button>
        </div>
      </PopoverPortal>
    </>
  );
}

/* ---------- UI: ReservationCard (4 celdas) ---------- */

function ReservationCard({ r, onRefresh, activePopover, onPopoverToggle }) {
  const depto = r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || "—";
  const phone = r.customer_phone || r.telefono || "";
  const email = r.customer_email || "";
  const flag = toFlag(r.customer_country);
  const inDt = fmtDate(r.arrival_iso);
  const outDt = fmtDate(r.departure_iso);
  const channel = r.source || r.channel_name || "—";
  const deptoTagClass = cls("tag", "tag--depto", r.checkin_at ? "tag--depto--in" : (r.checkout_at ? "tag--depto--out" : ""));

  // Popover activo por card
  const isCardActive = !!activePopover && String(activePopover).startsWith(`${r.id}::`);
  const cardClassName = cls("res-card4", isCardActive && "res-card4--active");

  // ids únicos
  const pidNote = `${r.id}::addNote`;
  const pidPay = `${r.id}::addPayment`;
  const pidContact = `${r.id}::contact`;
  const pidCheckIn = `${r.id}::checkin`;
  const pidCheckOut = `${r.id}::checkout`;
  const pidToPay = `${r.id}::toPay`;

  const defContactDate = DateTime.now().setZone(TZ).toISODate();
  const defContactTime = DateTime.now().setZone(TZ).toFormat("HH:mm");
  const defInDate = r.arrival_iso || "";
  const defOutDate = r.departure_iso || "";

  // === NUEVO: estado local de moneda (USD por defecto) y TC de la reserva
  const [currency, setCurrency] = useState("USD");
  const fx = getUsdFx(r);
  const toggleCurrency = () => setCurrency((c) => (c === "USD" ? "ARS" : "USD"));

  return (
    <div className={cardClassName} onClick={(e) => e.stopPropagation()}>
      {/* CELDA 1 */}
      <div className="res-cell res-cell--left">
        <div className="left__line1">
          <span className={deptoTagClass}>{depto}</span>
          <span className={cls("name", r.contacted_at && "name--contacted")}>{r.nombre_huesped || "Sin nombre"}</span>
          {flag && <span className="text-sm">{flag}</span>}
        </div>

        <div className="left__line2">
          {phone && <span>{phone}</span>}
          {email && (
            <a className="mail-link" href={`mailto:${email}`} title={email} onClick={(e) => e.stopPropagation()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
                <path d="m22 8-10 6L2 8" />
              </svg>
            </a>
          )}
        </div>

        <div className="left__line3">
          {r.id_human && <span className="tag tag--rcode">{r.id_human}</span>}
          <span>In: {inDt} · Out: {outDt}</span>
          <span className="tag--channel">{channel}</span>
        </div>

        {/* Línea 4: total + toggle + chip de TC (promedio) */}
        <ToPayLine
          r={r}
          fx={fx}
          currency={currency}
          onToggleCurrency={toggleCurrency}
          isOpen={activePopover === pidToPay}
          onToggle={() => onPopoverToggle(pidToPay)}
          onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
        />
      </div>

      {/* CELDA 2: Notas */}
      <div className="res-cell">
        <div className="panel">
          <div className="panel__list">
            {(() => {
              const list = getNotes(r).slice().reverse();
              return list.length ? list.map((n, i) => (
                <div key={i} className="note-item">
                  <div className="note-head">
                    <span className="note-meta">{fmtTS(n.ts)}{n.by ? ` · ${n.by}` : ""}</span>
                    <span className={cls("note-badge", n.source === "wubook" ? "note-badge--w" : "note-badge--h")}>
                      {n.source === "wubook" ? "WuBook" : "Host"}
                    </span>
                  </div>
                  <div className="note-body">{n.text}</div>
                  {i < list.length - 1 && <div className="note-sep" />}
                </div>
              )) : <div className="notes-empty">Sin notas</div>;
            })()}
          </div>

          {/* Toolbar de notas */}
          <div className="panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <NoteAddButton
              r={r}
              isOpen={activePopover === pidNote}
              onToggle={() => onPopoverToggle(pidNote)}
              onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
            />
            {/* También mostramos aquí el TC como referencia */}
            {Number.isFinite(Number(fx.rate)) && (
              <span className="chip chip--off" title={`TC ${fx.rate.toFixed(2)} (${fx.casa || "oficial"} · ${fx.date || "-"})`}>
                TC {fx.rate.toFixed(2)} · {fx.casa || "oficial"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* CELDA 3: Pagos */}
      <div className="res-cell">
        <div className="panel">
          <div className="panel__list">
            <PaymentsList r={r} />
          </div>
          <div className="panel__toolbar">
            <PaymentAddButton
              r={r}
              isOpen={activePopover === pidPay}
              onToggle={() => onPopoverToggle(pidPay)}
              onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
            />
          </div>
        </div>
      </div>

      {/* CELDA 4: Estado */}
      <div className="res-cell">
        <div className="status-stack-new">
          <ActionButton
            r={r}
            type="contact"
            active={!!r.contacted_at}
            defaultDateISO={defContactDate}
            defaultTimeHHmm={defContactTime}
            tone="amber"
            isOpen={activePopover === pidContact}
            onToggle={() => onPopoverToggle(pidContact)}
            onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
          />
          <ActionButton
            r={r}
            type="checkin"
            active={!!r.checkin_at}
            defaultDateISO={defInDate}
            defaultTimeHHmm={"15:00"}
            tone="sky"
            isOpen={activePopover === pidCheckIn}
            onToggle={() => onPopoverToggle(pidCheckIn)}
            onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
          />
          <ActionButton
            r={r}
            type="checkout"
            active={!!r.checkout_at}
            defaultDateISO={defOutDate}
            defaultTimeHHmm={"11:00"}
            tone="gray"
            isOpen={activePopover === pidCheckOut}
            onToggle={() => onPopoverToggle(pidCheckOut)}
            onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
          />
        </div>
      </div>
    </div>
  );
}


/* ---------- App ---------- */

export default function App() {
  const today = DateTime.now().setZone(TZ).toISODate();
  const { list: propsList } = useActiveProperties();
  const [propertyId, setPropertyId] = useState("all");

  const [dateISO, setDateISO] = useState(today);
  const { loading, items, counts, tab, setActiveTab, page, setPage, totalPages, refetch } =
    useDaily(dateISO, propertyId);

  // Popovers global
  const [activePopover, setActivePopover] = useState(null);
  const handlePopoverToggle = (popoverId) => {
    setActivePopover((curr) => (curr === popoverId ? null : popoverId));
  };
  const closeAllPopovers = () => setActivePopover(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") closeAllPopovers(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goto = (offsetDays) => {
    const d = DateTime.fromISO(dateISO, { zone: TZ }).plus({ days: offsetDays }).toISODate();
    closeAllPopovers();
    setDateISO(d);
  };

  // util para agrupar items por propiedad (ya vienen ordenados si "all")
  const buildGroups = (arr) => {
    const map = new Map();
    for (const r of arr) {
      const key = r.propiedad_id || "sin_prop";
      const name = r.propiedad_nombre || key;
      if (!map.has(key)) map.set(key, { name, list: [] });
      map.get(key).list.push(r);
    }
    return Array.from(map.values());
  };

  return (
    <div className="app" onClick={closeAllPopovers}>
      <header className="header">
        <div className="header__bar">
          <div className="flex items-center gap-2">
            <h1 className="header__title">Planilla de Hosts</h1>
            <span className="header__date">({dateISO})</span>
          </div>

          <div className="header__actions">
            <select
              className="input--date"
              value={propertyId}
              onChange={(e) => { setPropertyId(e.target.value); closeAllPopovers(); }}
              title="Propiedad"
            >
              <option value="all">Todas</option>
              {propsList.map(p => (
                <option key={p.id} value={p.id}>{p.nombre}</option>
              ))}
            </select>

            <button type="button" className="btn" onClick={() => goto(-1)}>← Ayer</button>
            <button type="button" className="btn" onClick={() => { setDateISO(DateTime.now().setZone(TZ).toISODate()); closeAllPopovers(); }}>Hoy</button>
            <button type="button" className="btn" onClick={() => goto(1)}>Mañana →</button>
            <input className="input--date" type="date" value={dateISO}
                   onChange={(e) => { setDateISO(e.target.value); closeAllPopovers(); }} />
            <Link to="/dashboard" className="icon-btn" title="Volver al Portal" aria-label="Volver al Portal">
              <ExitIcon />
            </Link>
          </div>
        </div>
      </header>

      <main className="main" onClick={(e) => e.stopPropagation()}>
        <div className="main__top">
          <Tabs tab={tab} onChange={(t) => { setActiveTab(t); closeAllPopovers(); }} counts={counts} />
          <Paginator page={page} totalPages={totalPages} onPage={(p) => { setPage(p); closeAllPopovers(); }} />
        </div>

        {loading && <div className="loader">Cargando…</div>}

        {!loading && (
          <div className="list">
            {items.length === 0 && <div className="empty empty--as-card">Sin reservas</div>}

            {propertyId !== "all" ? (
              <div className="list__grid">
                {items.map((r) => (
                  <ReservationCard
                    key={r.id}
                    r={r}
                    onRefresh={refetch}
                    activePopover={activePopover}
                    onPopoverToggle={handlePopoverToggle}
                  />
                ))}
              </div>
            ) : (
              buildGroups(items).map((g, gi) => (
                <section key={gi} className="prop-group">
                  <h2 className="prop-group__title">{g.name}</h2>
                  <div className="list__grid">
                    {g.list.map((r) => (
                      <ReservationCard
                        key={r.id}
                        r={r}
                        onRefresh={refetch}
                        activePopover={activePopover}
                        onPopoverToggle={handlePopoverToggle}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}
      </main>

      <section className="bottom">
        <BottomTable items={items} />
      </section>
    </div>
  );
}

