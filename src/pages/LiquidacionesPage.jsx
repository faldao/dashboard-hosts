// =========================================================
// LiquidacionesPage.jsx
// - Filtros con labels (Propiedad / Departamentos / Rango)
// - Deptos deshabilitados hasta elegir propiedad
// - Rango por defecto = mes en curso
// - Botón “Mostrar resultados” (no auto-fetch)
// - Tabla no muestra nada hasta que se dispare la búsqueda
// - Encabezados sin letras (G/H/I/J/K)
// - “Cobrado Bruto” precargado con paid_guest_usd si no hay accounting.brutoUSD
// - Estilos movidos a LiquidacionesPage.css
// =========================================================

import { useAuth } from '../context/AuthContext';
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import HeaderUserInline from '../components/HeaderUserInline';
import './LiquidacionesPage.css';

const TZ = 'America/Argentina/Buenos_Aires';
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '');

const money = (n, cur = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `${v.toFixed(2)} ${String(cur).toUpperCase()}`;
};

// -------- helpers de datos --------
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

export default function LiquidacionesPage() {
  // -------------------------------------------------------
  // A) Estado de filtros
  //    - Rango por defecto: mes en curso (zona AR)
  // -------------------------------------------------------
  const now = DateTime.now().setZone(TZ);
  const monthStart = now.startOf('month').toISODate();
  const monthEnd   = now.endOf('month').toISODate();

  const propsList = useProperties();
  const [propertyId, setPropertyId] = useState('all');
  const depts = useDepartments(propertyId);
  const [selectedDeptIds, setSelectedDeptIds] = useState([]); // codigos/ids
  const [fromISO, setFromISO] = useState(monthStart);
  const [toISO, setToISO] = useState(monthEnd);
  const [mode, setMode] = useState('unidad'); // 'unidad' | 'propiedad'

  // -------------------------------------------------------
  // B) Datos y control de carga manual
  // -------------------------------------------------------
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);      // lista plana (por unidad)
  const [groups, setGroups] = useState(null); // groups.ARS/USD.{depto}.list
  const [hasRun, setHasRun] = useState(false); // evita mostrar tabla al inicio

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = {
        property: propertyId,
        from: fromISO,
        to: toISO,
        // el endpoint debe devolver paid_guest_usd
        includePaidGuestUSD: '1',
      };
      if (selectedDeptIds.length) params.deptIds = selectedDeptIds.join(',');

      const { data } = await axios.get('/api/liquidaciones/reservasByCheckin', { params });

      const items = Array.isArray(data?.items) ? data.items : [];
      setRows(items);
      setGroups(data?.groups || null);
      setHasRun(true);
    } finally {
      setLoading(false);
    }
  };

  // Nota: quitamos el auto-fetch en useEffect; ahora se dispara con el botón
  // useEffect(() => { fetchData(); }, [...]);

  // -------------------------------------------------------
  // C) Guardado debounced de celdas (mutaciones contables)
  // -------------------------------------------------------
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

          // refresco local del neto
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

  // -------------------------------------------------------
  // D) Handlers de edición
  // -------------------------------------------------------
  const onCellEdit = (id, field, value) => {
    setPending(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value === '' ? null : Number(value) }
    }));
  };
  const onObsEdit = (id, value) => {
    setPending(prev => ({ ...prev, [id]: { ...(prev[id] || {}), observaciones: value } }));
  };

  // -------------------------------------------------------
  // E) Opciones de deptos (dependen de property)
  // -------------------------------------------------------
  const deptOptions = useMemo(
    () => depts.map(d => ({ id: d.codigo || d.id, label: d.nombre })),
    [depts]
  );
  const deptsDisabled = !propertyId || propertyId === 'all';

  return (
    <div className="app liq-app">
      {/* =====================================================
          HEADER
         ===================================================== */}
      <header className="header">
        {/* -- barra superior: título + usuario -- */}
        <div className="header__bar">
          <div className="header__left">
            <h1 className="header__title">Liquidaciones</h1>
            <span className="header__date">{fromISO} → {toISO}</span>
          </div>
          <div className="header__right">
            <HeaderUserInline />
          </div>
        </div>

        {/* -- filtros (con labels) -- */}
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
          <div className="liq-filter" style={{ minWidth: 280 }}>
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

      {/* =====================================================
          MAIN
         ===================================================== */}
      <main className="liq-main">
        {loading && <div className="liq-loader">Cargando…</div>}

        {/* ------ vista POR UNIDAD ------ */}
        {!loading && hasRun && mode === 'unidad' && (
          rows.length === 0 ? (
            <div className="liq-empty">No hay resultados para los filtros seleccionados.</div>
          ) : (
            <table className="table btable liq-table">
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
              <tbody>
                {rows.map(r => {
                  const a = r.accounting || {};
                  // Bruto por defecto: accounting.brutoUSD o paid_guest_usd (calculado en backend)
                  const defaultBruto = a.brutoUSD ?? r.paid_guest_usd ?? '';
                  const G = Number(a.brutoUSD ?? r.paid_guest_usd) || 0;
                  const H = Number(a.comisionCanalUSD) || 0;
                  const I = Number(a.tasaLimpiezaUSD) || 0;
                  const J = Number(a.costoFinancieroUSD) || 0;
                  const K = Number.isFinite(Number(a.netoUSD)) ? Number(a.netoUSD) : +(G + H + I + J).toFixed(2);

                  return (
                    <tr key={r.id} className="tr">
                      <td className="td">{r.id_human || r.id}</td>
                      <td className="td">{r.nombre_huesped || '—'}</td>
                      <td className="td">{r.arrival_iso || '—'}</td>
                      <td className="td">{r.departure_iso || '—'}</td>
                      <td className="td">{r.channel_name || '—'}</td>

                      <td className="td">
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={fmt(defaultBruto)}
                          onChange={(e) => onCellEdit(r.id, 'brutoUSD', e.target.value)}
                          className="mini-popover__field"
                        />
                      </td>
                      <td className="td">
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={fmt(a.comisionCanalUSD)}
                          onChange={(e) => onCellEdit(r.id, 'comisionCanalUSD', e.target.value)}
                          className="mini-popover__field"
                        />
                      </td>
                      <td className="td">
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={fmt(a.tasaLimpiezaUSD)}
                          onChange={(e) => onCellEdit(r.id, 'tasaLimpiezaUSD', e.target.value)}
                          className="mini-popover__field"
                        />
                      </td>
                      <td className="td">
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={fmt(a.costoFinancieroUSD)}
                          onChange={(e) => onCellEdit(r.id, 'costoFinancieroUSD', e.target.value)}
                          className="mini-popover__field"
                        />
                      </td>

                      <td className="td td--money-strong">{money(K, 'USD')}</td>
                      <td className="td">
                        <input
                          type="text"
                          defaultValue={a.observaciones || ''}
                          onChange={(e) => onObsEdit(r.id, e.target.value)}
                          className="mini-popover__field"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {/* ------ vista POR PROPIEDAD ------ */}
        {!loading && hasRun && mode === 'propiedad' && groups && (
          <div style={{ display: 'grid', gap: 16 }}>
            {/* ARS */}
            <section className="liq-card">
              <h2 className="prop-group__title">Reservas en $</h2>
              {Object.entries(groups.ARS || {}).map(([deptKey, obj]) => (
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
              {Object.entries(groups.USD || {}).map(([deptKey, obj]) => (
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


