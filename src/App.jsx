import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";

const badge = (label, cls) => (
  <span className={`px-2 py-0.5 text-xs rounded-md ${cls}`}>{label}</span>
);

function useDaily(dateISO) {
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(null);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState("checkins"); // 'checkins' | 'stays' | 'checkouts'

  useEffect(() => {
    (async () => {
      setLoading(true);
      // 1) obtener índice (ids)
      const { data: indexRes } = await axios.get(`/api/dailyIndex?date=${dateISO}`);
      setIdx(indexRes);

      // 2) resolver reservas del tab inicial
      const ids = (indexRes?.[tab] || []);
      const { data: resolved } = await axios.post(`/api/resolveReservations`, { ids });
      setItems(resolved.items || []);
      setLoading(false);
    })();
  }, [dateISO]);

  const setActiveTab = async (t) => {
    setTab(t);
    if (!idx) return;
    const ids = idx?.[t] || [];
    const { data: resolved } = await axios.post(`/api/resolveReservations`, { ids });
    setItems(resolved.items || []);
  };

  return { loading, idx, items, tab, setActiveTab };
}

function RowItem({ r, onOpen }) {
  // Colores/estados
  const isCheckedIn = !!r.checkin_at; // celeste
  const contacted = !!r.contacted_at; // amarillo
  const pay = r.payment_status;       // red/green/amber

  return (
    <div
      className="flex items-center justify-between border rounded-lg p-3 hover:bg-gray-50 cursor-pointer"
      onClick={() => onOpen(r)}
    >
      <div className="flex items-center gap-3">
        <div className={`w-2 h-6 rounded ${isCheckedIn ? "bg-sky-400" : "bg-gray-300"}`} />
        <div className="flex flex-col">
          <div className="font-medium">
            <span className={`${contacted ? "bg-yellow-200 px-1 rounded" : ""}`}>
              {r.nombre_huesped || "Sin nombre"}
            </span>{" "}
            {badge(r.source || "Canal", "bg-gray-100")}
          </div>
          <div className="text-xs text-gray-500">
            {r.codigo_depto} · In: {r.arrival_iso} · Out: {r.departure_iso}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {pay === "paid" && badge("Pago", "bg-green-200")}
        {pay === "partial" && badge("Parcial", "bg-amber-200")}
        {(!pay || pay === "unpaid") && badge("Impago", "bg-rose-200")}
        <button className="text-sm px-3 py-1 rounded bg-black text-white">Abrir</button>
      </div>
    </div>
  );
}

function BottomSheet({ items, onOpen }) {
  return (
    <div className="h-full overflow-auto border-t">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white shadow">
          <tr>
            <th className="text-left p-2">Depto</th>
            <th className="text-left p-2">PAX</th>
            <th className="text-left p-2">Hora in/out</th>
            <th className="text-left p-2">Nombre</th>
            <th className="text-left p-2">Teléfono</th>
            <th className="text-left p-2">A pagar</th>
            <th className="text-left p-2">Moneda</th>
            <th className="text-left p-2">IN/OUT</th>
            <th className="text-left p-2">Extras</th>
            <th className="text-left p-2">Agencia</th>
            <th className="text-left p-2">Notas/Pagos</th>
          </tr>
        </thead>
        <tbody>
          {items.map(r => (
            <tr key={r.id} className="border-b hover:bg-gray-50">
              <td className="p-2">{r.codigo_depto}</td>
              <td className="p-2">{r.adults ?? "-"}</td>
              <td className="p-2">{r.checkin_at ? "check-in" : ""}</td>
              <td className="p-2">
                <span className={`${r.contacted_at ? "bg-yellow-200 px-1 rounded" : ""}`}>
                  {r.nombre_huesped}
                </span>
              </td>
              <td className="p-2">{r.customer_phone || "-"}</td>
              <td className="p-2">{r.toPay ?? "-"}</td>
              <td className="p-2">{r.currency || "-"}</td>
              <td className="p-2">
                {r.arrival_iso === r.departure_iso ? "DayUse" : r.arrival_iso ? "IN" : "OUT"}
              </td>
              <td className="p-2 text-gray-500">{r.extras || "-"}</td>
              <td className="p-2">{r.source || "-"}</td>
              <td className="p-2">
                <button onClick={() => onOpen(r)} className="text-blue-600 underline">Ver</button>
              </td>
            </tr>
          ))}
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
    onAction?.(); onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-2xl p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">
            {r.nombre_huesped} · {r.codigo_depto}
          </h3>
          <button onClick={onClose} className="text-gray-500">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="text-sm text-gray-600">
              In: {r.arrival_iso} · Out: {r.departure_iso}
            </div>
            <button
              onClick={() => act("checkin", { when: null })}
              className="w-full px-3 py-2 rounded bg-sky-600 text-white"
            >
              Marcar Check-in (ahora)
            </button>
            <button
              onClick={() => act("contact", { when: null })}
              className="w-full px-3 py-2 rounded bg-amber-600 text-white"
            >
              Marcar Contactado (ahora)
            </button>
            <div className="space-y-1">
              <label className="text-sm">Nueva nota</label>
              <textarea value={note} onChange={e=>setNote(e.target.value)} className="w-full border rounded p-2 h-20" />
              <button
                disabled={!note.trim()}
                onClick={() => act("addNote", { text: note })}
                className="px-3 py-2 rounded bg-gray-900 text-white disabled:opacity-40"
              >
                Guardar nota
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm">Nuevo pago</label>
            <input
              placeholder="Monto"
              value={amount}
              onChange={e=>setAmount(e.target.value)}
              className="w-full border rounded p-2"
            />
            <div className="flex gap-2">
              <select value={method} onChange={e=>setMethod(e.target.value)} className="border rounded p-2 w-1/2">
                <option>Efectivo</option><option>Stripe</option><option>Transferencia</option>
              </select>
              <select value={currency} onChange={e=>setCurrency(e.target.value)} className="border rounded p-2 w-1/2">
                <option>ARS</option><option>USD</option>
              </select>
            </div>
            <button
              onClick={() => act("addPayment", { amount, method, currency })}
              className="w-full px-3 py-2 rounded bg-green-700 text-white"
            >
              Registrar pago
            </button>
          </div>
        </div>

        <div className="mt-4 text-right">
          <button onClick={onClose} className="px-3 py-2 rounded border">Cerrar</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const today = DateTime.now().setZone(TZ).toISODate();
  const [dateISO, setDateISO] = useState(today);
  const { loading, idx, items, tab, setActiveTab } = useDaily(dateISO);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(null);

  const openModal = (r) => { setCurrent(r); setOpen(true); };
  const onActionDone = async () => {
    // refetch current tab quickly
    const ids = idx?.[tab] || [];
    const { data: resolved } = await axios.post(`/api/resolveReservations`, { ids });
    // naive refresh: replace current only
    // (para hacerlo fino, deberías levantar estado al hook)
    setCurrent(null);
  };

  const goto = (offsetDays) => {
    const d = DateTime.fromISO(dateISO, { zone: TZ }).plus({ days: offsetDays }).toISODate();
    setDateISO(d);
  };

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="p-3 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Planilla de Hosts</h1>
          <span className="text-gray-500">({dateISO})</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={()=>goto(-1)} className="px-2 py-1 border rounded">← Ayer</button>
          <button onClick={()=>setDateISO(DateTime.now().setZone(TZ).toISODate())} className="px-2 py-1 border rounded">Hoy</button>
          <button onClick={()=>goto(1)} className="px-2 py-1 border rounded">Mañana →</button>
          <input
            type="date"
            value={dateISO}
            onChange={e=>setDateISO(e.target.value)}
            className="border rounded p-1"
          />
        </div>
      </div>

      {/* Top 70% */}
      <div className="flex-1 grid grid-rows-[auto,1fr] p-3 gap-3">
        {/* Tabs */}
        <div className="flex gap-2">
          {["checkins","stays","checkouts"].map(t => (
            <button
              key={t}
              onClick={()=>setActiveTab(t)}
              className={`px-3 py-2 rounded-full border ${tab===t?"bg-black text-white":"bg-white"}`}
            >
              {t==="checkins" && "Check-ins"}{t==="stays" && "Stays"}{t==="checkouts" && "Check-outs"}
              {idx?.counts?.[t] !== undefined && <span className="ml-2 text-xs opacity-70">({idx.counts[t]})</span>}
            </button>
          ))}
        </div>
        {/* List */}
        <div className="overflow-auto">
          {loading && <div className="text-gray-500">Cargando…</div>}
          {!loading && items.length === 0 && <div className="text-gray-500">Sin reservas</div>}
          <div className="grid gap-2">
            {items.map(r => <RowItem key={r.id} r={r} onOpen={openModal} />)}
          </div>
        </div>
      </div>

      {/* Bottom 30% */}
      <div className="h-[30%] p-3">
        <BottomSheet items={items} onOpen={openModal} />
      </div>

      <Modal open={open} onClose={()=>setOpen(false)} r={current} onAction={onActionDone} />
    </div>
  );
}
