import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { DateTime } from 'luxon';
import HeaderUserInline from '../components/HeaderUserInline';
import { useAuth } from '../context/AuthContext';
import './LiquidacionesPage.css';
import './GastosPage.css';

const TZ = 'America/Argentina/Buenos_Aires';
const OTHER = '__other__';

const emptyOptions = {
  conceptos: [],
  proveedores: [],
  tiposComprobante: [],
  origenesFondos: [],
};

function optionLabel(option) {
  return option?.nombre || option?.label || option?.codigo || option?.id || '';
}

function moneyIntl(amount, cur = 'ARS') {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: cur || 'ARS',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

function formatDate(iso) {
  return iso ? DateTime.fromISO(iso, { zone: TZ }).toFormat('dd/MM/yyyy') : '';
}

function asDateTime(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const dt = DateTime.fromISO(value, { zone: TZ });
    return dt.isValid ? dt : null;
  }
  const seconds = value.seconds ?? value._seconds;
  const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
  if (Number.isFinite(Number(seconds))) {
    const millis = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1000000);
    const dt = DateTime.fromMillis(millis, { zone: TZ });
    return dt.isValid ? dt : null;
  }
  return null;
}

function formatDateTime(value) {
  const dt = asDateTime(value);
  return dt ? dt.toFormat('dd/MM/yyyy HH:mm') : 'Sin fecha de registro';
}

function getCreatedByName(item) {
  return item?.createdBy?.name || item?.createdBy?.email || item?.createdBy?.uid || 'Usuario no informado';
}

function getAuditLine(item) {
  return `${formatDateTime(item?.createdAt)} - ${getCreatedByName(item)}`;
}

function getPropertyLabel(item) {
  return item?.propiedad?.nombre || item?.propiedad?.label || 'Sin propiedad';
}

function getDepartmentLabel(item) {
  return item?.departamento?.nombre || item?.departamento?.label || 'Sin departamento';
}

function getConceptLabel(item) {
  return item?.concepto?.label || 'Gasto';
}

function getProviderLabel(item) {
  return item?.proveedor?.label || 'Sin proveedor';
}

function getPaymentLine(item) {
  const source = item?.origenFondos?.label || 'Sin origen';
  const currency = item?.moneda || 'ARS';
  return `${source} - ${currency}`;
}

function getReceiptLabel(item) {
  return item?.tipoComprobante?.label || 'Sin comprobante';
}

function getUserName(user) {
  return user?.displayName || user?.email || user?.uid || 'Usuario';
}

function makeInitialForm() {
  return {
    fecha: DateTime.now().setZone(TZ).toISODate(),
    propiedadId: '',
    departamentoId: '',
    conceptoId: '',
    conceptoLabel: '',
    proveedorId: '',
    proveedorLabel: '',
    moneda: 'ARS',
    monto: '',
    tipoComprobanteId: '',
    tipoComprobanteLabel: '',
    origenFondosId: '',
    origenFondosLabel: '',
    observaciones: '',
  };
}

function SelectWithOther({
  label,
  value,
  otherValue,
  options,
  onChange,
  onOtherChange,
  otherPlaceholder,
}) {
  const showOther = value === OTHER;

  return (
    <div className="gastos-field">
      <label className="gastos-field__label">{label}</label>
      <select className="gastos-field__control" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Seleccionar...</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
        <option value={OTHER}>Otro</option>
      </select>
      {showOther && (
        <input
          className="gastos-field__control"
          type="text"
          value={otherValue}
          onChange={(e) => onOtherChange(e.target.value)}
          placeholder={otherPlaceholder}
        />
      )}
    </div>
  );
}

function SelectField({ label, value, options, onChange, placeholder = 'Seleccionar...', disabled = false }) {
  return (
    <div className="gastos-field">
      <label className="gastos-field__label">{label}</label>
      <select
        className="gastos-field__control"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{optionLabel(option)}</option>
        ))}
      </select>
    </div>
  );
}

function EyeIcon() {
  return <span className="gastos-eye-icon" aria-hidden="true" />;
}

function ViewField({ label, children, wide = false }) {
  return (
    <div className={wide ? 'gastos-view-field gastos-view-field--wide' : 'gastos-view-field'}>
      <div className="gastos-view-field__label">{label}</div>
      <div className="gastos-view-field__value">{children || '-'}</div>
    </div>
  );
}

function MobileDatum({ label, children }) {
  return (
    <div className="gastos-mobile-card__datum">
      <span className="gastos-mobile-card__label">{label}:</span>
      <span className="gastos-mobile-card__value">{children || '-'}</span>
    </div>
  );
}

export default function GastosPage() {
  const { user } = useAuth();
  const now = DateTime.now().setZone(TZ);
  const [fromISO, setFromISO] = useState(now.startOf('month').toISODate());
  const [toISO, setToISO] = useState(now.endOf('month').toISODate());
  const [options, setOptions] = useState(emptyOptions);
  const [properties, setProperties] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState(null);
  const [form, setForm] = useState(makeInitialForm);
  const [formError, setFormError] = useState('');

  const totals = useMemo(() => {
    const byCurrency = new Map();
    for (const item of items) {
      const currency = item.moneda || 'ARS';
      byCurrency.set(currency, (byCurrency.get(currency) || 0) + (Number(item.monto) || 0));
    }
    return Array.from(byCurrency.entries())
      .map(([currency, total]) => ({ currency, total }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }, [items]);

  const loadOptions = async () => {
    const { data } = await axios.get('/api/gastos/options');
    setOptions({
      conceptos: Array.isArray(data?.conceptos) ? data.conceptos : [],
      proveedores: Array.isArray(data?.proveedores) ? data.proveedores : [],
      tiposComprobante: Array.isArray(data?.tiposComprobante) ? data.tiposComprobante : [],
      origenesFondos: Array.isArray(data?.origenesFondos) ? data.origenesFondos : [],
    });
  };

  const loadProperties = async () => {
    const { data } = await axios.get('/api/properties');
    const raw = Array.isArray(data?.items) ? data.items : [];
    setProperties(raw.map((p) => ({ id: p.id, nombre: p.nombre })));
  };

  const loadDepartments = async (propertyId) => {
    if (!propertyId) {
      setDepartments([]);
      return;
    }
    setDepartmentsLoading(true);
    try {
      const { data } = await axios.get('/api/liquidaciones/departments', { params: { property: propertyId } });
      setDepartments(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      console.error('[GastosPage] Error loading departments:', err);
      setDepartments([]);
    } finally {
      setDepartmentsLoading(false);
    }
  };

  const loadExpenses = async () => {
    setLoading(true);
    try {
      const { data } = await axios.get('/api/gastos/expenses', { params: { from: fromISO, to: toISO } });
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      console.error('[GastosPage] Error loading expenses:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOptions().catch((err) => console.error('[GastosPage] Error loading options:', err));
    loadProperties().catch((err) => console.error('[GastosPage] Error loading properties:', err));
    loadExpenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadDepartments(form.propiedadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.propiedadId]);

  const openModal = () => {
    setForm(makeInitialForm());
    setFormError('');
    setModalOpen(true);
  };

  const updateForm = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateProperty = (value) => {
    setForm((prev) => ({ ...prev, propiedadId: value, departamentoId: '' }));
  };

  const appendOptionPayload = (payload, selectField, labelField, idKey, labelKey) => {
    if (form[selectField] === OTHER) {
      payload[labelKey] = form[labelField];
    } else {
      payload[idKey] = form[selectField];
    }
  };

  const validateForm = () => {
    if (!form.fecha) return 'La fecha es obligatoria.';
    if (!form.propiedadId) return 'La propiedad es obligatoria.';
    if (!form.conceptoId) return 'El concepto es obligatorio.';
    if (form.conceptoId === OTHER && !form.conceptoLabel.trim()) return 'Cargá el concepto.';
    if (!form.proveedorId) return 'El proveedor/beneficiario es obligatorio.';
    if (form.proveedorId === OTHER && !form.proveedorLabel.trim()) return 'Cargá el proveedor/beneficiario.';
    if (!form.moneda) return 'La moneda es obligatoria.';
    if (!Number.isFinite(Number(form.monto)) || Number(form.monto) <= 0) return 'El monto debe ser mayor a cero.';
    if (!form.tipoComprobanteId) return 'El tipo de comprobante es obligatorio.';
    if (form.tipoComprobanteId === OTHER && !form.tipoComprobanteLabel.trim()) return 'Cargá el tipo de comprobante.';
    if (!form.origenFondosId) return 'El origen de fondos es obligatorio.';
    if (form.origenFondosId === OTHER && !form.origenFondosLabel.trim()) return 'Cargá el origen de fondos.';
    return '';
  };

  const saveExpense = async () => {
    const err = validateForm();
    if (err) {
      setFormError(err);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      const payload = {
        fecha: form.fecha,
        propiedadId: form.propiedadId,
        propiedadNombre: optionLabel(properties.find((property) => property.id === form.propiedadId)),
        departamentoId: form.departamentoId,
        departamentoNombre: optionLabel(departments.find((department) => department.id === form.departamentoId)),
        moneda: form.moneda,
        monto: Number(form.monto),
        observaciones: form.observaciones,
        createdByName: getUserName(user),
      };
      appendOptionPayload(payload, 'conceptoId', 'conceptoLabel', 'conceptoId', 'conceptoLabel');
      appendOptionPayload(payload, 'proveedorId', 'proveedorLabel', 'proveedorId', 'proveedorLabel');
      appendOptionPayload(payload, 'tipoComprobanteId', 'tipoComprobanteLabel', 'tipoComprobanteId', 'tipoComprobanteLabel');
      appendOptionPayload(payload, 'origenFondosId', 'origenFondosLabel', 'origenFondosId', 'origenFondosLabel');

      await axios.post('/api/gastos/expenses', payload);
      await Promise.all([loadOptions(), loadExpenses()]);
      setModalOpen(false);
    } catch (saveErr) {
      console.error('[GastosPage] Error saving expense:', saveErr);
      setFormError(saveErr?.response?.data?.error || 'No se pudo guardar el gasto.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gastos-app">
      <header className="header">
        <div className="header__bar">
          <div className="header__left">
            <h1 className="header__title">Gastos</h1>
            <span className="header__date">{fromISO} - {toISO}</span>
          </div>
          <div className="header__right">
            <HeaderUserInline />
          </div>
        </div>

        <div className="liq-filters">
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
          <div className="gastos-actions">
            <button type="button" className="btn" onClick={loadExpenses} disabled={loading}>
              {loading ? 'Cargando...' : 'Mostrar resultados'}
            </button>
            <button type="button" className="btn gastos-primary-btn" onClick={openModal}>
              Nuevo gasto
            </button>
          </div>
        </div>
      </header>

      <main className="gastos-main">
        <section className="gastos-summary">
          <div className="gastos-metric">
            <div className="gastos-metric__label">Gastos</div>
            <div className="gastos-metric__value">{items.length}</div>
          </div>
          {totals.map((total) => (
            <div className="gastos-metric" key={total.currency}>
              <div className="gastos-metric__label">Total {total.currency}</div>
              <div className="gastos-metric__value">{moneyIntl(total.total, total.currency)}</div>
            </div>
          ))}
        </section>

        <section className="liq-card gastos-table-wrap">
          <table className="table btable liq-table gastos-table">
            <colgroup>
              <col className="gastos-col-date" />
              <col className="gastos-col-unit" />
              <col className="gastos-col-main" />
              <col className="gastos-col-payment" />
              <col className="gastos-col-amount" />
              <col className="gastos-col-notes-audit" />
              <col className="gastos-col-action" />
            </colgroup>
            <thead>
              <tr>
                <th className="th">Fecha</th>
                <th className="th">Unidad</th>
                <th className="th">Concepto / proveedor</th>
                <th className="th">Pago</th>
                <th className="th th--right">Monto</th>
                <th className="th">Observaciones / registro</th>
                <th className="th gastos-action-head" aria-label="Acciones"></th>
              </tr>
            </thead>
            <tbody>
              {items.length ? items.map((item) => (
                <tr className="tr" key={item.id}>
                  <td className="td gastos-cell-date">{formatDate(item.fecha)}</td>
                  <td className="td gastos-td-stack" title={`${getPropertyLabel(item)} - ${getDepartmentLabel(item)}`}>
                    <div className="gastos-line gastos-line--primary">{getPropertyLabel(item)}</div>
                    <div className="gastos-line gastos-line--secondary">{getDepartmentLabel(item)}</div>
                  </td>
                  <td className="td gastos-td-stack" title={`${getConceptLabel(item)} - ${getProviderLabel(item)}`}>
                    <div className="gastos-line gastos-line--primary">{getConceptLabel(item)}</div>
                    <div className="gastos-line gastos-line--secondary">{getProviderLabel(item)}</div>
                  </td>
                  <td className="td gastos-td-stack" title={`${getPaymentLine(item)} - ${getReceiptLabel(item)}`}>
                    <div className="gastos-line gastos-line--primary">{getPaymentLine(item)}</div>
                    <div className="gastos-line gastos-line--secondary">{getReceiptLabel(item)}</div>
                  </td>
                  <td className="td td--right td--money-strong gastos-cell-amount">{moneyIntl(item.monto, item.moneda)}</td>
                  <td className="td gastos-td-stack gastos-td-notes" title={`${item.observaciones || 'Sin observaciones'} - ${getAuditLine(item)}`}>
                    <div className="gastos-line gastos-line--primary">{item.observaciones || 'Sin observaciones'}</div>
                    <div className="gastos-line gastos-line--secondary">{getAuditLine(item)}</div>
                  </td>
                  <td className="td gastos-td-action">
                    <button
                      type="button"
                      className="gastos-icon-btn"
                      title="Ver detalle"
                      aria-label="Ver detalle del gasto"
                      onClick={() => setSelectedExpense(item)}
                    >
                      <EyeIcon />
                    </button>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="td" colSpan="7" style={{ textAlign: 'center', opacity: 0.65 }}>
                    Sin gastos para el periodo seleccionado
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="gastos-card-list">
          {items.length ? items.map((item) => (
            <article className="gastos-mobile-card" key={item.id}>
              <div className="gastos-mobile-card__head">
                <div>
                  <div className="gastos-mobile-card__title">
                    <span className="gastos-mobile-card__label">Concepto:</span> {getConceptLabel(item)}
                  </div>
                  <div className="gastos-mobile-card__sub">
                    <span><span className="gastos-mobile-card__label">Fecha:</span> {formatDate(item.fecha)}</span>
                    <span><span className="gastos-mobile-card__label">Propiedad:</span> {getPropertyLabel(item)}</span>
                  </div>
                </div>
                <div className="gastos-mobile-card__side">
                  <div className="gastos-mobile-card__amount">
                    <span className="gastos-mobile-card__label">Monto:</span> {moneyIntl(item.monto, item.moneda)}
                  </div>
                  <button
                    type="button"
                    className="gastos-icon-btn"
                    title="Ver detalle"
                    aria-label="Ver detalle del gasto"
                    onClick={() => setSelectedExpense(item)}
                  >
                    <EyeIcon />
                  </button>
                </div>
              </div>
              <div className="gastos-mobile-card__meta">
                <MobileDatum label="Departamento">{getDepartmentLabel(item)}</MobileDatum>
                <MobileDatum label="Proveedor">{getProviderLabel(item)}</MobileDatum>
                <MobileDatum label="Comprobante">{getReceiptLabel(item)}</MobileDatum>
                <MobileDatum label="Origen fondos">{item.origenFondos?.label || 'Sin origen'}</MobileDatum>
                <MobileDatum label="Moneda">{item.moneda || 'ARS'}</MobileDatum>
                <MobileDatum label="Observaciones">{item.observaciones || 'Sin observaciones'}</MobileDatum>
              </div>
              <div className="gastos-mobile-card__audit">
                <span className="gastos-mobile-card__label">Registro:</span> {getAuditLine(item)}
              </div>
            </article>
          )) : (
            <div className="liq-empty">Sin gastos para el periodo seleccionado</div>
          )}
        </section>
      </main>

      {modalOpen && (
        <div className="gastos-modal" role="dialog" aria-modal="true" aria-labelledby="gastos-modal-title">
          <div className="gastos-modal__panel">
            <div className="gastos-modal__header">
              <h2 className="gastos-modal__title" id="gastos-modal-title">Nuevo gasto</h2>
              <button type="button" className="btn" onClick={() => setModalOpen(false)}>
                Cerrar
              </button>
            </div>

            <div className="gastos-form">
              {formError && <div className="gastos-modal__error">{formError}</div>}

              <div className="gastos-field">
                <label className="gastos-field__label">Fecha</label>
                <input
                  className="gastos-field__control"
                  type="date"
                  value={form.fecha}
                  onChange={(e) => updateForm('fecha', e.target.value)}
                />
              </div>

              <div className="gastos-field">
                <label className="gastos-field__label">Moneda</label>
                <select className="gastos-field__control" value={form.moneda} onChange={(e) => updateForm('moneda', e.target.value)}>
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                </select>
              </div>

              <SelectField
                label="Propiedad"
                value={form.propiedadId}
                options={properties}
                onChange={updateProperty}
              />

              <SelectField
                label="Departamento"
                value={form.departamentoId}
                options={departments}
                onChange={(value) => updateForm('departamentoId', value)}
                placeholder={form.propiedadId ? 'Sin departamento' : 'Selecciona una propiedad'}
                disabled={!form.propiedadId || departmentsLoading}
              />

              <SelectWithOther
                label="Concepto"
                value={form.conceptoId}
                otherValue={form.conceptoLabel}
                options={options.conceptos}
                onChange={(value) => updateForm('conceptoId', value)}
                onOtherChange={(value) => updateForm('conceptoLabel', value)}
                otherPlaceholder="Nuevo concepto"
              />

              <SelectWithOther
                label="Proveedor / beneficiario"
                value={form.proveedorId}
                otherValue={form.proveedorLabel}
                options={options.proveedores}
                onChange={(value) => updateForm('proveedorId', value)}
                onOtherChange={(value) => updateForm('proveedorLabel', value)}
                otherPlaceholder="Nuevo proveedor o beneficiario"
              />

              <div className="gastos-field">
                <label className="gastos-field__label">Monto</label>
                <input
                  className="gastos-field__control"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.monto}
                  onChange={(e) => updateForm('monto', e.target.value)}
                  placeholder="0.00"
                />
              </div>

              <SelectWithOther
                label="Tipo de comprobante"
                value={form.tipoComprobanteId}
                otherValue={form.tipoComprobanteLabel}
                options={options.tiposComprobante}
                onChange={(value) => updateForm('tipoComprobanteId', value)}
                onOtherChange={(value) => updateForm('tipoComprobanteLabel', value)}
                otherPlaceholder="Nuevo tipo de comprobante"
              />

              <SelectWithOther
                label="Origen de fondos"
                value={form.origenFondosId}
                otherValue={form.origenFondosLabel}
                options={options.origenesFondos}
                onChange={(value) => updateForm('origenFondosId', value)}
                onOtherChange={(value) => updateForm('origenFondosLabel', value)}
                otherPlaceholder="Nuevo origen de fondos"
              />

              <div className="gastos-field gastos-field--full">
                <label className="gastos-field__label">Observaciones</label>
                <textarea
                  className="gastos-field__control"
                  rows="3"
                  value={form.observaciones}
                  onChange={(e) => updateForm('observaciones', e.target.value)}
                />
              </div>
            </div>

            <div className="gastos-modal__actions">
              <button type="button" className="btn" onClick={() => setModalOpen(false)} disabled={saving}>
                Cancelar
              </button>
              <button type="button" className="btn gastos-primary-btn" onClick={saveExpense} disabled={saving}>
                {saving ? 'Guardando...' : 'Guardar gasto'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedExpense && (
        <div className="gastos-modal" role="dialog" aria-modal="true" aria-labelledby="gastos-view-title">
          <div className="gastos-modal__panel gastos-modal__panel--view">
            <div className="gastos-modal__header">
              <h2 className="gastos-modal__title" id="gastos-view-title">Detalle de gasto</h2>
              <button type="button" className="btn" onClick={() => setSelectedExpense(null)}>
                Cerrar
              </button>
            </div>

            <div className="gastos-view-grid">
              <ViewField label="Fecha">{formatDate(selectedExpense.fecha)}</ViewField>
              <ViewField label="Monto">{moneyIntl(selectedExpense.monto, selectedExpense.moneda)}</ViewField>
              <ViewField label="Propiedad">{selectedExpense.propiedad?.nombre || selectedExpense.propiedad?.label}</ViewField>
              <ViewField label="Departamento">{selectedExpense.departamento?.nombre || selectedExpense.departamento?.label}</ViewField>
              <ViewField label="Concepto">{selectedExpense.concepto?.label}</ViewField>
              <ViewField label="Proveedor / beneficiario">{selectedExpense.proveedor?.label}</ViewField>
              <ViewField label="Comprobante">{selectedExpense.tipoComprobante?.label}</ViewField>
              <ViewField label="Origen de fondos">{selectedExpense.origenFondos?.label}</ViewField>
              <ViewField label="Moneda">{selectedExpense.moneda}</ViewField>
              <ViewField label="Registro">{getAuditLine(selectedExpense)}</ViewField>
              <ViewField label="Observaciones" wide>{selectedExpense.observaciones}</ViewField>
            </div>

            <div className="gastos-modal__actions">
              <button type="button" className="btn gastos-primary-btn" onClick={() => setSelectedExpense(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
