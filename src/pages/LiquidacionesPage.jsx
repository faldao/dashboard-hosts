// =========================================================
// LiquidacionesPage.jsx
// - Versión de Producción Definitiva
// - Se eliminan todos los mocks (Auth, Header, luxon, axios).
// - Se restauran las llamadas reales a la API.
// - Se importa el CSS externo.
// =========================================================

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import { useAuth } from '../context/AuthContext';
import HeaderUserInline from '../components/HeaderUserInline';
import './LiquidacionesPage.css'; // <-- CSS EXTERNO IMPORTADO

// ---------- Constantes de formato ----------
const TZ = 'America/Argentina/Buenos_Aires';

// ===== Helpers de formato (es-AR) =====
function parseNumberEs(str) {
    if (str == null) return NaN;
    const s = String(str).trim().replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
}

function formatNumberEs(n, _cur) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
function getFxRateForRow(res, fallback) {
    try {
        const fx = res?.usd_fx_on_checkin || {};
        const buy = Number(fx.compra);
        const sell = Number(fx.venta);
        if (Number.isFinite(sell) && sell > 0) return sell;
        if (Number.isFinite(buy) && buy > 0) return buy;
    } catch { }
    // Fallback razonable si no hay FX (para evitar división por cero)
    return Number.isFinite(fallback) ? fallback : 1000.0;
}

// ---------- Transforma reservas en filas por moneda ----------
function buildByCurrency(items = []) {
    const out = { ARS: [], USD: [] };

    for (const res of items) {
        const pays = Array.isArray(res.payments) ? res.payments : [];
        if (!pays.length) continue;

        const fx = getFxRateForRow(res, null); 

        for (let i = 0; i < pays.length; i++) {
            const p = pays[i];
            const amt = Number(p.amount);
            const cur = String(p.currency || '').toUpperCase();
            if (!Number.isFinite(amt) || amt <= 0) continue;
            if (cur !== 'ARS' && cur !== 'USD') continue;

            const checkin = res.arrival_iso ? DateTime.fromISO(res.arrival_iso).toFormat('dd/MM/yyyy') : '—';
            const checkout = res.departure_iso ? DateTime.fromISO(res.departure_iso).toFormat('dd/MM/yyyy') : '—';

            // Lógica para determinar el bruto inicial
            // Si hay un valor guardado (brutoUSD), se usa. Si no, se usa el monto del pago.
            const accBrutoUSD = res.accounting?.brutoUSD;
            let initialBruto;
            if (cur === 'USD') {
                // Si la fila es USD, el valor inicial es el brutoUSD guardado, o el monto del pago
                initialBruto = accBrutoUSD ?? amt;
            } else { // ARS
                // Si la fila es ARS, el valor inicial es el brutoUSD guardado (convertido a ARS), o el monto del pago
                initialBruto = (accBrutoUSD != null && fx) ? (accBrutoUSD * fx) : amt;
            }

            const row = {
                id_human: res.id_human || res.id || '—',
                huesped: res.nombre_huesped || '—',
                checkin: checkin,
                checkout: checkout,
                canal: res.source || res.channel_name || '—',
                pay_method: p.method || '',
                pay_concept: p.concept || '',
                pay_currency: cur,
                pay_amount: initialBruto, // Usar el valor calculado
                res_id: res.id,
                _res: res,
                fx_used: fx,
            };

            out[cur].push(row);
        }
    }

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
    const [deptId, setDeptId] = useState(''); 
    const deptsDisabled = !propertyId || propertyId === 'all';

    const [fromISO, setFromISO] = useState(monthStart);
    const [toISO, setToISO] = useState(monthEnd);
    const [mode, setMode] = useState('unidad');

    // ----- B) Datos -----
    const [loading, setLoading] = useState(false);
    const [items, setItems] = useState([]);    
    const [byCur, setByCur] = useState({ ARS: [], USD: [] });
    const [groupsProp, setGroupsProp] = useState(null); 
    const [hasRun, setHasRun] = useState(false);

    const fetchData = async () => {
        setLoading(true);
        try {
            const params = {
                property: propertyId,
                from: fromISO,
                to: toISO,
                includePayments: '1', 
            };
            if (deptId) params.deptId = deptId;

            const { data } = await axios.get('/api/liquidaciones/reservasByCheckin', { params });
            const itemsRaw = Array.isArray(data?.items) ? data.items : [];

            setItems(itemsRaw);
            setByCur(buildByCurrency(itemsRaw));
            setGroupsProp(data?.groups || null);
            setHasRun(true);
        } catch (err) {
            console.error("Error fetching data:", err);
            // Aquí deberías manejar el error, ej: setError(err.message)
        } finally {
            setLoading(false);
        }
    };

    // ----- C) Mutaciones (Auto-guardado con Debounce) -----
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
                    try {
                        // 1. Guardar la mutación
                        await axios.post('/api/liquidaciones/accountingMutations', { id, payload });
                        
                        // 2. Registrar en el log de actividad
                        try {
                            await axios.post('/api/liquidaciones/activityLog', {
                                type: 'acc_update',
                                message: 'edit liquidacion (debounce)',
                                meta: { id, payload },
                            });
                        } catch (logErr) {
                            console.warn("Error guardando en activityLog:", logErr);
                        }

                        // 3. Refrescar el estado local (items)
                        setItems(prev => prev.map(r => {
                            if (r.id !== id) return r;
                            const a = r.accounting || {};
                            const p = payload || {};
                            const bruto = Number(p.brutoUSD ?? a.brutoUSD ?? 0);
                            const comis = Number(p.comisionCanalUSD ?? a.comisionCanalUSD ?? 0);
                            const tasa = Number(p.tasaLimpiezaUSD ?? a.tasaLimpiezaUSD ?? 0);
                            const costo = Number(p.costoFinancieroUSD ?? a.costoFinancieroUSD ?? 0);
                            const netoUSD = +(bruto + comis + tasa + costo).toFixed(2);
                            const newAccounting = { ...a, ...p, netoUSD };
                            return { ...r, accounting: newAccounting };
                        }));

                    } catch (err) {
                        console.error(`Error guardando ${id}:`, err);
                        // Opcional: volver a poner el item en 'pending' si falla
                        // setPending(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...payload } }));
                    }
                })
            );
            
            // 4. Recalcular 'byCur' DESPUÉS de que 'items' se haya actualizado
            // Esto asegura que la UI refleje los nuevos 'pay_amount' calculados
            setItems(currentItems => {
                setByCur(buildByCurrency(currentItems));
                return currentItems; 
            });

        }, 600); // 600ms debounce

        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending, user]);


    // ----- D) Handlers de edición (staging) -----
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
    // Hook chiquito para manejar inputs monetarios
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
            setNum(Number.isFinite(n) ? n : 0);
        };

        const onBlur = () => setStr(formatNumberEs(num, currency));
        const onFocus = (e) => e.target.select();

        // Sincronizar si el valor inicial cambia (ej: después de guardar)
        useEffect(() => {
            const n = Number(initialNumber) || 0;
            setNum(n);
            setStr(formatNumberEs(n, currency));
        }, [initialNumber, currency]);

        return { num, str, onChange, onBlur, onFocus };
    }

    // =====================================================
    // Render de una fila (Row)
    // =====================================================
    const Row = ({ onCellEdit, onObsEdit, ...r }) => {
        const a = r._res?.accounting || {};
        const fx = r.fx_used || getFxRateForRow(r._res, null) || 0; 

        const brutoCtl = useMoneyInput(Number(r.pay_amount) || 0, r.pay_currency); 
        const comisionCtl = useMoneyInput(Number(a.comisionCanalUSD) || 0, 'USD');
        const tasaCtl = useMoneyInput(Number(a.tasaLimpiezaUSD) || 0, 'USD');
        const costoCtl = useMoneyInput(Number(a.costoFinancieroUSD) || 0, 'USD');
        const [obs, setObs] = React.useState(a.observaciones || '');

        // ---- Neto en vivo (reacciona a cada tecla) ----
        const bruto = brutoCtl.num;
        const comis = comisionCtl.num;
        const tasa = tasaCtl.num;
        const costo = costoCtl.num;

        const brutoUSD = r.pay_currency === 'USD' ? bruto : (fx ? +(bruto / fx).toFixed(2) : 0);

        let netAmount, netCur;
        if (r.pay_currency === 'USD') {
            netAmount = +(brutoUSD + comis + tasa + costo).toFixed(2);
            netCur = 'USD';
        } else {
            const H_ars = fx ? comis * fx : 0;
            const I_ars = fx ? tasa * fx : 0;
            const J_ars = fx ? costo * fx : 0;
            netAmount = +(bruto + H_ars + I_ars + J_ars).toFixed(2);
            netCur = 'ARS';
        }

        // ---- Handlers de onBlur para guardar en "pending" ----
        const onBlurBruto = () => {
            brutoCtl.onBlur(); 
            const valBrutoUSD = r.pay_currency === 'USD' ? brutoCtl.num : (fx ? +(brutoCtl.num / fx).toFixed(2) : 0);
            onCellEdit(r.res_id, 'brutoUSD', valBrutoUSD);
        };
        const onBlurComision = () => {
            comisionCtl.onBlur(); 
            onCellEdit(r.res_id, 'comisionCanalUSD', comisionCtl.num);
        };
        const onBlurTasa = () => {
            tasaCtl.onBlur(); 
            onCellEdit(r.res_id, 'tasaLimpiezaUSD', tasaCtl.num);
        };
        const onBlurCosto = () => {
            costoCtl.onBlur(); 
            onCellEdit(r.res_id, 'costoFinancieroUSD', costoCtl.num);
        };
        const onBlurObs = () => {
            onObsEdit(r.res_id, obs);
        };


        return (
            <tr className="tr">
                <td className="td td--ro">{r.id_human}</td>
                <td className="td td--ro">{r.huesped}</td>
                <td className="td td--ro">{r.checkin}</td>
                <td className="td td--ro">{r.checkout}</td>
                <td className="td td--ro">{r.canal}</td>
                <td className="td td--mono td--ro">
                    {[r.pay_method || '—', r.pay_concept || ''].filter(Boolean).join(' · ')}
                </td>
                <td className="td">
                    <input
                        type="text"
                        className="num-input editable"
                        value={brutoCtl.str}
                        onChange={brutoCtl.onChange}
                        onBlur={onBlurBruto} 
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
                        onBlur={onBlurComision} 
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
                        onBlur={onBlurTasa} 
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
                        onBlur={onBlurCosto} 
                        onFocus={costoCtl.onFocus}
                        inputMode="decimal"
                    />
                </td>
                <td className="td td--money-strong td--ro">{moneyIntl(netAmount, netCur)}</td>
                <td className="td">
                    <input
                        type="text"
                        className="text-input editable"
                        value={obs}
                        onChange={(e) => setObs(e.target.value)}
                        onBlur={onBlurObs} 
                    />
                </td>
            </tr>
        );
    };


    // =====================================================
    // UI
    // =====================================================
    return (
        <div className="liq-app">
            
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

                <div className="liq-filters">
                    <div className="liq-filter">
                        <label className="liq-filter__label">Propiedad</label>
                        <select
                            className="liq-filter__control"
                            value={propertyId}
                            onChange={(e) => { setPropertyId(e.target.value); setDeptId(''); }}
                        >
                            <option value="all">Seleccionar…</option>
                            {propsList.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                        </select>
                    </div>
                    <div className="liq-filter liq-filter--wide">
                        <label className="liq-filter__label">Departamentos</label>
                        <select
                            className="liq-filter__control"
                            value={deptId}
                            onChange={(e) => setDeptId(e.target.value)}
                            disabled={deptsDisabled}
                        >
                            <option value="">Todos</option>
                            {deptOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                    </div>
                    <div className="liq-filter">
                        <label className="liq-filter__label">Desde</label>
                        <input
                            type="date"
                            className="liq-filter__control"
                            value={fromISO}
                            onChange={(e) => setFromISO(e.target.value)}
                        />
                    </div>
                    <div className="liq-filter">
                        <label className="liq-filter__label">Hasta</label>
                        <input
                            type="date"
                            className="liq-filter__control"
                            value={toISO}
                            onChange={(e) => setToISO(e.target.value)}
                        />
                    </div>
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
                        <button className="btn" onClick={fetchData} disabled={loading}>
                            {loading ? 'Cargando...' : 'Mostrar resultados'}
                        </button>
                    </div>
                </div>
            </header>

            <main className="liq-main">
                {loading && <div className="liq-loader">Cargando…</div>}
                
                {!loading && !hasRun && (
                    <div className="liq-empty" style={{ padding: '2rem', textAlign: 'center' }}>
                        Por favor, presiona "Mostrar resultados" para cargar los datos.
                    </div>
                )}

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
                                        ? byCur.ARS.map((r, i) => <Row key={`ARS_${r.res_id}_${i}`} {...r} onCellEdit={onCellEdit} onObsEdit={onObsEdit} />)
                                        : (
                                            <tr>
                                                <td className="td" colSpan={12} style={{ opacity: .6, textAlign: 'center' }}>Sin pagos en ARS</td>
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
                                        ? byCur.USD.map((r, i) => <Row key={`USD_${r.res_id}_${i}`} {...r} onCellEdit={onCellEdit} onObsEdit={onObsEdit} />)
                                        : (
                                            <tr>
                                                <td className="td" colSpan={12} style={{ opacity: .6, textAlign: 'center' }}>Sin pagos en USD</td>
                                            </tr>
                                        )}
                                </tbody>
                            </table>
                        </section>
                    </>
                )}

                {/* ===== Vista POR PROPIEDAD (opcional) ===== */}
                {!loading && hasRun && mode === 'propiedad' && groupsProp && (
                    <div style={{ display: 'grid', gap: 16 }}>
                        <section className="liq-card">
                            <h2 className="prop-group__title">Vista "Por Propiedad"</h2>
                            <p>Aquí iría el renderizado de la vista por propiedad (si se mantiene).</p>
                            {/* Aquí deberías iterar 'groupsProp' si mantienes esa lógica */}
                        </section>
                    </div>
                )}
            </main>
        </div>
    );
}