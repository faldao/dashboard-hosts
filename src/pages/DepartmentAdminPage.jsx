import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import GalleryManager from '../components/GalleryManager';
import './PropertiesAdminPage.css';
import './DepartmentAdminPage.css';

const emptyDepartment = {
  id: '', nombre: '', wubook_shortname: '', descripcion: '', consulta: '',
  activar_para_venta: false, m2: '', m2_num: '', vista: '', dormitorios: '',
  capacidad: '', capacidad_num: '', galeria: [], caracteristicasText: '{}', faqText: '[]',
};

function departmentToForm(item) {
  return {
    ...emptyDepartment,
    ...item,
    galeria: Array.isArray(item.galeria) ? item.galeria : [],
    caracteristicasText: JSON.stringify(item.caracteristicas || {}, null, 2),
    faqText: JSON.stringify(item.faq || [], null, 2),
  };
}

function parseJson(value, fallback, label) {
  if (!String(value || '').trim()) return fallback;
  try { return JSON.parse(value); } catch { throw new Error(`${label} debe contener JSON válido.`); }
}

function formData(form) {
  const { id, caracteristicasText, faqText, ...data } = form;
  return {
    ...data,
    caracteristicas: parseJson(caracteristicasText, {}, 'Características'),
    faq: parseJson(faqText, [], 'Preguntas frecuentes'),
  };
}

function TextField({ label, name, value, onChange, type = 'text', required = false, disabled = false }) {
  return <label className="property-admin-field"><span>{label}</span><input name={name} type={type} value={value ?? ''} onChange={onChange} required={required} disabled={disabled} /></label>;
}

function TextAreaField({ label, name, value, onChange, rows = 3 }) {
  return <label className="property-admin-field property-admin-field--wide"><span>{label}</span><textarea name={name} value={value ?? ''} onChange={onChange} rows={rows} /></label>;
}

export default function DepartmentAdminPage() {
  const { idToken } = useAuth();
  const { propertyId, departmentId } = useParams();
  const navigate = useNavigate();
  const isNew = departmentId === 'nuevo';
  const [property, setProperty] = useState(null);
  const [form, setForm] = useState(emptyDepartment);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!idToken) return;
    let active = true;
    setLoading(true);
    axios.get('/api/admin/properties').then(({ data }) => {
      if (!active) return;
      const foundProperty = (data.properties || []).find((item) => item.id === propertyId);
      if (!foundProperty) throw new Error('La propiedad seleccionada no existe.');
      setProperty(foundProperty);
      if (isNew) {
        setForm(emptyDepartment);
      } else {
        const department = (foundProperty.departments || []).find((item) => item.id === departmentId);
        if (!department) throw new Error('El departamento seleccionado no existe.');
        setForm(departmentToForm(department));
      }
      setError('');
    }).catch((caught) => {
      if (active) setError(caught?.response?.data?.error || caught.message || 'No se pudo cargar el departamento.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [idToken, propertyId, departmentId, isNew]);

  const change = (event) => {
    const { name, value, type, checked } = event.target;
    setForm((current) => ({ ...current, [name]: type === 'checkbox' ? checked : value }));
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const id = form.id.trim();
      await axios[isNew ? 'post' : 'patch']('/api/admin/properties', {
        entity: 'department', propertyId, departmentId: id, data: formData(form),
      });
      setSuccess(`El departamento ${form.nombre} fue guardado correctamente.`);
      if (isNew) {
        navigate(`/propiedades-admin/${encodeURIComponent(propertyId)}/departamentos/${encodeURIComponent(id)}`, { replace: true });
      }
    } catch (caught) {
      setError(caught?.response?.data?.error || caught.message || 'No se pudo guardar el departamento.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="property-admin-page">
      <nav className="portal-link-bar"><Link to="/propiedades-admin">← Volver a propiedades</Link></nav>
      <main className="property-admin-main department-admin-main">
        <header className="department-admin-header">
          <div>
            <p>Departamento de {property?.nombre || propertyId}</p>
            <h1>{isNew ? 'Nuevo departamento' : form.nombre || 'Editar departamento'}</h1>
            <span>La edición se realiza en esta página independiente.</span>
          </div>
          <button type="button" onClick={() => navigate('/propiedades-admin')}>Cerrar</button>
        </header>

        {error ? <p className="property-admin-message property-admin-message--error">{error}</p> : null}
        {success ? <p className="property-admin-message property-admin-message--success">{success}</p> : null}
        {loading ? <section className="property-admin-card department-admin-loading">Cargando departamento…</section> : (
          <form className="property-admin-card" onSubmit={save}>
            <div className="property-admin-card__head">
              <div><p>{isNew ? 'Alta' : 'Modificación'}</p><h2>Datos del departamento</h2></div>
              <button type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar departamento'}</button>
            </div>
            <div className="property-admin-form-grid">
              <TextField label="ID de departamento" name="id" value={form.id} onChange={change} required disabled={!isNew} />
              <TextField label="Nombre" name="nombre" value={form.nombre} onChange={change} required />
              <TextField label="Nombre corto Wubook" name="wubook_shortname" value={form.wubook_shortname} onChange={change} />
              <TextField label="Superficie (m²)" name="m2_num" type="number" value={form.m2_num} onChange={change} />
              <TextField label="Superficie descriptiva" name="m2" value={form.m2} onChange={change} />
              <TextField label="Capacidad" name="capacidad_num" type="number" value={form.capacidad_num} onChange={change} />
              <TextField label="Capacidad descriptiva" name="capacidad" value={form.capacidad} onChange={change} />
              <TextField label="Dormitorios" name="dormitorios" value={form.dormitorios} onChange={change} />
              <TextField label="Vista" name="vista" value={form.vista} onChange={change} />
              <label className="property-admin-toggle"><input name="activar_para_venta" type="checkbox" checked={form.activar_para_venta} onChange={change} /><span>Activo para venta</span></label>
              <TextAreaField label="Descripción" name="descripcion" value={form.descripcion} onChange={change} />
              <TextAreaField label="Consulta" name="consulta" value={form.consulta} onChange={change} />
              <GalleryManager
                entity="department"
                propertyId={propertyId}
                departmentId={form.id}
                items={form.galeria}
                disabled={isNew}
                onChange={(galeria) => setForm((current) => ({ ...current, galeria }))}
              />
              <TextAreaField label="Características (JSON)" name="caracteristicasText" value={form.caracteristicasText} onChange={change} rows={6} />
              <TextAreaField label="Preguntas frecuentes (JSON)" name="faqText" value={form.faqText} onChange={change} rows={6} />
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
