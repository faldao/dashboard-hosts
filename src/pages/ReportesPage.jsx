import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import HeaderUserInline from '../components/HeaderUserInline';
import ExportReportesExcel from '../components/ExportReportesExcel';
import { buildRecaudacionRows } from '../lib/recaudacion';
import './LiquidacionesPage.css';
import './ReportesPage.css';

const TZ = 'America/Argentina/Buenos_Aires';

const REPORTS = [
  { id: 'recaudacion', label: 'Recaudacion' },
];

function moneyIntl(amount, cur = 'ARS') {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: cur,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

function useProperties() {
  const [list, setList] = useState([]);
  useEffect(() => {
    (async () => {
      const { data } = await axios.get('/api/properties');
      const raw = Array.isArray(data?.items) ? data.items : [];
      setList(raw.map((p) => ({ id: p.id, nombre: p.nombre })));
    })();
  }, []);
  return list;
}

function useDepartments(propertyId) {
  const [list, setList] = useState([]);
  useEffect(() => {
    (async () => {
      if (!propertyId || propertyId === 'all') {
        setList([]);
        return;
      }
      const { data } = await axios.get('/api/liquidaciones/departments', { params: { property: propertyId } });
      setList(Array.isArray(data?.items) ? data.items : []);
    })();
  }, [propertyId]);
  return list;
}

function buildPaymentMethodSections(rows = []) {
  const byMethod = new Map();
  for (const row of rows) {
    if (!byMethod.has(row.paymentMethod)) byMethod.set(row.paymentMethod, []);
    byMethod.get(row.paymentMethod).push(row);
  }

  return Array.from(byMethod.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([paymentMethod, methodRows]) => {
      const totalsByCurrency = new Map();
      for (const row of methodRows) {
        if (!totalsByCurrency.has(row.currency)) {
          totalsByCurrency.set(row.currency, {
            currency: row.currency,
            total: 0,
            reservationIds: new Set(),
            nightsByReservation: new Map(),
          });
        }
        const total = totalsByCurrency.get(row.currency);
        total.total += Number(row.total) || 0;
        for (const id of row.reservationIds || []) total.reservationIds.add(id);
        for (const [id, nights] of row.nightsByReservation || []) total.nightsByReservation.set(id, nights);
      }

      return {
        paymentMethod,
        rows: [...methodRows].sort((a, b) => (
          a.propertyName.localeCompare(b.propertyName)
          || a.currency.localeCompare(b.currency)
        )),
        totals: Array.from(totalsByCurrency.values())
          .map((total) => ({
            currency: total.currency,
            total: +total.total.toFixed(2),
            reservationCount: total.reservationIds.size,
            nightCount: Array.from(total.nightsByReservation.values()).reduce((sum, nights) => sum + nights, 0),
          }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      };
    });
}

function buildCurrencyTotals(rows = []) {
  const byCurrency = new Map();
  for (const row of rows) {
    if (!byCurrency.has(row.currency)) {
      byCurrency.set(row.currency, {
        currency: row.currency,
        total: 0,
        reservationIds: new Set(),
        nightsByReservation: new Map(),
      });
    }
    const total = byCurrency.get(row.currency);
    total.total += Number(row.total) || 0;
    for (const id of row.reservationIds || []) total.reservationIds.add(id);
    for (const [id, nights] of row.nightsByReservation || []) total.nightsByReservation.set(id, nights);
  }
  return Array.from(byCurrency.values())
    .map((row) => ({
      currency: row.currency,
      total: +row.total.toFixed(2),
      reservationCount: row.reservationIds.size,
      nightCount: Array.from(row.nightsByReservation.values()).reduce((sum, nights) => sum + nights, 0),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export default function ReportesPage() {
  const now = DateTime.now().setZone(TZ);
  const monthStart = now.startOf('month').toISODate();
  const monthEnd = now.endOf('month').toISODate();

  const propsList = useProperties();
  const [propertyIds, setPropertyIds] = useState([]);
  const [propertyModalOpen, setPropertyModalOpen] = useState(false);
  const [draftPropertyIds, setDraftPropertyIds] = useState([]);
  const singlePropertyId = propertyIds.length === 1 ? propertyIds[0] : '';
  const depts = useDepartments(singlePropertyId || 'all');
  const deptOptions = useMemo(() => depts.map((d) => ({ id: d.codigo || d.id, label: d.nombre })), [depts]);
  const [deptId, setDeptId] = useState('');
  const [fromISO, setFromISO] = useState(monthStart);
  const [toISO, setToISO] = useState(monthEnd);
  const [reportId, setReportId] = useState('recaudacion');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  const reportLabel = REPORTS.find((r) => r.id === reportId)?.label || 'Reporte';
  const deptsDisabled = !singlePropertyId;
  const propertyButtonLabel = useMemo(() => {
    if (propertyIds.length === 0) return 'Todas las propiedades';
    if (propertyIds.length === 1) {
      return propsList.find((p) => String(p.id) === String(propertyIds[0]))?.nombre || '1 propiedad';
    }
    return `${propertyIds.length} propiedades seleccionadas`;
  }, [propertyIds, propsList]);

  const rows = useMemo(() => {
    if (reportId !== 'recaudacion') return [];
    return buildRecaudacionRows(items);
  }, [items, reportId]);

  const totals = useMemo(() => buildCurrencyTotals(rows), [rows]);
  const sections = useMemo(() => buildPaymentMethodSections(rows), [rows]);

  const openPropertyModal = () => {
    setDraftPropertyIds(propertyIds);
    setPropertyModalOpen(true);
  };

  const toggleDraftProperty = (propertyId) => {
    setDraftPropertyIds((prev) => (
      prev.includes(propertyId)
        ? prev.filter((id) => id !== propertyId)
        : [...prev, propertyId]
    ));
  };

  const applyPropertySelection = () => {
    setPropertyIds(draftPropertyIds);
    setDeptId('');
    setHasRun(false);
    setPropertyModalOpen(false);
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const baseParams = {
        from: fromISO,
        to: toISO,
        includePayments: '1',
      };
      const selectedProperties = propertyIds.length === 0 ? ['all'] : propertyIds;
      const responses = await Promise.all(
        selectedProperties.map((property) => {
          const params = { ...baseParams, property };
          if (property !== 'all' && selectedProperties.length === 1 && deptId) params.deptIds = deptId;
          return axios.get('/api/liquidaciones/reservasByCheckin', { params });
        })
      );
      const deduped = new Map();
      for (const response of responses) {
        const responseItems = Array.isArray(response.data?.items) ? response.data.items : [];
        for (const item of responseItems) deduped.set(item.id, item);
      }
      setItems(Array.from(deduped.values()));
      setHasRun(true);
    } catch (err) {
      console.error('[ReportesPage] Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="liq-app">
      <header className="header">
        <div className="header__bar">
          <div className="header__left">
            <h1 className="header__title">Reportes</h1>
            <span className="header__date">{fromISO} - {toISO}</span>
          </div>
          <div className="header__right">
            <HeaderUserInline />
          </div>
        </div>

        <div className="liq-filters">
          <div className="liq-filter">
            <label className="liq-filter__label">Propiedad</label>
            <button
              type="button"
              className="liq-filter__control report-property-button"
              onClick={openPropertyModal}
            >
              {propertyButtonLabel}
            </button>
          </div>

          <div className="liq-filter liq-filter--wide">
            <label className="liq-filter__label">Departamentos</label>
            <select
              className="liq-filter__control"
              value={deptId}
              onChange={(e) => { setDeptId(e.target.value); setHasRun(false); }}
              disabled={deptsDisabled}
            >
              <option value="">Todos</option>
              {deptOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>

          <div className="liq-filter">
            <label className="liq-filter__label">Desde</label>
            <input
              type="date"
              className="liq-filter__control"
              value={fromISO}
              onChange={(e) => { setFromISO(e.target.value); setHasRun(false); }}
            />
          </div>

          <div className="liq-filter">
            <label className="liq-filter__label">Hasta</label>
            <input
              type="date"
              className="liq-filter__control"
              value={toISO}
              onChange={(e) => { setToISO(e.target.value); setHasRun(false); }}
            />
          </div>

          <div className="liq-filter">
            <label className="liq-filter__label">Reporte</label>
            <select
              className="liq-filter__control"
              value={reportId}
              onChange={(e) => { setReportId(e.target.value); setHasRun(false); }}
            >
              {REPORTS.map((report) => <option key={report.id} value={report.id}>{report.label}</option>)}
            </select>
          </div>

          <div className="liq-actions">
            <button className="btn" onClick={fetchData} disabled={loading}>
              {loading ? 'Cargando...' : 'Mostrar resultados'}
            </button>
            <ExportReportesExcel
              rows={rows}
              sections={sections}
              totals={totals}
              fromISO={fromISO}
              toISO={toISO}
              reportLabel={reportLabel}
              disabled={!hasRun || loading}
            />
          </div>
        </div>
      </header>

      {propertyModalOpen && (
        <div className="report-modal" role="dialog" aria-modal="true" aria-labelledby="property-modal-title">
          <div className="report-modal__panel">
            <div className="report-modal__header">
              <h2 id="property-modal-title" className="report-modal__title">Propiedad</h2>
              <button type="button" className="report-modal__close" onClick={() => setPropertyModalOpen(false)}>
                Cerrar
              </button>
            </div>

            <div className="report-property-list">
              {propsList.map((property) => (
                <label className="report-property-option" key={property.id}>
                  <input
                    type="checkbox"
                    checked={draftPropertyIds.includes(property.id)}
                    onChange={() => toggleDraftProperty(property.id)}
                  />
                  <span>{property.nombre}</span>
                </label>
              ))}
            </div>

            <div className="report-modal__actions">
              <button type="button" className="btn" onClick={() => setDraftPropertyIds([])}>
                Todas
              </button>
              <button type="button" className="btn" onClick={() => setPropertyModalOpen(false)}>
                Cancelar
              </button>
              <button type="button" className="btn btn--active" onClick={applyPropertySelection}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="liq-main">
        {loading && <div className="liq-loader">Cargando...</div>}

        {!loading && !hasRun && (
          <div className="liq-empty" style={{ padding: '2rem', textAlign: 'center' }}>
            Por favor, presiona "Mostrar resultados" para cargar los datos.
          </div>
        )}

        {!loading && hasRun && (
          <>
            <section className="report-summary">
              <div className="report-metric">
                <div className="report-metric__label">Reservas</div>
                <div className="report-metric__value">{new Set(items.map((item) => item.id)).size}</div>
              </div>
              {totals.map((total) => (
                <div className="report-metric" key={total.currency}>
                  <div className="report-metric__label">Total {total.currency}</div>
                  <div className="report-metric__value">{moneyIntl(total.total, total.currency)}</div>
                </div>
              ))}
            </section>

            <section className="liq-card">
              <h2 className="prop-group__title">{reportLabel}</h2>
              <table className="table btable liq-table report-table">
                <thead>
                  <tr>
                    <th className="th">Forma de pago</th>
                    <th className="th">Propiedad</th>
                    <th className="th">Moneda</th>
                    <th className="th th--right">Cantidad reservas</th>
                    <th className="th th--right">Cantidad noches</th>
                    <th className="th th--right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.length ? sections.map((section) => (
                    <React.Fragment key={section.paymentMethod}>
                      <tr className="tr report-method-row">
                        <td className="td" colSpan="6">{section.paymentMethod}</td>
                      </tr>
                      {section.rows.map((row) => (
                        <tr className="tr" key={`${row.propertyId}_${row.paymentMethod}_${row.currency}`}>
                          <td className="td td--ro" />
                          <td className="td td--ro">{row.propertyName}</td>
                          <td className="td td--ro">{row.currency}</td>
                          <td className="td td--right">{row.reservationCount}</td>
                          <td className="td td--right">{row.nightCount}</td>
                          <td className="td td--right td--money-strong">{moneyIntl(row.total, row.currency)}</td>
                        </tr>
                      ))}
                      {section.totals.map((total) => (
                        <tr className="tr report-total-row" key={`${section.paymentMethod}_${total.currency}`}>
                          <td className="td">Total {section.paymentMethod}</td>
                          <td className="td" />
                          <td className="td">{total.currency}</td>
                          <td className="td td--right">{total.reservationCount}</td>
                          <td className="td td--right">{total.nightCount}</td>
                          <td className="td td--right td--money-strong">{moneyIntl(total.total, total.currency)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  )) : (
                    <tr>
                      <td className="td" colSpan="6" style={{ opacity: .6, textAlign: 'center' }}>Sin datos para el periodo seleccionado</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
