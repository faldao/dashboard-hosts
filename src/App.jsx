import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { DateTime } from "luxon";

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

/* ---------- Chip reutilizable ---------- */
const Chip = ({ label, active, tone = "sky" }) => {
  const onClass = tone === "amber" ? "chip--amber" : "chip--sky";
  return <span className={cls("chip", active ? onClass : "chip--off")}>{label}</span>;
};

/* ---------- data hook ---------- */
function useDaily(dateISO) {
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
      const { data } = await axios.get(`/api/dailyIndex?date=${dateISO}`);
      setIdx(data);
      await fetchTab(t, data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDay(); /* eslint-disable-next-line */ }, [dateISO]);

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
      <Btn id="checkins"  label="Check-ins" />
      <Btn id="stays"     label="Stays" />
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
function ActionButton({ r, type, active, defaultDateISO, defaultTimeHHmm, tone, onDone }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(defaultDateISO || "");
  const [t, setT] = useState(defaultTimeHHmm || "");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const label = type === "contact" ? "Contactado" : type === "checkin" ? "Check-in" : "Check-out";

  const confirm = async () => {
    try {
      setSubmitting(true);

      // Defaults de when por tipo
      let whenISO;
      if (type === "contact") {
        // si no completan, null => serverTimestamp (ahora)
        whenISO = d && t ? toLocalIso(d, t) : null;
      } else if (type === "checkin") {
        const dateUse = d || (r.arrival_iso || "");
        const timeUse = t || "15:00";
        whenISO = toLocalIso(dateUse, timeUse);
      } else {
        const dateUse = d || (r.departure_iso || "");
        const timeUse = t || "11:00";
        whenISO = toLocalIso(dateUse, timeUse);
      }

      // 1) acción principal
      await axios.post("/api/reservationMutations", {
        id: r.id, action: type, payload: { when: whenISO }, user: "host"
      });

      // 2) nota opcional
      const clean = (note || "").trim();
      if (clean) {
        await axios.post("/api/reservationMutations", {
          id: r.id, action: "addNote", payload: { text: clean }, user: "host"
        });
      }

      onDone?.();
      setOpen(false);
      setNote("");
    } finally {
      setSubmitting(false);
    }
  };

  const btnClass = cls(
    "pill-btn",
    tone === "amber" ? "pill-btn--amber" : tone === "sky" ? "pill-btn--sky" : "pill-btn--gray",
    active && (tone === "amber" ? "pill-btn--amber-active" : tone === "sky" ? "pill-btn--sky-active" : "pill-btn--gray-active")
  );

  return (
    <div className="pill-wrap" onClick={(e)=>e.stopPropagation()}>
      <button type="button" className={btnClass} onClick={() => setOpen(v=>!v)} disabled={submitting}>
        {label}
      </button>

      {open && (
        <div className="mini-popover" role="dialog" aria-label={label} onClick={(e)=>e.stopPropagation()}>
          <div className="mini-popover__row">
            <label className="mini-popover__lab">Fecha</label>
            <input type="date" className="mini-popover__field" value={d} onChange={(e)=>setD(e.target.value)} />
          </div>
          <div className="mini-popover__row">
            <label className="mini-popover__lab">Hora</label>
            <input type="time" className="mini-popover__field" value={t} onChange={(e)=>setT(e.target.value)} />
          </div>
          <div className="mini-popover__row mini-popover__row--note">
            <label className="mini-popover__lab">Nota (opcional)</label>
            <textarea className="mini-popover__field h-16" value={note} onChange={(e)=>setNote(e.target.value)} placeholder="Agregar nota…" />
          </div>
          <div className="mini-popover__actions">
            <button type="button" className="mini-popover__btn mini-popover__btn--muted" onClick={()=>setOpen(false)} disabled={submitting}>Cancelar</button>
            <button type="button" className="mini-popover__btn mini-popover__btn--ok" onClick={confirm} disabled={submitting}>
              {submitting ? "Guardando…" : "Confirmar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- UI: ReservationCard (4 celdas) ---------- */
function ReservationCard({ r, onRefresh }) {
  const depto = r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || "—";
  const phone = r.customer_phone || r.telefono || "";
  const email = r.customer_email || "";
  const flag = toFlag(r.customer_country);
  const inDt = fmtDate(r.arrival_iso);
  const outDt = fmtDate(r.departure_iso);
  const channel = r.source || r.channel_name || "—";
  const deptoTagClass = cls("tag", "tag--depto", r.checkout_at && "tag--depto--out");

  const defContactDate = DateTime.now().setZone(TZ).toISODate();
  const defContactTime = DateTime.now().setZone(TZ).toFormat("HH:mm");
  const defInDate = r.arrival_iso || "";
  const defOutDate = r.departure_iso || "";

  return (
    <div className="res-card4">
      {/* CELDA 1: bloque izquierdo (3 líneas) */}
      <div className="res-cell res-cell--left">
        <div className="left__line1">
          <span className={deptoTagClass}>{depto}</span>
          <span className={cls("name", r.contacted_at && "name--contacted")}>
            {r.nombre_huesped || "Sin nombre"}
          </span>
          {flag && <span className="text-sm">{flag}</span>}
        </div>

        <div className="left__line2">
          {phone && <span>{phone}</span>}
          {email && (
            <a
              className="mail-link"
              href={`mailto:${email}`}
              title={email}
              onClick={(e) => e.stopPropagation()}
            >
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
      </div>

      {/* CELDA 2: Notas (placeholder) */}
      <div className="res-cell">
        <div className="notes-box">Notas</div>
      </div>

      {/* CELDA 3: Pagos (placeholder + badge) */}
      <div className="res-cell">
        <div className="payments-box">
          {r.payment_status === "paid"
            ? <span className="badge badge--paid">Pago</span>
            : r.payment_status === "partial"
            ? <span className="badge badge--partial">Parcial</span>
            : <span className="badge badge--unpaid">Impago</span>}
        </div>
      </div>

      {/* CELDA 4: 3 botones con popover */}
      <div className="res-cell">
        <div className="status-stack-new">
          <ActionButton
            r={r}
            type="contact"
            active={!!r.contacted_at}
            defaultDateISO={defContactDate}
            defaultTimeHHmm={defContactTime}
            tone="amber"
            onDone={onRefresh}
          />
          <ActionButton
            r={r}
            type="checkin"
            active={!!r.checkin_at}
            defaultDateISO={defInDate}
            defaultTimeHHmm={"15:00"}
            tone="sky"
            onDone={onRefresh}
          />
          <ActionButton
            r={r}
            type="checkout"
            active={!!r.checkout_at}
            defaultDateISO={defOutDate}
            defaultTimeHHmm={"11:00"}
            tone="gray"
            onDone={onRefresh}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- UI: BottomTable (sin cambios funcionales) ---------- */
function BottomTable({ items, onOpen }) {
  return (
    <div className="tablewrap">
      <table className="table">
        <thead>
          <tr>
            <th className="th">RCode</th>
            <th className="th">Depto</th>
            <th className="th">PAX</th>
            <th className="th">Hora in/out</th>
            <th className="th">Nombre</th>
            <th className="th">Teléfono</th>
            <th className="th">Email</th>
            <th className="th">A pagar</th>
            <th className="th">Moneda</th>
            <th className="th">IN/OUT</th>
            <th className="th">Extras</th>
            <th className="th">Agencia</th>
            <th className="th">Notas/Pagos</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const depto = r.depto_nombre || r.nombre_depto || r.codigo_depto || "—";
            const phone = r.customer_phone || "";
            const email = r.customer_email || "";
            const contacted = !!r.contacted_at;
            const deptoClass = cls("td__depto-tag", r.checkin_at && "td__depto-tag--in");
            return (
              <tr key={r.id} className="tr">
                <td className="td">{r.id_human ? <span className="tag tag--rcode">{r.id_human}</span> : "—"}</td>
                <td className="td"><span className={deptoClass}>{depto}</span></td>
                <td className="td">{r.adults ?? "-"}</td>
                <td className="td">{r.checkin_at ? "check-in" : ""}</td>
                <td className="td"><span className={cls("td__name", contacted && "name--contacted")}>{r.nombre_huesped || "-"}</span></td>
                <td className="td">{phone || "-"}</td>
                <td className="td">{email || "-"}</td>
                <td className="td">{r.toPay ?? "-"}</td>
                <td className="td">{r.currency || "-"}</td>
                <td className="td">{r.arrival_iso ? "IN" : "OUT"}</td>
                <td className="td">{r.extras || "-"}</td>
                <td className="td"><span className="tag--channel">{r.source || "-"}</span></td>
                <td className="td"><button type="button" onClick={() => onOpen(r)} className="text-blue-600 underline">Ver</button></td>
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
  const [dateISO, setDateISO] = useState(today);
  const { loading, items, counts, tab, setActiveTab, page, setPage, totalPages, refetch } = useDaily(dateISO);

  const goto = (offsetDays) => {
    const d = DateTime.fromISO(dateISO, { zone: TZ }).plus({ days: offsetDays }).toISODate();
    setDateISO(d);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header__bar">
          <div className="flex items-center gap-2">
            <h1 className="header__title">Planilla de Hosts</h1>
            <span className="header__date">({dateISO})</span>
          </div>
          <div className="header__actions">
            <button type="button" className="btn" onClick={() => goto(-1)}>← Ayer</button>
            <button type="button" className="btn" onClick={() => setDateISO(DateTime.now().setZone(TZ).toISODate())}>Hoy</button>
            <button type="button" className="btn" onClick={() => goto(1)}>Mañana →</button>
            <input className="input--date" type="date" value={dateISO} onChange={(e)=>setDateISO(e.target.value)} />
          </div>
        </div>
      </header>

      <main className="main">
        <div className="main__top">
          <Tabs tab={tab} onChange={setActiveTab} counts={counts} />
          <Paginator page={page} totalPages={totalPages} onPage={setPage} />
        </div>

        {loading && <div className="loader">Cargando…</div>}

        {!loading && (
          <div className="list">
            {items.length === 0 && <div className="empty empty--as-card">Sin reservas</div>}
            <div className="list__grid">
              {items.map((r) => <ReservationCard key={r.id} r={r} onRefresh={refetch} />)}
            </div>
          </div>
        )}
      </main>

      <section className="bottom">
        {/* Por ahora mantenemos la tabla “tal cual”.
            Le pasamos un no-op al onOpen para no abrir nada. */}
        <BottomTable items={items} onOpen={() => {}} />
      </section>
    </div>
  );
}

