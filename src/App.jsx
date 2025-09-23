import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";

/* Helpers */
const fmtDate = (iso) => (iso ? DateTime.fromISO(iso, { zone: TZ }).toISODate() : "");
const cls = (...xs) => xs.filter(Boolean).join(" ");
const toFlag = (cc) => {
  if (!cc || typeof cc !== "string" || cc.length !== 2) return null;
  const A = 127397;
  const up = cc.toUpperCase();
  return String.fromCodePoint(...[...up].map((c) => c.charCodeAt(0) + A));
};

const Chip = ({ label, active, tone = "sky" }) => {
  const onClass = tone === "amber" ? "chip--amber" : "chip--sky";
  return <span className={cls("chip", active ? onClass : "chip--off")}>{label}</span>;
};

function useDaily(dateISO) {
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(null);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState("checkins");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const fetchTab = async (t, indexDoc) => {
    const ids = indexDoc?.[t] || [];
    if (!ids?.length) return setItems([]);
    const { data } = await axios.post("/api/resolveReservations", { ids });
    setItems(data.items || []);
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await axios.get(`/api/dailyIndex?date=${dateISO}`);
        setIdx(data);
        await fetchTab(tab, data);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateISO]);

  const setActiveTab = async (t) => {
    setTab(t);
    setPage(1);
    await fetchTab(t, idx);
  };

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page]);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  return { loading, idx, items: paged, counts: idx?.counts || {}, tab, setActiveTab, page, setPage, totalPages };
}

/* ===== UI ===== */

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
    </div>
  );
}

function Paginator({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pager">
      <button className="pager__btn" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>←</button>
      <span className="pager__label">Página {page} / {totalPages}</span>
      <button className="pager__btn" onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>→</button>
    </div>
  );
}

function StatusBar({ r, onOpen }) {
  const pay =
    r.payment_status === "paid"
      ? <span className="badge badge--paid">Pago</span>
      : r.payment_status === "partial"
      ? <span className="badge badge--partial">Parcial</span>
      : <span className="badge badge--unpaid">Impago</span>;

  return (
    <div className="status">
      <button onClick={() => onOpen?.(r)} className="status__open">Abrir</button>
      {pay}
      <Chip label="Check-out" active={!!r.checkout_at} />
      <Chip label="Check-in" active={!!r.checkin_at} />
      <Chip label="Contactado" active={!!r.contacted_at} tone="amber" />
    </div>
  );
}

function ReservationCard({ r, onOpen }) {
  const depto = r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || "—";
  const phone = r.customer_phone || r.telefono || "";
  const email = r.customer_email || "";
  const flag = toFlag(r.customer_country);
  const inDt = fmtDate(r.arrival_iso);
  const outDt = fmtDate(r.departure_iso);
  const channel = r.source || r.channel_name || "—";

  const deptoTagClass = cls("tag", "tag--depto", r.checkout_at && "tag--depto--out");
  const payBadge =
    r.payment_status === "paid"
      ? <span className="badge badge--paid">Pago</span>
      : r.payment_status === "partial"
      ? <span className="badge badge--partial">Parcial</span>
      : <span className="badge badge--unpaid">Impago</span>;

  // Estados (activo => pinta, inactivo => blanco con borde)
  const pillBase = "pill-fixed";
  const pillContact = cls(pillBase, r.contacted_at ? "pill--contact" : "");
  const pillCheckin = cls(pillBase, r.checkin_at ? "pill--checkin" : "");
  const pillCheckout = cls(pillBase, r.checkout_at ? "pill--checkout" : "");

  return (
    <div className="res-card4 cursor-pointer" onClick={() => onOpen?.(r)}>
      {/* CELDA 1: bloque izquierdo (3 líneas) */}
      <div className="res-cell res-cell--left">
        {/* L1: Depto + Nombre + Bandera */}
        <div className="left__line1">
          <span className={deptoTagClass}>{depto}</span>
          <span className={cls("name", r.contacted_at && "name--contacted")}>
            {r.nombre_huesped || "Sin nombre"}
          </span>
          {flag && <span className="text-sm">{flag}</span>}
        </div>

        {/* L2: Teléfono + Ícono mail (tooltip y mailto) */}
        <div className="left__line2">
          {phone && <span>{phone}</span>}
          {email && (
            <a
              className="mail-link"
              href={`mailto:${email}`}
              title={email}
              onClick={(e) => e.stopPropagation()}
            >
              {/* sobrecito SVG */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
                <path d="m22 8-10 6L2 8" />
              </svg>
            </a>
          )}
        </div>

        {/* L3: RCode + Fechas + Canal */}
        <div className="left__line3">
          {r.id_human && <span className="tag tag--rcode">{r.id_human}</span>}
          <span>In: {inDt} · Out: {outDt}</span>
          <span className="tag--channel">{channel}</span>
        </div>
      </div>

      {/* CELDA 2: Notas (placeholder por ahora) */}
      <div className="res-cell">
        <div className="notes-box">Notas</div>
      </div>

      {/* CELDA 3: Pagos (placeholder + badge de estado) */}
      <div className="res-cell">
        <div className="payments-box">{payBadge}</div>
      </div>

           {/* CELDA 4: Stack fijo de estados superpuestos */}
      <div className="res-cell" onClick={(e) => e.stopPropagation()}>
        <div className="status-stack">
          <div className={cls(
            "pill-fixed",
            "pill--contact",
            r.contacted_at ? "" : "opacity-60"
          )}>
            Contactado
          </div>
          <div className={cls(
            "pill-fixed",
            "pill--checkin",
            r.checkin_at ? "" : "opacity-60"
          )}>
            Check-in
          </div>
          <div className={cls(
            "pill-fixed",
            "pill--checkout",
            r.checkout_at ? "" : "opacity-60"
          )}>
            Check-out
          </div>
        </div>
      </div>
    </div>
  );
}


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

            // Depto: GRIS por defecto; CELESTE cuando hay check-in
            const deptoClass = cls("td__depto-tag", r.checkin_at && "td__depto-tag--in");

            return (
              <tr key={r.id} className="tr">
                <td className="td">
                  {r.id_human ? <span className="tag tag--rcode">{r.id_human}</span> : "—"}
                </td>
                <td className="td">
                  <span className={deptoClass}>{depto}</span>
                </td>
                <td className="td">{r.adults ?? "-"}</td>
                <td className="td">{r.checkin_at ? "check-in" : ""}</td>
                <td className="td">
                  <span className={cls("td__name", contacted && "name--contacted")}>
                    {r.nombre_huesped || "-"}
                  </span>
                </td>
                <td className="td">{phone || "-"}</td>
                <td className="td">{email || "-"}</td>
                <td className="td">{r.toPay ?? "-"}</td>
                <td className="td">{r.currency || "-"}</td>
                <td className="td">{r.arrival_iso ? "IN" : "OUT"}</td>
                <td className="td">{r.extras || "-"}</td>
                <td className="td">
                  <span className="tag--channel">{r.source || "-"}</span>
                </td>
                <td className="td">
                  <button onClick={() => onOpen(r)} className="text-blue-600 underline">Ver</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Modal({ open, onClose, r, onAction }) {
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Efectivo");
  const [currency, setCurrency] = useState("ARS");
  if (!open || !r) return null;

  const act = async (action, payload) => {
    await axios.post("/api/reservationMutations", { id: r.id, action, payload, user: "host" });
    onAction?.();
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal__header">
          <h3 className="modal__title">
            {r.nombre_huesped} · {r.depto_nombre || r.nombre_depto || r.codigo_depto}
          </h3>
          <button onClick={onClose} className="modal__close">✕</button>
        </div>

        <div className="modal__grid">
          <div className="space-y-2">
            <div className="modal__hint">
              {r.id_human && <span className="tag tag--rcode mr-2">{r.id_human}</span>}
              In: {fmtDate(r.arrival_iso)} · Out: {fmtDate(r.departure_iso)}
            </div>
            <div className="modal__actions">
              <button onClick={() => act("checkin", { when: null })} className={cls("modal__btn","modal__btn--in")}>
                Marcar Check-in (ahora)
              </button>
              <button onClick={() => act("contact", { when: null })} className={cls("modal__btn","modal__btn--contact")}>
                Marcar Contactado (ahora)
              </button>
            </div>
            <div className="space-y-1">
              <label className="text-sm">Nueva nota</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} className="modal__field h-20" />
              <button disabled={!note.trim()} onClick={() => act("addNote", { text: note })} className="px-3 py-2 rounded bg-gray-900 text-white disabled:opacity-40">
                Guardar nota
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm">Nuevo pago</label>
            <input placeholder="Monto" value={amount} onChange={(e) => setAmount(e.target.value)} className="modal__field" />
            <div className="flex gap-2">
              <select value={method} onChange={(e) => setMethod(e.target.value)} className="modal__field w-1/2">
                <option>Efectivo</option>
                <option>Stripe</option>
                <option>Transferencia</option>
              </select>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="modal__field w-1/2">
                <option>ARS</option>
                <option>USD</option>
              </select>
            </div>
            <button onClick={() => act("addPayment", { amount, method, currency })} className="w-full px-3 py-2 rounded bg-green-700 text-white">
              Registrar pago
            </button>
          </div>
        </div>

        <div className="modal__footer">
          <button onClick={onClose} className="btn">Cerrar</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const today = DateTime.now().setZone(TZ).toISODate();
  const [dateISO, setDateISO] = useState(today);
  const { loading, items, counts, tab, setActiveTab, page, setPage, totalPages } = useDaily(dateISO);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(null);

  const openModal = (r) => { setCurrent(r); setOpen(true); };
  const onActionDone = () => setCurrent(null);
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
            <button className="btn" onClick={() => goto(-1)}>← Ayer</button>
            <button className="btn" onClick={() => setDateISO(DateTime.now().setZone(TZ).toISODate())}>Hoy</button>
            <button className="btn" onClick={() => goto(1)}>Mañana →</button>
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
            {items.length === 0 && <div className="empty">Sin reservas</div>}
            <div className="list__grid">
              {items.map((r) => <ReservationCard key={r.id} r={r} onOpen={openModal} />)}
            </div>
          </div>
        )}
      </main>

      <section className="bottom">
        <BottomTable items={items} onOpen={openModal} />
      </section>

      <Modal open={open} onClose={()=>setOpen(false)} r={current} onAction={onActionDone} />
    </div>
  );
}


