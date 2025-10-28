// =========================================================
// LiquidacionesPage.jsx
// - Filtros con labels y botón "Mostrar resultados"
// - Selector de Departamento simple (no múltiple)
// - Rango por defecto = mes en curso (TZ AR)
// - Vista "Por unidad" → secciones "Pagos en $" y "Pagos en USD"
// - Columna "Forma de cobro" (método · concepto)
// - Inputs con separadores de miles y ancho ~15ch
// - Neto en moneda de la fila (convierte H/I/J si hace falta)
// - Mutaciones con debounce → se guardan en /api/liquidaciones/accountingMutations
// - Estilos: ver LiquidacionesPage.css
// =========================================================

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import { useAuth } from '../context/AuthContext';
import HeaderUserInline from '../components/HeaderUserInline';
import './LiquidacionesPage.css';

// ---------- Constantes de formato ----------
const TZ = 'America/Argentina/Buenos_Aires';

// Intl para miles/decimales en ARS y USD
const nfARS = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfUSD = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ===== Helpers de formato (es-AR) =====
// Convierte "1.234,56" → 1234.56
function parseNumberEs(str) {
    if (str == null) return NaN;
    const s = String(str).trim().replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
}

// Formatea 1234.56 → "1.234,56"
function formatNumberEs(n, _cur) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Muestra monto con símbolo según moneda
function moneyIntl(amount, cur = 'USD') {
    const v = Number(amount) || 0;
    const currency = String(cur).toUpperCase();
    return new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(v);
}


// ---------- Data hooks (propiedades / departamentos) ----------
function useProperties() {
    const [list, setList] = useState([]);
    useEffect(() => {
        (async () => {
            const { data } = await axios.get('/api/properties');
            const raw = Array.isArray(data?.items) ? data.items : [];
            setList(raw.map(p => ({ id: p.id, nombre: p.nombre })));
        })();
    }, []);
    return list;
}

function useDepartments(propertyId) {
    const [list, setList] = useState([]);
    useEffect(() => {
        (async () => {
            if (!propertyId || propertyId === 'all') { setList([]); return; }
            const { data } = await axios.get('/api/liquidaciones/departments', { params: { property: propertyId } });
            setList(Array.isArray(data?.items) ? data.items : []);
        })();
    }, [propertyId]);
    return list;
}

// ---------- FX helpers ----------
const getFxFromReservation = (res) => {
    // Usa usd_fx_on_checkin: promedio compra/venta, o venta si no hay compra
    try {
        const fx = res?.usd_fx_on_checkin || {};
        const buy = Number(fx.compra);
        const sell = Number(fx.venta);
        if (Number.isFinite(buy) && Number.isFinite(sell) && buy > 0 && sell > 0) return +((buy + sell) / 2).toFixed(4);
        if (Number.isFinite(sell) && sell > 0) return +sell.toFixed(4);
        if (Number.isFinite(buy) && buy > 0) return +buy.toFixed(4);
    } catch { }
    return null;
};

function getFxRateForRow(res, fallback) {
    try {
        const fx = res?.usd_fx_on_checkin || {};
        const buy = Number(fx.compra);
        const sell = Number(fx.venta);
        if (Number.isFinite(sell) && sell > 0) return sell;
        if (Number.isFinite(buy) && buy > 0) return buy;
    } catch { }
    return Number.isFinite(fallback) ? fallback : null;
}

// ---------- Transforma reservas en filas por moneda ----------
function buildByCurrency(items = []) {
    const out = { ARS: [], USD: [] };

    for (const res of items) {
        const pays = Array.isArray(res.payments) ? res.payments : [];
        if (!pays.length) continue;

        const fx = getFxRateForRow(res, null); // para convertir H/I/J si hace falta

        for (let i = 0; i < pays.length; i++) {
            const p = pays[i];
            const amt = Number(p.amount);
            const cur = String(p.currency || '').toUpperCase();
            if (!Number.isFinite(amt) || amt <= 0) continue;
            if (cur !== 'ARS' && cur !== 'USD') continue;

            const row = {
                // --- datos visibles ---
                id_human: res.id_human || res.id || '—',
                huesped: res.nombre_huesped || '—',
                checkin: res.arrival_iso ? DateTime.fromISO(res.arrival_iso).toFormat('dd/MM/yyyy') : '—',
                checkout: res.departure_iso ? DateTime.fromISO(res.departure_iso).toFormat('dd/MM/yyyy') : '—',
                canal: res.source || res.channel_name || '—',

                // forma de cobro
                pay_method: p.method || '',
                pay_concept: p.concept || '',

                // monetarios de la fila
                pay_currency: cur,
                pay_amount: amt,          // bruto mostrado (en su moneda)

                // refs internas
                res_id: res.id,
                _res: res,
                fx_used: fx,
            };

            out[cur].push(row);
        }
    }

    // (opcional) orden por fecha de checkin/id_human
    const sortFn = (a, b) => String(a.checkin).localeCompare(String(b.checkin)) || String(a.id_human).localeCompare(String(b.id_human));
    out.ARS.sort(sortFn);
    out.USD.sort(sortFn);

    return out;
}

// =========================================================
// Componente principal
// =========================================================
export default function LiquidacionesPage() {
    // ----- A) Filtros -----
    const now = DateTime.now().setZone(TZ);
    const monthStart = now.startOf('month').toISODate();
    const monthEnd = now.endOf('month').toISODate();

    const propsList = useProperties();
    const [propertyId, setPropertyId] = useState('all');

    const depts = useDepartments(propertyId);
    const deptOptions = useMemo(() => depts.map(d => ({ id: d.codigo || d.id, label: d.nombre })), [depts]);
    const [deptId, setDeptId] = useState(''); // selector simple
    const deptsDisabled = !propertyId || propertyId === 'all';

    const [fromISO, setFromISO] = useState(monthStart);
    const [toISO, setToISO] = useState(monthEnd);

    // Si seguís usando dos modos, mantenemos el switch (afecta solo el render)
    const [mode, setMode] = useState('unidad'); // 'unidad' | 'propiedad'

    // ----- B) Datos -----
    const [loading, setLoading] = useState(false);
    const [items, setItems] = useState([]);    // reservas crudas
    const [byCur, setByCur] = useState({ ARS: [], USD: [] });
    const [groupsProp, setGroupsProp] = useState(null); // si querés seguir mostrando "por propiedad"
    const [hasRun, setHasRun] = useState(false);

    const fetchData = async () => {
        setLoading(true);
        try {
            const params = {
                property: propertyId,
                from: fromISO,
                to: toISO,
                includePayments: '1', // asegura que vuelvan los pagos
            };
            if (deptId) params.deptId = deptId;

            const { data } = await axios.get('/api/liquidaciones/reservasByCheckin', { params });
            const itemsRaw = Array.isArray(data?.items) ? data.items : [];

            setItems(itemsRaw);
            setByCur(buildByCurrency(itemsRaw));
            setGroupsProp(data?.groups || null);
            setHasRun(true);
        } finally {
            setLoading(false);
        }
    };

    // ----- C) Mutaciones con debounce -----
    const [pending, setPending] = useState({});
    const { user } = useAuth();

    useEffect(() => {
        const t = setTimeout(async () => {
            const ids = Object.keys(pending);
            if (!ids.length) return;

            const batch = { ...pending };
            setPending({}); // optimista

            await Promise.allSettled(
                Object.entries(batch).map(async ([id, payload]) => {
                    await axios.post('/api/liquidaciones/accountingMutations', { id, payload });
                    try {
                        await axios.post('/api/liquidaciones/activityLog', {
                            type: 'acc_update',
                            message: 'edit liquidacion',
                            meta: { id, payload },
                        });
                    } catch { }

                    // Refresco local de NETO (en USD guardado); el render lo reconvierte si la fila es ARS
                    setItems(prev => prev.map(r => {
                        if (r.id !== id) return r;
                        const a = r.accounting || {};
                        const p = payload || {};
                        const bruto = Number(p.brutoUSD ?? a.brutoUSD ?? 0);
                        const comis = Number(p.comisionCanalUSD ?? a.comisionCanalUSD ?? 0);
                        const tasa = Number(p.tasaLimpiezaUSD ?? a.tasaLimpiezaUSD ?? 0);
                        const costo = Number(p.costoFinancieroUSD ?? a.costoFinancieroUSD ?? 0);
                        const netoUSD = +(bruto + comis + tasa + costo).toFixed(2);
                        return { ...r, accounting: { ...a, ...p, netoUSD } };
                    }));

                    // Recalcular agrupación por moneda (por si cambió algo que afecte el render)
                    setByCur(prev => buildByCurrency(
                        (items || []).map(r => (r.id === id ? { ...r, accounting: { ...(r.accounting || {}), ...(batch[id] || {}) } } : r))
                    ));
                })
            );
        }, 600);

        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending, user]);

    // ----- D) Handlers de edición -----
    const onCellEdit = (id, field, valueNumberOrNull) => {
        setPending(prev => ({
            ...prev,
            [id]: { ...(prev[id] || {}), [field]: valueNumberOrNull === '' ? null : Number(valueNumberOrNull) }
        }));
    };
    const onObsEdit = (id, value) => {
        setPending(prev => ({ ...prev, [id]: { ...(prev[id] || {}), observaciones: value } }));
    };

    // -----------------------------------------------------
    // Hook chiquito para manejar inputs monetarios con
    // máscara es-AR mientras se escribe
    // -----------------------------------------------------
    function useMoneyInput(initialNumber = 0, currency = 'USD') {
        const [num, setNum] = React.useState(Number(initialNumber) || 0);
        const [str, setStr] = React.useState(
            Number.isFinite(initialNumber) ? formatNumberEs(initialNumber, currency) : ''
        );

        const onChange = (e) => {
            const s = e.target.value;
            setStr(s);
            const n = parseNumberEs(s);
            if (Number.isFinite(n)) setNum(n);
        };
        const onBlur = () => setStr(formatNumberEs(num, currency));

        // útil si desde afuera querés setear por código
        const setBoth = (v) => {
            const n = Number(v) || 0;
            setNum(n);
            setStr(formatNumberEs(n, currency));
        };

        return { num, str, onChange, onBlur, setBoth };
    }

// -----------------------------------------------------
// Hook chiquito para manejar inputs monetarios con
// máscara es-AR mientras se escribe (recalcula en vivo)
// -----------------------------------------------------
function useMoneyInput(initialNumber = 0, currency = 'USD') {
  const [num, setNum] = React.useState(Number(initialNumber) || 0);
  const [str, setStr] = React.useState(
    Number.isFinite(initialNumber) ? formatNumberEs(initialNumber, currency) : ''
  );

  const onChange = (e) => {
    const s = e.target.value;
    setStr(s);
    const n = parseNumberEs(s);
    setNum(Number.isFinite(n) ? n : 0); // si no parsea o está vacío => 0 en vivo
  };

  const onBlur = () => setStr(formatNumberEs(num, currency));
  const onFocus = (e) => e.target.select();

  // útil si desde afuera querés setear por código
  const setBoth = (v) => {
    const n = Number(v) || 0;
    setNum(n);
    setStr(formatNumberEs(n, currency));
  };

  return { num, str, onChange, onBlur, onFocus, setBoth };
}

// =====================================================
// Render de una fila (Row) para tablas por moneda
// Requiere helpers: parseNumberEs, formatNumberEs, moneyIntl, getFxRateForRow
// Props esperadas en `r`:
//   res_id, _res (la reserva completa para leer accounting y fx)
//   id_human, huesped, checkin, checkout, canal
//   pay_currency ('ARS' | 'USD'), pay_amount (número bruto en su moneda)
//   pay_method, pay_concept, fx_used (opcional; si no viene, se calcula)
// =====================================================
const Row = (r) => {
  const a  = r._res?.accounting || {};
  const fx = r.fx_used || getFxRateForRow(r._res, null) || 0; // TC del check-in

  // EDITABLES (controlados con máscara es-AR)
  const brutoCtl    = useMoneyInput(Number(r.pay_amount)            || 0, r.pay_currency); // bruto en moneda del pago
  const comisionCtl = useMoneyInput(Number(a.comisionCanalUSD)      || 0, 'USD');
  const tasaCtl     = useMoneyInput(Number(a.tasaLimpiezaUSD)       || 0, 'USD');
  const costoCtl    = useMoneyInput(Number(a.costoFinancieroUSD)    || 0, 'USD');
  const [obs, setObs] = React.useState(a.observaciones || '');

  // ---- Neto en vivo (reacciona a cada tecla) ----
  const bruto = brutoCtl.num;
  const comis = comisionCtl.num;
  const tasa  = tasaCtl.num;
  const costo = costoCtl.num;

  // Si pago es ARS, para contabilidad convertimos el bruto a USD con TC
  const brutoUSD = r.pay_currency === 'USD' ? bruto : (fx ? +(bruto / fx).toFixed(2) : 0);

  let netAmount, netCur;
  if (r.pay_currency === 'USD') {
    netAmount = +(brutoUSD + comis + tasa + costo).toFixed(2);
    netCur = 'USD';
  } else {
    const H_ars = fx ? comis * fx : 0;
    const I_ars = fx ? tasa  * fx : 0;
    const J_ars = fx ? costo * fx : 0;
    netAmount = +(bruto + H_ars + I_ars + J_ars).toFixed(2);
    netCur = 'ARS';
  }

  // ---- Guardar fila (sin debounce) ----
  const onSaveRow = async () => {
    const payload = {
      brutoUSD: r.pay_currency === 'USD' ? bruto : brutoUSD,
      comisionCanalUSD: comis,
      tasaLimpiezaUSD:  tasa,
      costoFinancieroUSD: costo,
      observaciones: obs,
    };

    await axios.post('/api/liquidaciones/accountingMutations', { id: r.res_id, payload });
    try {
      await axios.post('/api/liquidaciones/activityLog', {
        type: 'acc_update',
        message: 'manual save liquidacion',
        meta: { id: r.res_id, payload },
      });
    } catch {}
  };

  return (
    <tr className="tr">
      {/* NO EDITABLES → cursor prohibido */}
      <td className="td td--ro">{r.id_human}</td>
      <td className="td td--ro">{r.huesped}</td>
      <td className="td td--ro">{r.checkin}</td>
      <td className="td td--ro">{r.checkout}</td>
      <td className="td td--ro">{r.canal}</td>

      {/* Forma de cobro */}
      <td className="td td--mono td--ro">
        {[r.pay_method || '—', r.pay_concept || ''].filter(Boolean).join(' · ')}
      </td>

      {/* EDITABLES (sin borde, fondo gris) */}
      <td className="td">
        <input
          type="text"
          className="num-input editable"
          value={brutoCtl.str}
          onChange={brutoCtl.onChange}
          onBlur={brutoCtl.onBlur}
          onFocus={brutoCtl.onFocus}
          inputMode="decimal"
        />
      </td>

      <td className="td">
        <input
          type="text"
          className="num-input editable"
          value={comisionCtl.str}
          onChange={comisionCtl.onChange}
          onBlur={comisionCtl.onBlur}
          onFocus={comisionCtl.onFocus}
          inputMode="decimal"
        />
      </td>

      <td className="td">
        <input
          type="text"
          className="num-input editable"
          value={tasaCtl.str}
          onChange={tasaCtl.onChange}
          onBlur={tasaCtl.onBlur}
          onFocus={tasaCtl.onFocus}
          inputMode="decimal"
        />
      </td>

      <td className="td">
        <input
          type="text"
          className="num-input editable"
          value={costoCtl.str}
          onChange={costoCtl.onChange}
          onBlur={costoCtl.onBlur}
          onFocus={costoCtl.onFocus}
          inputMode="decimal"
        />
      </td>

      {/* Neto (reacciona en vivo) */}
      <td className="td td--money-strong td--ro">{moneyIntl(netAmount, netCur)}</td>

      {/* Observaciones editable (sin borde) */}
      <td className="td">
        <input
          type="text"
          className="text-input editable"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
        />
      </td>

      {/* Botón guardar: círculo blanco + tilde negro */}
      <td className="td td--savebtn">
        <button className="icon-btn icon-btn--check" title="Guardar" onClick={onSaveRow} aria-label="Guardar línea">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 7L9 18l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </td>
    </tr>
  );
};


    // =====================================================
    // UI
    // =====================================================
    return (
        <div className="app liq-app">
            {/* ----- Header: título + usuario ----- */}
            <header className="header">
                <div className="header__bar">
                    <div className="header__left">
                        <h1 className="header__title">Liquidaciones</h1>
                        <span className="header__date">{fromISO} → {toISO}</span>
                    </div>
                    <div className="header__right">
                        <HeaderUserInline />
                    </div>
                </div>

                {/* ----- Filtros con labels ----- */}
                <div className="liq-filters">
                    {/* Propiedad */}
                    <div className="liq-filter">
                        <label className="liq-filter__label">Propiedad</label>
                        <select
                            className="input--date liq-filter__control"
                            value={propertyId}
                            onChange={(e) => { setPropertyId(e.target.value); setDeptId(''); }}
                        >
                            <option value="all">Seleccionar…</option>
                            {propsList.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                        </select>
                    </div>

                    {/* Departamento (simple) */}
                    <div className="liq-filter liq-filter--wide">
                        <label className="liq-filter__label">Departamentos</label>
                        <select
                            className="input--date liq-filter__control"
                            value={deptId}
                            onChange={(e) => setDeptId(e.target.value)}
                            disabled={deptsDisabled}
                        >
                            <option value="">Todos</option>
                            {deptOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                    </div>

                    {/* Rango: desde / hasta */}
                    <div className="liq-filter">
                        <label className="liq-filter__label">Desde</label>
                        <input
                            type="date"
                            className="input--date liq-filter__control"
                            value={fromISO}
                            onChange={(e) => setFromISO(e.target.value)}
                        />
                    </div>
                    <div className="liq-filter">
                        <label className="liq-filter__label">Hasta</label>
                        <input
                            type="date"
                            className="input--date liq-filter__control"
                            value={toISO}
                            onChange={(e) => setToISO(e.target.value)}
                        />
                    </div>

                    {/* Acciones */}
                    <div className="liq-actions">
                        <button
                            className={`btn ${mode === 'unidad' ? 'btn--active' : ''}`}
                            onClick={() => setMode('unidad')}
                        >
                            Por unidad
                        </button>
                        <button
                            className={`btn ${mode === 'propiedad' ? 'btn--active' : ''}`}
                            onClick={() => setMode('propiedad')}
                        >
                            Por propiedad
                        </button>
                        <button className="btn" onClick={fetchData}>Mostrar resultados</button>
                    </div>
                </div>
            </header>

            {/* ----- Main ----- */}
            <main className="liq-main">
                {loading && <div className="liq-loader">Cargando…</div>}

                {/* ===== Vista POR UNIDAD: por moneda ===== */}
                {!loading && hasRun && mode === 'unidad' && (
                    <>
                        {/* Pagos en ARS */}
                        <section className="liq-card">
                            <h2 className="prop-group__title">Pagos en $</h2>
                            <table className="table btable liq-table">
                                <thead>
                                    <tr>
                                        <th className="th">reserva</th>
                                        <th className="th">Huesped</th>
                                        <th className="th">check in</th>
                                        <th className="th">check out</th>
                                        <th className="th">Canal</th>
                                        <th className="th">Forma de cobro</th>
                                        <th className="th">Cobrado Bruto</th>
                                        <th className="th">Comisión Canal</th>
                                        <th className="th">Tasa limpieza</th>
                                        <th className="th">Costo financiero</th>
                                        <th className="th">Neto</th>
                                        <th className="th">OBSERVACIONES</th>
                                        <th className="th" style={{ width: 50 }} /> {/* columna del botón ✔️ */}
                                    </tr>
                                </thead>
                                <tbody>
                                    {byCur.ARS.length
                                        ? byCur.ARS.map((r, i) => <Row key={`ARS_${r.res_id}_${i}`} {...r} />)
                                        : (
                                            <tr>
                                                <td className="td" colSpan={12} style={{ opacity: .6 }}>Sin pagos en ARS</td>
                                            </tr>
                                        )}
                                </tbody>
                            </table>
                        </section>

                        {/* Pagos en USD */}
                        <section className="liq-card">
                            <h2 className="prop-group__title">Pagos en USD</h2>
                            <table className="table btable liq-table">
                                <thead>
                                    <tr>
                                        <th className="th">reserva</th>
                                        <th className="th">Huesped</th>
                                        <th className="th">check in</th>
                                        <th className="th">check out</th>
                                        <th className="th">Canal</th>
                                        <th className="th">Forma de cobro</th>
                                        <th className="th">Cobrado Bruto</th>
                                        <th className="th">Comisión Canal</th>
                                        <th className="th">Tasa limpieza</th>
                                        <th className="th">Costo financiero</th>
                                        <th className="th">Neto</th>
                                        <th className="th">OBSERVACIONES</th>
                                        <th className="th" style={{ width: 50 }} /> {/* columna del botón ✔️ */}
                                    </tr>
                                </thead>
                                <tbody>
                                    {byCur.USD.length
                                        ? byCur.USD.map((r, i) => <Row key={`USD_${r.res_id}_${i}`} {...r} />)
                                        : (
                                            <tr>
                                                <td className="td" colSpan={12} style={{ opacity: .6 }}>Sin pagos en USD</td>
                                            </tr>
                                        )}
                                </tbody>
                            </table>
                        </section>
                    </>
                )}

                {/* ===== Vista POR PROPIEDAD (opcional, como la tenías) ===== */}
                {!loading && hasRun && mode === 'propiedad' && groupsProp && (
                    <div style={{ display: 'grid', gap: 16 }}>
                        {/* ARS */}
                        <section className="liq-card">
                            <h2 className="prop-group__title">Reservas en $</h2>
                            {Object.entries(groupsProp.ARS || {}).map(([deptKey, obj]) => (
                                <div key={'ARS_' + deptKey} className="prop-group">
                                    <h3 className="prop-group__title">{obj.depto || deptKey}</h3>
                                    <table className="table" style={{ width: '100%' }}>
                                        <thead>
                                            <tr>
                                                <th className="th">reserva</th>
                                                <th className="th">Huesped</th>
                                                <th className="th">check in</th>
                                                <th className="th">check out</th>
                                                <th className="th">Canal</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {obj.list.map(r => (
                                                <tr key={r.id} className="tr">
                                                    <td className="td">{r.id_human || r.id}</td>
                                                    <td className="td">{r.nombre_huesped || '—'}</td>
                                                    <td className="td">{r.arrival_iso || '—'}</td>
                                                    <td className="td">{r.departure_iso || '—'}</td>
                                                    <td className="td">{r.channel_name || '—'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ))}
                        </section>

                        {/* USD */}
                        <section className="liq-card">
                            <h2 className="prop-group__title">Reservas en USD</h2>
                            {Object.entries(groupsProp.USD || {}).map(([deptKey, obj]) => (
                                <div key={'USD_' + deptKey} className="prop-group">
                                    <h3 className="prop-group__title">{obj.depto || deptKey}</h3>
                                    <table className="table" style={{ width: '100%' }}>
                                        <thead>
                                            <tr>
                                                <th className="th">reserva</th>
                                                <th className="th">Huesped</th>
                                                <th className="th">check in</th>
                                                <th className="th">check out</th>
                                                <th className="th">Canal</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {obj.list.map(r => (
                                                <tr key={r.id} className="tr">
                                                    <td className="td">{r.id_human || r.id}</td>
                                                    <td className="td">{r.nombre_huesped || '—'}</td>
                                                    <td className="td">{r.arrival_iso || '—'}</td>
                                                    <td className="td">{r.departure_iso || '—'}</td>
                                                    <td className="td">{r.channel_name || '—'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ))}
                        </section>
                    </div>
                )}
            </main>
        </div>
    );
}





