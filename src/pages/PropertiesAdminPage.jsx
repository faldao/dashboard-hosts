import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import GalleryManager from '../components/GalleryManager';
import LocationPicker from '../components/LocationPicker';
import './PropertiesAdminPage.css';

const emptyProperty = {
  id: '', nombre: '', short_name: '', descripcion: '', api_key: '', chatbot_rate: '',
  activar_para_planillas_diarias: false, activar_para_venta: false,
  estacionamiento: '', mascotas: '', wifi: '', descripcion_detallada: '',
  tipo_viajero: '', historia: '', galeria: [], caracteristicasText: '{}', faqText: '[]',
  ubicacion: { direccion: '', zona: '', lat: '', lng: '' },
};

const jsonText = (value, fallback) => JSON.stringify(value ?? fallback, null, 2);
const propertyToForm = (item) => ({
  ...emptyProperty,
  ...item,
  galeria: Array.isArray(item.galeria) ? item.galeria : [],
  ubicacion: {
    direccion: item.ubicacion?.direccion || '',
    zona: item.ubicacion?.zona || '',
    lat: item.ubicacion?.lat ?? '',
    lng: item.ubicacion?.lng ?? '',
  },
  caracteristicasText: jsonText(item.caracteristicas, {}),
  faqText: jsonText(item.faq, []),
});
function parseJsonField(value, fallback, label) {
  if (!String(value || '').trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} debe contener JSON válido.`);
  }
}

function formData(form) {
  const { id, caracteristicasText, faqText, ...data } = form;
  return {
    ...data,
    caracteristicas: parseJsonField(caracteristicasText, {}, 'Características'),
    faq: parseJsonField(faqText, [], 'Preguntas frecuentes'),
  };
}

function TextField({ label, name, value, onChange, type = 'text', required = false, disabled = false, placeholder = '' }) {
  return (
    <label className="property-admin-field">
      <span>{label}</span>
      <input name={name} type={type} value={value ?? ''} onChange={onChange} required={required} disabled={disabled} placeholder={placeholder} />
    </label>
  );
}

function TextAreaField({ label, name, value, onChange, rows = 3, hint = '' }) {
  return (
    <label className="property-admin-field property-admin-field--wide">
      <span>{label}</span>
      <textarea name={name} value={value ?? ''} onChange={onChange} rows={rows} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function ToggleField({ label, name, checked, onChange }) {
  return (
    <label className="property-admin-toggle">
      <input name={name} type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

export default function PropertiesAdminPage() {
  const { idToken } = useAuth();
  const navigate = useNavigate();
  const [properties, setProperties] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [propertyForm, setPropertyForm] = useState(emptyProperty);
  const [propertyIsNew, setPropertyIsNew] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadProperties = useCallback(async (preferredId = '') => {
    if (!idToken) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.get('/api/admin/properties');
      const items = Array.isArray(data?.properties) ? data.properties : [];
      setProperties(items);
      const next = items.find((item) => item.id === preferredId)
        || items.find((item) => item.id === selectedId)
        || items[0];
      if (next) {
        setSelectedId(next.id);
        setPropertyForm(propertyToForm(next));
        setPropertyIsNew(false);
      } else {
        setSelectedId('');
        setPropertyForm(emptyProperty);
        setPropertyIsNew(true);
      }
    } catch (caught) {
      setError(caught?.response?.data?.error || 'No se pudieron cargar las propiedades.');
    } finally {
      setLoading(false);
    }
  }, [idToken, selectedId]);

  useEffect(() => {
    void loadProperties();
  }, [idToken]);

  const selectedProperty = properties.find((item) => item.id === selectedId) || null;
  const filteredProperties = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return properties;
    return properties.filter((item) => `${item.nombre} ${item.id} ${item.short_name || ''}`.toLowerCase().includes(term));
  }, [properties, search]);

  const changeForm = (setter) => (event) => {
    const { name, value, type, checked } = event.target;
    setter((current) => ({ ...current, [name]: type === 'checkbox' ? checked : value }));
  };

  const selectProperty = (item) => {
    setSelectedId(item.id);
    setPropertyForm(propertyToForm(item));
    setPropertyIsNew(false);
    setError('');
    setSuccess('');
  };

  const newProperty = () => {
    setSelectedId('');
    setPropertyForm(emptyProperty);
    setPropertyIsNew(true);
    setError('');
    setSuccess('');
  };

  const saveProperty = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const id = propertyForm.id.trim();
      const method = propertyIsNew ? 'post' : 'patch';
      await axios[method]('/api/admin/properties', {
        entity: 'property', propertyId: id, data: formData(propertyForm),
      });
      setSuccess(`La propiedad ${propertyForm.nombre} fue guardada correctamente.`);
      await loadProperties(id);
    } catch (caught) {
      setError(caught?.response?.data?.error || caught.message || 'No se pudo guardar la propiedad.');
    } finally {
      setSaving(false);
    }
  };

  const editDepartment = (item) => {
    navigate(`/propiedades-admin/${encodeURIComponent(selectedId)}/departamentos/${encodeURIComponent(item.id)}`);
  };

  const newDepartment = () => {
    navigate(`/propiedades-admin/${encodeURIComponent(selectedId)}/departamentos/nuevo`);
  };

  return (
    <div className="property-admin-page">
      <nav className="portal-link-bar"><Link to="/dashboard">← Volver al portal</Link></nav>
      <main className="property-admin-main">
        <header className="property-admin-header">
          <div>
            <p>Configuración operativa</p>
            <h1>Propiedades y departamentos</h1>
            <span>Administrá la información central de cada alojamiento.</span>
          </div>
          <button type="button" onClick={newProperty}>+ Nueva propiedad</button>
        </header>

        {error ? <p className="property-admin-message property-admin-message--error">{error}</p> : null}
        {success ? <p className="property-admin-message property-admin-message--success">{success}</p> : null}

        <div className="property-admin-layout">
          <aside className="property-admin-sidebar">
            <div className="property-admin-sidebar__head">
              <strong>{properties.length} propiedades</strong>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar…" aria-label="Buscar propiedades" />
            </div>
            <div className="property-admin-property-list">
              {loading ? <p>Cargando propiedades…</p> : filteredProperties.map((item) => (
                <button key={item.id} type="button" className={selectedId === item.id && !propertyIsNew ? 'is-selected' : ''} onClick={() => selectProperty(item)}>
                  <strong>{item.nombre}</strong>
                  <span>ID {item.id} · {item.departments?.length || 0} departamentos</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="property-admin-workspace">
            <form className="property-admin-card" onSubmit={saveProperty}>
              <div className="property-admin-card__head">
                <div>
                  <p>{propertyIsNew ? 'Alta' : 'Modificación'}</p>
                  <h2>{propertyIsNew ? 'Nueva propiedad' : propertyForm.nombre}</h2>
                </div>
                <button type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar propiedad'}</button>
              </div>

              <div className="property-admin-form-grid">
                <TextField label="ID de propiedad" name="id" value={propertyForm.id} onChange={changeForm(setPropertyForm)} required disabled={!propertyIsNew} placeholder="Ej. 103" />
                <TextField label="Nombre" name="nombre" value={propertyForm.nombre} onChange={changeForm(setPropertyForm)} required />
                <TextField label="Nombre corto" name="short_name" value={propertyForm.short_name} onChange={changeForm(setPropertyForm)} />
                <TextField label="Tarifa chatbot" name="chatbot_rate" type="number" value={propertyForm.chatbot_rate} onChange={changeForm(setPropertyForm)} />
                <TextAreaField label="Descripción" name="descripcion" value={propertyForm.descripcion} onChange={changeForm(setPropertyForm)} />
                <TextAreaField label="API key" name="api_key" value={propertyForm.api_key} onChange={changeForm(setPropertyForm)} rows={2} />
                <ToggleField label="Usar en planillas diarias" name="activar_para_planillas_diarias" checked={propertyForm.activar_para_planillas_diarias} onChange={changeForm(setPropertyForm)} />
                <ToggleField label="Activa para venta" name="activar_para_venta" checked={propertyForm.activar_para_venta} onChange={changeForm(setPropertyForm)} />
                <TextField label="Estacionamiento" name="estacionamiento" value={propertyForm.estacionamiento} onChange={changeForm(setPropertyForm)} />
                <TextField label="Mascotas" name="mascotas" value={propertyForm.mascotas} onChange={changeForm(setPropertyForm)} />
                <TextField label="Wifi" name="wifi" value={propertyForm.wifi} onChange={changeForm(setPropertyForm)} />
                <TextField label="Tipo de viajero" name="tipo_viajero" value={propertyForm.tipo_viajero} onChange={changeForm(setPropertyForm)} />
                <LocationPicker
                  value={propertyForm.ubicacion}
                  onChange={(ubicacion) => setPropertyForm((current) => ({ ...current, ubicacion }))}
                />
                <TextAreaField label="Descripción detallada" name="descripcion_detallada" value={propertyForm.descripcion_detallada} onChange={changeForm(setPropertyForm)} rows={4} />
                <TextAreaField label="Historia" name="historia" value={propertyForm.historia} onChange={changeForm(setPropertyForm)} rows={4} />
                <GalleryManager
                  entity="property"
                  propertyId={propertyForm.id}
                  items={propertyForm.galeria}
                  disabled={propertyIsNew}
                  onChange={(galeria) => setPropertyForm((current) => ({ ...current, galeria }))}
                />
                <TextAreaField label="Características (JSON)" name="caracteristicasText" value={propertyForm.caracteristicasText} onChange={changeForm(setPropertyForm)} rows={5} />
                <TextAreaField label="Preguntas frecuentes (JSON)" name="faqText" value={propertyForm.faqText} onChange={changeForm(setPropertyForm)} rows={5} />
              </div>
            </form>

            {!propertyIsNew && selectedProperty ? (
              <section className="property-admin-card property-admin-departments">
                <div className="property-admin-card__head">
                  <div><p>Unidades</p><h2>Departamentos</h2></div>
                  <button type="button" onClick={newDepartment}>+ Nuevo departamento</button>
                </div>

                <div className="property-admin-department-list">
                  {(selectedProperty.departments || []).map((item) => (
                    <article key={item.id}>
                      <div><strong>{item.nombre}</strong><span>ID {item.id}{item.wubook_shortname ? ` · ${item.wubook_shortname}` : ''}</span></div>
                      <span className={item.activar_para_venta ? 'is-active' : ''}>{item.activar_para_venta ? 'En venta' : 'Inactivo'}</span>
                      <button type="button" onClick={() => editDepartment(item)}>Editar</button>
                    </article>
                  ))}
                  {!selectedProperty.departments?.length ? <p className="property-admin-empty">Esta propiedad todavía no tiene departamentos.</p> : null}
                </div>

              </section>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}
