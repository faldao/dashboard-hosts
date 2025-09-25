import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { DateTime } from "luxon";
import PopoverPortal from "./components/PopoverPortal";
import ExportBottomExcel from "./components/ExportBottomExcel"; 


const TZ = "America/Argentina/Buenos_Aires";

/* ---------- helpers ---------- */
const fmtDate = (iso) => (iso ? DateTime.fromISO(iso, { zone: TZ }).toISODate() : "");
const cls = (...xs) => xs.filter(Boolean).join(" ");
const toFlag = (cc) => {
  if (!cc || typeof cc !== "string" || cc.length !== 2) return null;
  const A = 127397;
  const up = cc.toUpperCase();
  return String.fromCodePoint(...[...up].map((c) => c.charCodeAt(0) + A));
};


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
    const { data } = await axios.post("/api/resolveReservations", { ids });
    setItems(data.items || []);
  };

const loadDay = async (t = tab) => {
  setLoading(true);
  try {
    const q = new URLSearchParams({ date: dateISO });
    const propParam = propertyId && propertyId !== "all" ? propertyId : "all";
    q.set("property", propParam);
    // opcional (solo si tu backend también mira 'propiedad_id'):
    // q.set("propiedad_id", propParam);

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


function ToPayLine({ r, onRefresh, isOpen, onToggle, onDone }) {
  const editBtnRef = useRef(null);

  // --- helpers de lectura segura
  const bd = r?.toPay_breakdown || {};
  const readBase   = Number.isFinite(Number(bd.baseUSD))   ? Number(bd.baseUSD)   : null;
  const readExtras = Number.isFinite(Number(bd.extrasUSD)) ? Number(bd.extrasUSD) : (Number.isFinite(Number(r?.extrasUSD)) ? Number(r.extrasUSD) : null);
  const readIvaAmt = Number.isFinite(Number(bd.ivaUSD))    ? Number(bd.ivaUSD)    : null;
  const readIvaPct = Number.isFinite(Number(bd.ivaPercent))? Number(bd.ivaPercent): null;

  // --- states (SIEMPRE por breakdown, nunca por toPay)
  const [baseUSD, setBaseUSD]       = useState(readBase !== null ? String(readBase.toFixed(2)) : "");
  const [extrasUSD, setExtrasUSD]   = useState(readExtras !== null ? String(readExtras.toFixed(2)) : "");
  const [ivaMode, setIvaMode]       = useState(readIvaPct !== null ? "percent" : "amount");
  const [ivaPercent, setIvaPercent] = useState(readIvaPct !== null ? String(readIvaPct) : "21");
  const [ivaUSD, setIvaUSD]         = useState(readIvaAmt !== null ? String(readIvaAmt.toFixed(2)) : "");

  // Cuando cambia la reserva o se abre el pop, re-hidratamos desde el breakdown
  useEffect(() => {
    const bd2 = r?.toPay_breakdown || {};
    const b   = Number.isFinite(Number(bd2.baseUSD))   ? Number(bd2.baseUSD)   : null;
    const e   = Number.isFinite(Number(bd2.extrasUSD)) ? Number(bd2.extrasUSD) : (Number.isFinite(Number(r?.extrasUSD)) ? Number(r.extrasUSD) : null);
    const ia  = Number.isFinite(Number(bd2.ivaUSD))    ? Number(bd2.ivaUSD)    : null;
    const ip  = Number.isFinite(Number(bd2.ivaPercent))? Number(bd2.ivaPercent): null;

    setBaseUSD(b !== null ? String(b.toFixed(2)) : "");
    setExtrasUSD(e !== null ? String(e.toFixed(2)) : "");
    setIvaMode(ip !== null ? "percent" : "amount");
    setIvaPercent(ip !== null ? String(ip) : "21");
    setIvaUSD(ia !== null ? String(ia.toFixed(2)) : "");
  }, [isOpen, r?.id, r?.contentHash]); // contentHash para rehidratar tras guardar

  const onSave = async () => {
    const payload = {
      baseUSD: Number(baseUSD) || 0,
      extrasUSD: Number(extrasUSD) || 0,
    };
    if (ivaMode === "percent") payload.ivaPercent = Number(ivaPercent) || 0;
    else payload.ivaUSD = Number(ivaUSD) || 0;

    await axios.post("/api/reservationMutations", { id: r.id, action: "setToPay", user: "host", payload });
    onDone?.(); onRefresh?.();
  };

  return (
    <>
      <div className="left__line4" onClick={(e) => e.stopPropagation()}>
        {/* Visualización del total: usa r.toPay, NO los inputs */}
        <span className="toPay-view">
          <span className="toPay-cur">USD</span>
          <strong>
            {(typeof r.toPay === "number" && isFinite(r.toPay)) ? r.toPay.toFixed(2) : "-"}
          </strong>
        </span>

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
      </div>

      <PopoverPortal anchorRef={editBtnRef} open={isOpen} onClose={onToggle} placement="bottom-left" maxWidth={360}>
        <div className="mini-popover__title">Total a pagar (USD)</div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Base USD</label>
          <input
            className="mini-popover__field"
            type="number" step="0.01" min="0"
            value={baseUSD}
            onChange={(e) => setBaseUSD(e.target.value)}
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
            value={ivaUSD}
            onChange={(e) => setIvaUSD(e.target.value)}
            placeholder="0.00"
            disabled={ivaMode !== "amount"}
          />
        </div>

        <div className="mini-popover__row">
          <label className="mini-popover__lab">Extras (USD)</label>
          <input
            className="mini-popover__field"
            type="number" step="0.01" min="0"
            value={extrasUSD}
            onChange={(e) => setExtrasUSD(e.target.value)}
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

  // --- NUEVO: card activa si el popover actual empieza con su id ---
  const isCardActive = !!activePopover && String(activePopover).startsWith(`${r.id}::`);
  const cardClassName = cls("res-card4", isCardActive && "res-card4--active");

  // ids únicos por acción en esta reserva
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

        <ToPayLine
          r={r}
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

          {/* Botón + nota con popover global */}
          <div className="panel__toolbar">
          <NoteAddButton
            r={r}
            isOpen={activePopover === pidNote}
            onToggle={() => onPopoverToggle(pidNote)}
            onDone={() => { onPopoverToggle(null); onRefresh?.(); }}
          />
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



/* ---------- UI: BottomTable (nuevo formato + export Excel) ---------- */
function BottomTable({ items }) {
  // Helpers locales (no tocan tus helpers globales)
  const fmtDay = (iso) =>
    iso ? DateTime.fromISO(iso, { zone: TZ }).toFormat("dd/MM/yyyy") : "-";

  const fmtHourTS = (ts) => {
    if (!ts) return "-";
    if (ts.seconds || ts._seconds) {
      const s = ts.seconds ?? ts._seconds;
      return DateTime.fromSeconds(Number(s), { zone: TZ }).toFormat("HH:mm");
    }
    try {
      const d = DateTime.fromISO(String(ts), { zone: TZ });
      if (d.isValid) return d.toFormat("HH:mm");
    } catch {}
    return "-";
  };

  const money = (n, cur) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "-";
    const c = (cur || "USD").toString().toUpperCase();
    return `${v.toFixed(2)} ${c}`;
  };

  // Aplana reservas -> filas (primera fila con datos; filas extra sólo pagos)
  const rows = [];
  items.forEach((r, idx) => {
    const pays = getPayments(r);
    rows.push({
      _sepTop: idx > 0, // línea negra arriba al iniciar nueva reserva
      // datos visibles
      depto: r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || "—",
      pax: r.adults ?? "-",
      nombre: r.nombre_huesped || "-",
      tel: r.customer_phone || r.telefono || "-",
      checkin: fmtDay(r.arrival_iso),
      hora_in: fmtHourTS(r.checkin_at),
      checkout: fmtDay(r.departure_iso),
      hora_out: fmtHourTS(r.checkout_at),
      agencia: r.source || r.channel_name || "-",
      toPay: money(r.toPay, "USD"),
      pago: pays[0] ? money(pays[0].amount, pays[0].currency) : "",
      metodo: pays[0]?.method || "",
      concepto: pays[0]?.concept || "",
      // flags de color (solo se aplican en la 1ª fila)
      hasCheckin: !!r.checkin_at,
      wasContacted: !!r.contacted_at,
      payStatus: String(r.payment_status || "unpaid").toLowerCase(),
    });

    for (let i = 1; i < pays.length; i++) {
      const p = pays[i];
      rows.push({
        _payRow: true, // subfila de pago (no coloreamos nada acá)
        depto: "", pax: "", nombre: "", tel: "",
        checkin: "", hora_in: "", checkout: "", hora_out: "",
        agencia: "", toPay: "",
        pago: money(p.amount, p.currency),
        metodo: p.method || "",
        concepto: p.concept || "",
      });
    }
  });

  return (
    <div className="tablewrap">
      <div className="btable__toolbar">
        <ExportBottomExcel items={items} />
      </div>

      <table className="table btable">
        <thead>
          <tr>
            <th className="th">Unidad</th>
            <th className="th">PAX</th>
            <th className="th">Nombre</th>
            <th className="th">Teléfono</th>
            <th className="th">Check in</th>
            <th className="th">Hora in</th>
            <th className="th">Check out</th>
            <th className="th">Hora out</th>
            <th className="th">Agencia</th>
            <th className="th">A pagar</th>
            <th className="th">Pago</th>
            <th className="th">Forma de pago</th>
            <th className="th">Concepto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tdDeptoCls = cls("td", !r._payRow && r.hasCheckin && "td--depto-in");
            const tdNameCls  = cls("td", !r._payRow && r.wasContacted && "td--name-contacted");
            const tdPagoCls  = cls(
              "td td--money-dim",
              !r._payRow &&
                (r.payStatus === "paid"
                  ? "td--pay-paid"
                  : r.payStatus === "partial"
                  ? "td--pay-partial"
                  : "td--pay-unpaid")
            );

            return (
              <tr
                key={i}
                className={cls(
                  "tr",
                  r._sepTop && "btr--res-sep",
                  r._payRow && "btr--pay"
                )}
              >
                <td className={tdDeptoCls}>{r.depto}</td>
                <td className="td">{r.pax}</td>
                <td className={tdNameCls}>{r.nombre}</td>
                <td className="td">{r.tel}</td>
                <td className="td">{r.checkin}</td>
                <td className="td">{r.hora_in}</td>
                <td className="td">{r.checkout}</td>
                <td className="td">{r.hora_out}</td>
                <td className="td">{r.agencia}</td>
                <td className="td td--money-strong">{r.toPay}</td>
                <td className={tdPagoCls}>{r.pago}</td>
                <td className="td">{r.metodo}</td>
                <td className="td">{r.concepto}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


/* ---------- App ---------- */

export default function App() {
  const today = DateTime.now().setZone(TZ).toISODate();
  const { list: propsList } = useActiveProperties();
  const [propertyId, setPropertyId] = useState("all");     // NUEVO

  const [dateISO, setDateISO] = useState(today);
  const { loading, items, counts, tab, setActiveTab, page, setPage, totalPages, refetch } =
    useDaily(dateISO, propertyId); 

  // --- NUEVO: estado global de popovers ---
  const [activePopover, setActivePopover] = useState(null);
  const handlePopoverToggle = (popoverId) => {
    setActivePopover((curr) => (curr === popoverId ? null : popoverId));
  };
  const closeAllPopovers = () => setActivePopover(null);

  // Cerrar con Escape
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

  return (
    <div className="app" onClick={closeAllPopovers}>
      <header className="header">
        <div className="header__bar">
          <div className="flex items-center gap-2">
            <h1 className="header__title">Planilla de Hosts</h1>
            <span className="header__date">({dateISO})</span>
          </div>

          <div className="header__actions">
            {/* Selector de propiedad */}
            <select
              className="input--date"                   // mismo estilo que el date
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
          </div>
        )}
      </main>

      <section className="bottom">
        <BottomTable items={items} onOpen={() => { }} />
      </section>
    </div>
  );
}
