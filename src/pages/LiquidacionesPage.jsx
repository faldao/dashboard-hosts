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
const nfUSD = new Intl.NumberFormat('en-US',  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Formatea número con miles según moneda
const formatNumberEs = (n, currency) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return currency === 'USD' ? nfUSD.format(v) : nfARS.format(v);
};

// Parsea "1.234.567,89" → 1234567.89
const parseNumberEs = (s) => {
  if (s == null) return NaN;
  const str = String(s).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(str);
  return Number.isFinite(n) ? n : NaN;
};

// Para mostrar dinero con símbolo/moneda correctos
const moneyIntl = (n, currency) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (currency === 'USD') return nfUSD.format(v) + ' USD';
  return '$ ' + nfARS.format(v);
};

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
  } catch {}
  return null;
};

const getFxRateForRow = (res, fallback = null) => {
  const r = Number(getFxFromReservation(res));
  if (Number.isFinite(r) && r > 0) return r;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
};

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
        checkin: res.arrival_iso || '—',
        checkout: res.departure_iso || '—',
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
  const monthEnd   = now.endOf('month').toISODate();

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
          } catch {}

          // Refresco local de NETO (en USD guardado); el render lo reconvierte si la fila es ARS
          setItems(prev => prev.map(r => {
            if (r.id !== id) return r;
            const a = r.accounting || {};
            const p = payload || {};
            const bruto = Number(p.brutoUSD ?? a.brutoUSD ?? 0);
            const comis = Number(p.comisionCanalUSD ?? a.comisionCanalUSD ?? 0);
            const tasa  = Number(p.tasaLimpiezaUSD ?? a.tasaLimpiezaUSD ?? 0);
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

  // =====================================================
  // Render de una fila (Row) para tablas por moneda
  // =====================================================
  const Row = (r) => {
    const a  = r._res?.accounting || {};
    const fx = r.fx_used || getFxRateForRow(r._res, null) || 0;

    // BRUTO mostrado (en moneda del pago)
    const brutoShown = Number(r.pay_amount) || 0;

    // BRUTO en USD (para guardar si el usuario edita)
    const brutoUSD = r.pay_currency === 'USD'
      ? brutoShown
      : (fx ? +(brutoShown / fx).toFixed(2) : 0);

    // Edit "Cobrado Bruto" → guarda en USD
    const onChangeBruto = (e) => {
      const raw = e.target.value;
      const n = parseNumberEs(raw);
      if (!Number.isFinite(n)) return;
      if (r.pay_currency === 'USD') {
        onCellEdit(r.res_id, 'brutoUSD', n);
      } else {
        const usd = fx ? +(n / fx).toFixed(2) : 0;
        onCellEdit(r.res_id, 'brutoUSD', usd);
      }
    };
    const onBlurFormatBruto = (e) => {
      const n = parseNumberEs(e.target.value);
      e.target.value = Number.isFinite(n) ? formatNumberEs(n, r.pay_currency) : '';
    };

    // Edit H/I/J (siempre en USD)
    const onEditUSD = (field) => (e) => {
      const n = parseNumberEs(e.target.value);
      onCellEdit(r.res_id, field, Number.isFinite(n) ? n : null);
    };
    const onBlurUSD = (e) => {
      const n = parseNumberEs(e.target.value);
      e.target.value = Number.isFinite(n) ? formatNumberEs(n, 'USD') : '';
    };

    // NETO: suma bruto + H + I + J (según moneda de la fila)
    const H_usd = Number(a.comisionCanalUSD) || 0;
    const I_usd = Number(a.tasaLimpiezaUSD) || 0;
    const J_usd = Number(a.costoFinancieroUSD) || 0;

    let netAmount, netCur;
    if (r.pay_currency === 'USD') {
      netAmount = +(brutoUSD + H_usd + I_usd + J_usd).toFixed(2);
      netCur = 'USD';
    } else {
      const H_ars = fx ? H_usd * fx : 0;
      const I_ars = fx ? I_usd * fx : 0;
      const J_ars = fx ? J_usd * fx : 0;
      netAmount = +(brutoShown + H_ars + I_ars + J_ars).toFixed(2);
      netCur = 'ARS';
    }

    return (
      <tr className="tr">
        <td className="td">{r.id_human}</td>
        <td className="td">{r.huesped}</td>
        <td className="td">{r.checkin}</td>
        <td className="td">{r.checkout}</td>
        <td className="td">{r.canal}</td>

        {/* Forma de cobro (método · concepto) */}
        <td className="td td--mono">{[r.pay_method || '—', r.pay_concept || ''].filter(Boolean).join(' · ')}</td>

        {/* Cobrado Bruto (en moneda del pago) */}
        <td className="td">
          <input
            type="text"
            defaultValue={formatNumberEs(brutoShown, r.pay_currency)}
            onChange={onChangeBruto}
            onBlur={onBlurFormatBruto}
            className="num-input"
            maxLength={20}
          />
        </td>

        {/* Comisión Canal (USD) */}
        <td className="td">
          <input
            type="text"
            defaultValue={formatNumberEs(a.comisionCanalUSD ?? '', 'USD')}
            onChange={onEditUSD('comisionCanalUSD')}
            onBlur={onBlurUSD}
            className="num-input"
            maxLength={20}
          />
        </td>

        {/* Tasa limpieza (USD) */}
        <td className="td">
          <input
            type="text"
            defaultValue={formatNumberEs(a.tasaLimpiezaUSD ?? '', 'USD')}
            onChange={onEditUSD('tasaLimpiezaUSD')}
            onBlur={onBlurUSD}
            className="num-input"
            maxLength={20}
          />
        </td>

        {/* Costo financiero (USD) */}
        <td className="td">
          <input
            type="text"
            defaultValue={formatNumberEs(a.costoFinancieroUSD ?? '', 'USD')}
            onChange={onEditUSD('costoFinancieroUSD')}
            onBlur={onBlurUSD}
            className="num-input"
            maxLength={20}
          />
        </td>

        {/* Neto (en moneda de la fila) */}
        <td className="td td--money-strong">{moneyIntl(netAmount, netCur)}</td>

        {/* Observaciones (SIN forma de cobro debajo) */}
        <td className="td">
          <input
            type="text"
            defaultValue={a.observaciones || ''}
            onChange={(e) => onObsEdit(r.res_id, e.target.value)}
            className="mini-popover__field"
          />
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





