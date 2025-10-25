// src/pages/LiquidacionesPage.jsx
import { useAuth } from '../context/AuthContext';
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import HeaderUserInline from '../components/HeaderUserInline';

const TZ = 'America/Argentina/Buenos_Aires';
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '');
const money = (n, cur = 'USD') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `${v.toFixed(2)} ${String(cur).toUpperCase()}`;
};

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
  const now = DateTime.now().setZone(TZ);
  const monthStart = now.startOf('month').toISODate();
  const monthEnd   = now.endOf('month').toISODate();

  // filtros
  const propsList = useProperties();
  const [propertyId, setPropertyId] = useState('all');
  const depts = useDepartments(propertyId);
  const [selectedDeptIds, setSelectedDeptIds] = useState([]);
  const [fromISO, setFromISO] = useState(monthStart);
  const [toISO, setToISO] = useState(monthEnd);
  const [mode, setMode] = useState('unidad'); // 'unidad' | 'propiedad'

  // datos
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [groups, setGroups] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = { property: propertyId, from: fromISO, to: toISO };
      if (selectedDeptIds.length) params.deptIds = selectedDeptIds.join(',');
      const { data } = await axios.get('/api/liquidaciones/reservasByCheckin', { params });
      const items = Array.isArray(data?.items) ? data.items : [];
      setRows(items);
      setGroups(data?.groups || null);
      setHasSearched(true);
    } finally { setLoading(false); }
  };

  // guardado debounced de celdas
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

  const onCellEdit = (id, field, value) => {
    setPending(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value === '' ? null : Number(value) }
    }));
  };
  const onObsEdit = (id, value) => {
    setPending(prev => ({ ...prev, [id]: { ...(prev[id] || {}), observaciones: value } }));
  };

  const deptOptions = useMemo(
    () => depts.map(d => ({ id: d.codigo || d.id, label: d.nombre })),
    [depts]
  );

  const deptDisabled = !propertyId || propertyId === 'all';

  return (
    <div className="app" style={{ background: 'var(--panel-bg)' }}>
      <header className="header">
        <div className="header__bar">
          <div className="header__left">
            <h1 className="header__title">Liquidaciones</h1>
            {hasSearched && <span className="header__date">{fromISO} → {toISO}</span>}
          </div>
          <div className="header__right">
            <HeaderUserInline />
          </div>
        </div>

        <div className="header__filters">
          <div style={{ display: 'grid', gap: 4 }}>
            <label className="th" style={{ opacity: .8 }}>Propiedad</label>
            <select
              className="input--date"
              value={propertyId}
              onChange={(e) => { setPropertyId(e.target.value); setSelectedDeptIds([]); }}
            >
              <option value="all">Seleccioná una propiedad</option>
              {propsList.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gap: 4 }}>
            <label className="th" style={{ opacity: .8 }}>Departamento</label>
            <select
              className="input--date"
              multiple
              size={Math.min(6, Math.max(2, deptOptions.length))}
              value={selectedDeptIds}
              onChange={(e) => {
                const vals = Array.from(e.target.selectedOptions).map(o => o.value);
                setSelectedDeptIds(vals);
              }}
              disabled={deptDisabled}
              title="Unidades"
            >
              {deptOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>

          <div className="header__nav" style={{ display: 'grid', gap: 4 }}>
            <label className="th" style={{ opacity: .8 }}>Rango de fechas</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="date" className="input--date" value={fromISO} onChange={(e) => setFromISO(e.target.value)} />
              <span>→</span>
              <input type="date" className="input--date" value={toISO} onChange={(e) => setToISO(e.target.value)} />
            </div>
          </div>

          <div className="header__actions">
            <button className={`btn ${mode === 'unidad' ? 'bg-black text-white' : ''}`} onClick={() => setMode('unidad')}>Por unidad</button>
            <button className={`btn ${mode === 'propiedad' ? 'bg-black text-white' : ''}`} onClick={() => setMode('propiedad')}>Por propiedad</button>
            <button className="btn" onClick={fetchData} disabled={propertyId === 'all'}>Mostrar resultados</button>
          </div>
        </div>
      </header>

      <main className="main" style={{ padding: 12 }}>
        {loading && <div className="loader">Cargando…</div>}

        {!loading && !hasSearched && (
          <div style={{ opacity: .7, padding: 8 }}>Elegí una propiedad (y opcionalmente departamentos y fechas) y presioná “Mostrar resultados”.</div>
        )}

        {!loading && hasSearched && mode === 'unidad' && rows.length > 0 && (
          <table className="table btable" style={{ background: '#fff', borderRadius: 8 }}>
            <thead>
              <tr>
                <th className="th">reserva</th>
                <th className="th">Huésped</th>
                <th className="th">check in</th>
                <th className="th">check out</th>
                <th className="th">Canal</th>
                <th className="th">Cobrado Bruto</th>
                <th className="th">Comisión Canal</th>
                <th className="th">Tasa limpieza</th>
                <th className="th">Costo financiero</th>
                <th className="th">Neto</th>
                <th className="th">Observaciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const a = r.accounting || {};
                // valor inicial preferente: lo pagado por el huésped en la reserva (si viene del backend)
                const brutoInitial = a.brutoUSD ?? r.paid_guest_usd ?? r.paidUSD ?? '';
                const G = Number(a.brutoUSD ?? brutoInitial) || 0;
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
                        defaultValue={fmt(brutoInitial)}
                        onChange={(e) => onCellEdit(r.id, 'brutoUSD', e.target.value)}
                        className="mini-popover__field"
                      />
                    </td>
                    <td className="td"><input type="number" step="0.01" defaultValue={fmt(a.comisionCanalUSD)} onChange={(e) => onCellEdit(r.id, 'comisionCanalUSD', e.target.value)} className="mini-popover__field" /></td>
                    <td className="td"><input type="number" step="0.01" defaultValue={fmt(a.tasaLimpiezaUSD)} onChange={(e) => onCellEdit(r.id, 'tasaLimpiezaUSD', e.target.value)} className="mini-popover__field" /></td>
                    <td className="td"><input type="number" step="0.01" defaultValue={fmt(a.costoFinancieroUSD)} onChange={(e) => onCellEdit(r.id, 'costoFinancieroUSD', e.target.value)} className="mini-popover__field" /></td>

                    <td className="td td--money-strong">{money(K, 'USD')}</td>
                    <td className="td"><input type="text" defaultValue={a.observaciones || ''} onChange={(e) => onObsEdit(r.id, e.target.value)} className="mini-popover__field" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {!loading && hasSearched && mode === 'propiedad' && groups && (
          <div style={{ display: 'grid', gap: 16 }}>
            <section style={{ background: '#fff', borderRadius: 8, padding: 12 }}>
              <h2 className="prop-group__title">Reservas en $</h2>
              {Object.entries(groups.ARS || {}).map(([deptKey, obj]) => (
                <div key={'ARS_' + deptKey} style={{ marginBottom: 12 }}>
                  <h3 className="prop-group__title">{obj.depto || deptKey}</h3>
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th className="th">reserva</th>
                        <th className="th">Huésped</th>
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

            <section style={{ background: '#fff', borderRadius: 8, padding: 12 }}>
              <h2 className="prop-group__title">Reservas en USD</h2>
              {Object.entries(groups.USD || {}).map(([deptKey, obj]) => (
                <div key={'USD_' + deptKey} style={{ marginBottom: 12 }}>
                  <h3 className="prop-group__title">{obj.depto || deptKey}</h3>
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th className="th">reserva</th>
                        <th className="th">Huésped</th>
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

