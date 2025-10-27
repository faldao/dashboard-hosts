// =========================================================
// LiquidacionesPage.jsx
// =========================================================
// - Filtros con labels (Propiedad / Departamentos / Rango)
// - Departamentos deshabilitados hasta elegir propiedad
// - Rango por defecto = mes en curso (America/Argentina/Buenos_Aires)
// - Botón “Mostrar resultados” (no auto-fetch)
// - Nada se muestra hasta disparar la búsqueda (hasRun)
// - Vista "Por unidad":
//     * Tabla igual a Planilla (una fila por pago)
//     * Dos secciones: "Pagos en $" y "Pagos en USD"
//     * "Cobrado Bruto": si pago en USD => guarda USD; si pago en ARS => edita ARS y convierte a USD para guardar
// - Vista "Por propiedad": usa groups del backend, con "Reservas en $" / "Reservas en USD" por departamento
// - Encabezados sin letras (G/H/I/J/K)
// - Estilos movidos a LiquidacionesPage.css
// =========================================================

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import HeaderUserInline from '../components/HeaderUserInline';
import { useAuth } from '../context/AuthContext';
import './LiquidacionesPage.css';

const TZ = 'America/Argentina/Buenos_Aires';

// ---------- helpers comunes ----------
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '');
const money = (n, cur = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `${v.toFixed(2)} ${String(cur).toUpperCase()}`;
};

// =========================================================
// Hooks de datos (propiedades / departamentos)
// =========================================================
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

// =========================================================
// Helpers "Planilla": formateos y pagos por reserva
// =========================================================
const fmtDay = (iso) =>
  iso ? DateTime.fromISO(iso, { zone: TZ }).toFormat('dd/MM/yyyy') : '—';

const fmtHourTS = (ts) => {
  if (!ts) return '—';
  if (ts.seconds || ts._seconds) {
    const s = ts.seconds ?? ts._seconds;
    return DateTime.fromSeconds(Number(s), { zone: TZ }).toFormat('HH:mm');
  }
  try {
    const d = DateTime.fromISO(String(ts), { zone: TZ });
    if (d.isValid) return d.toFormat('HH:mm');
  } catch {}
  return '—';
};

// normaliza el array de pagos de una reserva
function getPayments(r) {
  const arr = Array.isArray(r.payments) ? r.payments : [];
  return arr.map(p => ({
    amount: Number(p.amount) || 0,
    currency: String(p.currency || '').toUpperCase(), // 'ARS' | 'USD'
    method: p.method || '',
    concept: p.concept || '',
    usd_equiv: Number(p.usd_equiv) || null,
    fxRateUsed: Number(p.fxRateUsed) || null,
  }));
}

// tasa preferida para convertir ARS → USD (fx del pago > fx de la reserva)
function getFxRateForRow(row, paymentLike) {
  if (paymentLike?.fxRateUsed && Number.isFinite(Number(paymentLike.fxRateUsed)) && Number(paymentLike.fxRateUsed) > 0) {
    return Number(paymentLike.fxRateUsed);
  }
  const fx = row?.usd_fx_on_checkin || {};
  const buy = Number(fx.compra), sell = Number(fx.venta);
  if (Number.isFinite(buy) && Number.isFinite(sell) && buy > 0 && sell > 0) return +(((buy + sell) / 2).toFixed(4));
  if (Number.isFinite(sell) && sell > 0) return +sell.toFixed(4);
  if (Number.isFinite(buy) && buy > 0) return +buy.toFixed(4);
  return null;
}

// construye filas por pago y separa por moneda (ARS / USD) para la vista "por unidad"
function buildPaymentRows(items = []) {
  const out = { ARS: [], USD: [] };

  for (const r of items) {
    const pays = getPayments(r).filter(p => p.currency === 'ARS' || p.currency === 'USD');
    if (!pays.length) continue;

    const base = {
      res_id: r.id,
      id_human: r.id_human || r.id,
      huesped: r.nombre_huesped || '—',
      checkin: fmtDay(r.arrival_iso),
      checkout: fmtDay(r.departure_iso),
      canal: r.source || r.channel_name || '—',
      depto: r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || '—',
      _res: r,
    };

    pays.forEach((p, idx) => {
      const fx = getFxRateForRow(r, p);
      const brutoUSD = p.currency === 'USD'
        ? (Number(p.amount) || 0)
        : (Number(p.usd_equiv) || (fx ? +(Number(p.amount) / fx).toFixed(2) : 0));

      out[p.currency].push({
        ...base,
        _payRow: idx > 0, // filas adicionales como en BottomTable
        pay_amount: Number(p.amount) || 0,
        pay_currency: p.currency,        // 'ARS' | 'USD'
        pay_method: p.method || '',
        pay_concept: p.concept || '',
        fx_used: fx,
        brutoUSD,                        // equivalente USD para neto / persistir
      });
    });
  }
  return out;
}

// =========================================================
// Componente principal
// =========================================================
export default function LiquidacionesPage() {
  // ------------------------------------------
  // A) Filtros: mes actual por defecto
  // ------------------------------------------
  const now = DateTime.now().setZone(TZ);
  const monthStart = now.startOf('month').toISODate();
  const monthEnd   = now.endOf('month').toISODate();

  const propsList = useProperties();
  const [propertyId, setPropertyId] = useState('all');
  const depts = useDepartments(propertyId);
  const [selectedDeptIds, setSelectedDeptIds] = useState([]);   // ids/códigos de depto
  const [fromISO, setFromISO] = useState(monthStart);
  const [toISO, setToISO] = useState(monthEnd);
  const [mode, setMode] = useState('unidad');                   // 'unidad' | 'propiedad'

  // ------------------------------------------
  // B) Datos y control de carga manual
  // ------------------------------------------
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);        // lista plana de reservas (para "unidad")
  const [groups, setGroups] = useState(null);  // agrupado por propiedad/moneda (para "propiedad")
  const [hasRun, setHasRun] = useState(false); // evita mostrar tablas de entrada

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = {
        property: propertyId,
        from: fromISO,
        to: toISO,
      };
      if (selectedDeptIds.length) params.deptIds = selectedDeptIds.join(',');

      const { data } = await axios.get('/api/liquidaciones/reservasByCheckin', { params });
      setRows(Array.isArray(data?.items) ? data.items : []);
      setGroups(data?.groups || null);
      setHasRun(true);
    } finally {
      setLoading(false);
    }
  };

  // NO auto-fetch:
  // useEffect(() => { fetchData(); }, [...])

  // ------------------------------------------
  // C) Mutaciones contables (debounced)
  // ------------------------------------------
  const [pending, setPending] = useState({});
  const { user } = useAuth(); // (interceptor ya mete el Authorization)

  useEffect(() => {
    const t = setTimeout(async () => {
      const ids = Object.keys(pending);
      if (!ids.length) return;

      const batch = { ...pending };
      setPending({}); // actualización optimista

      await Promise.allSettled(
        Object.entries(batch).map(async ([id, payload]) => {
          // 1) persistimos mutación contable
          await axios.post('/api/liquidaciones/accountingMutations', { id, payload });
          // 2) log (best-effort)
          try {
            await axios.post('/api/liquidaciones/activityLog', {
              type: 'acc_update',
              message: 'edit liquidacion',
              meta: { id, payload },
            });
          } catch {}

          // 3) refresco local del neto USD
          setRows(prev => prev.map(r => {
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
        })
      );
    }, 600);
    return () => clearTimeout(t);
  }, [pending, user]);

  // ------------------------------------------
  // D) Handlers de edición
  // ------------------------------------------
  const onCellEdit = (id, field, value) => {
    setPending(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value === '' ? null : Number(value) }
    }));
  };
  const onObsEdit = (id, value) => {
    setPending(prev => ({ ...prev, [id]: { ...(prev[id] || {}), observaciones: value } }));
  };

  // ------------------------------------------
  // E) Opciones de departamentos
  // ------------------------------------------
  const deptOptions = useMemo(
    () => depts.map(d => ({ id: d.codigo || d.id, label: d.nombre })),
    [depts]
  );
  const deptsDisabled = !propertyId || propertyId === 'all';

  // =========================================================
  // Render
  // =========================================================
  return (
    <div className="app liq-app">
      {/* =====================================================
          HEADER
         ===================================================== */}
      <header className="header">
        {/* Barra: título + usuario */}
        <div className="header__bar">
          <div className="header__left">
            <h1 className="header__title">Liquidaciones</h1>
            <span className="header__date">{fromISO} → {toISO}</span>
          </div>
          <div className="header__right">
            <HeaderUserInline />
          </div>
        </div>

        {/* Filtros con labels */}
        <div className="liq-filters">
          {/* Propiedad */}
          <div className="liq-filter">
            <label className="liq-filter__label">Propiedad</label>
            <select
              className="input--date liq-filter__control"
              value={propertyId}
              onChange={(e) => { setPropertyId(e.target.value); setSelectedDeptIds([]); }}
            >
              <option value="all">Seleccionar…</option>
              {propsList.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </div>

          {/* Departamentos (multi) */}
          <div className="liq-filter liq-filter--wide">
            <label className="liq-filter__label">Departamentos</label>
            <select
              className="input--date liq-filter__control"
              multiple
              size={Math.min(6, Math.max(2, deptOptions.length))}
              value={selectedDeptIds}
              onChange={(e) => {
                const vals = Array.from(e.target.selectedOptions).map(o => o.value);
                setSelectedDeptIds(vals);
              }}
              disabled={deptsDisabled}
              title="Unidades"
            >
              {deptOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>

          {/* Rango de fechas */}
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

          {/* Acciones / modos */}
          <div className="liq-actions">
            <button
              className={`btn ${mode === 'unidad' ? 'btn--active' : ''}`}
              onClick={() => setMode('unidad')}
              title="Ver por pagos (una fila por pago)"
            >
              Por unidad
            </button>
            <button
              className={`btn ${mode === 'propiedad' ? 'btn--active' : ''}`}
              onClick={() => setMode('propiedad')}
              title="Ver agrupado por propiedad y moneda"
            >
              Por propiedad
            </button>
            <button className="btn" onClick={fetchData}>Mostrar resultados</button>
          </div>
        </div>
      </header>

      {/* =====================================================
          MAIN
         ===================================================== */}
      <main className="liq-main">
        {loading && <div className="liq-loader">Cargando…</div>}

        {/* ---------------- Vista POR UNIDAD ---------------- */}
        {!loading && hasRun && mode === 'unidad' && (() => {
          const byCur = buildPaymentRows(rows);

          // Cabecera común
          const Header = () => (
            <thead>
              <tr>
                <th className="th">reserva</th>
                <th className="th">Huesped</th>
                <th className="th">check in</th>
                <th className="th">check out</th>
                <th className="th">Canal</th>
                <th className="th">Cobrado Bruto</th>
                <th className="th">Comisión Canal</th>
                <th className="th">Tasa limpieza</th>
                <th className="th">Costo financiero</th>
                <th className="th">Neto</th>
                <th className="th">OBSERVACIONES</th>
              </tr>
            </thead>
          );

          // Fila: una por pago (igual que BottomTable)
          const Row = (r) => {
            const a = r._res?.accounting || {};

            // USD de referencia para neto:
            //  - si ya hay accounting.brutoUSD, se usa
            //  - si no, el equivalente USD calculado desde el pago (brutoUSD)
            const brutoUSD = Number.isFinite(Number(a.brutoUSD))
              ? Number(a.brutoUSD)
              : (Number(r.brutoUSD) || 0);

            const H = Number(a.comisionCanalUSD) || 0;
            const I = Number(a.tasaLimpiezaUSD) || 0;
            const J = Number(a.costoFinancieroUSD) || 0;
            const K = +(brutoUSD + H + I + J).toFixed(2);

            // Para el input “Cobrado Bruto”:
            //  - Si el pago es USD → mostramos y guardamos USD
            //  - Si el pago es ARS → mostramos ARS, pero convertimos a USD al guardar
            const displayValue = r.pay_amount;           // lo que verá en el input
            const displayCur   = r.pay_currency;         // 'USD' | 'ARS'
            const fx           = r.fx_used || null;      // para convertir si es ARS

            return (
              <tr key={`${r.res_id}_${displayCur}_${r._payRow ? 'pay' : 'main'}`} className="tr">
                <td className="td">{r.id_human}</td>
                <td className="td">{r.huesped}</td>
                <td className="td">{r.checkin}</td>
                <td className="td">{r.checkout}</td>
                <td className="td">{r.canal}</td>

                <td className="td">
                  <div className="liq-bruto-wrap">
                    <input
                      type="number"
                      step="0.01"
                      defaultValue={fmt(displayValue)}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (!Number.isFinite(val)) return;

                        if (displayCur === 'USD') {
                          // guarda directo USD
                          onCellEdit(r.res_id, 'brutoUSD', val);
                        } else {
                          // ARS → convertir a USD con fx
                          const usd = fx ? +(val / fx).toFixed(2) : 0;
                          onCellEdit(r.res_id, 'brutoUSD', usd);
                        }
                      }}
                      className="mini-popover__field"
                    />
                    <small className="liq-bruto-hint">
                      {displayCur === 'USD' ? 'USD' : 'ARS → se convierte a USD'}
                    </small>
                  </div>
                </td>

                <td className="td">
                  <input
                    type="number" step="0.01"
                    defaultValue={fmt(a.comisionCanalUSD)}
                    onChange={(e)=>onCellEdit(r.res_id,'comisionCanalUSD',e.target.value)}
                    className="mini-popover__field"
                  />
                </td>

                <td className="td">
                  <input
                    type="number" step="0.01"
                    defaultValue={fmt(a.tasaLimpiezaUSD)}
                    onChange={(e)=>onCellEdit(r.res_id,'tasaLimpiezaUSD',e.target.value)}
                    className="mini-popover__field"
                  />
                </td>

                <td className="td">
                  <input
                    type="number" step="0.01"
                    defaultValue={fmt(a.costoFinancieroUSD)}
                    onChange={(e)=>onCellEdit(r.res_id,'costoFinancieroUSD',e.target.value)}
                    className="mini-popover__field"
                  />
                </td>

                <td className="td td--money-strong">{money(K, 'USD')}</td>

                <td className="td">
                  <input
                    type="text"
                    defaultValue={a.observaciones || ''}
                    onChange={(e)=>onObsEdit(r.res_id, e.target.value)}
                    className="mini-popover__field"
                  />
                  {/* método + concepto del pago (igual que en Planilla) */}
                  <div className="liq-pay-meta">
                    {r.pay_method || '—'} {r.pay_concept ? `· ${r.pay_concept}` : ''}
                  </div>
                </td>
              </tr>
            );
          };

          return (
            <div className="liq-sections">
              {/* === ARS === */}
              <section className="liq-card">
                <h2 className="prop-group__title">Pagos en $</h2>
                <table className="table btable liq-table">
                  <Header />
                  <tbody>
                    {byCur.ARS.map((r) => <Row key={`${r.res_id}_ARS_${r._payRow?1:0}`} {...r} />)}
                    {!byCur.ARS.length && (
                      <tr><td className="td" colSpan={11} style={{opacity:.6}}>Sin pagos en ARS</td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              {/* === USD === */}
              <section className="liq-card">
                <h2 className="prop-group__title">Pagos en USD</h2>
                <table className="table btable liq-table">
                  <Header />
                  <tbody>
                    {byCur.USD.map((r) => <Row key={`${r.res_id}_USD_${r._payRow?1:0}`} {...r} />)}
                    {!byCur.USD.length && (
                      <tr><td className="td" colSpan={11} style={{opacity:.6}}>Sin pagos en USD</td></tr>
                    )}
                  </tbody>
                </table>
              </section>
            </div>
          );
        })()}

        {/* -------------- Vista POR PROPIEDAD -------------- */}
        {!loading && hasRun && mode === 'propiedad' && groups && (
          <div className="liq-sections">
            {/* Bloque ARS */}
            <section className="liq-card">
              <h2 className="prop-group__title">Reservas en $</h2>
              {Object.entries(groups.ARS || {}).map(([deptKey, obj]) => (
                <div key={'ARS_' + deptKey} className="prop-group">
                  <h3 className="prop-group__title">{obj.depto || deptKey}</h3>
                  <table className="table liq-table">
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

            {/* Bloque USD */}
            <section className="liq-card">
              <h2 className="prop-group__title">Reservas en USD</h2>
              {Object.entries(groups.USD || {}).map(([deptKey, obj]) => (
                <div key={'USD_' + deptKey} className="prop-group">
                  <h3 className="prop-group__title">{obj.depto || deptKey}</h3>
                  <table className="table liq-table">
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

        {/* Estado "sin resultados" cuando ya buscaste */}
        {!loading && hasRun && mode === 'unidad' && !buildPaymentRows(rows).ARS.length && !buildPaymentRows(rows).USD.length && (
          <div className="liq-empty">No hay resultados para los filtros seleccionados.</div>
        )}
      </main>
    </div>
  );
}



