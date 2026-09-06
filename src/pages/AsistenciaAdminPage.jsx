import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './AsistenciaAdminPage.css';

const initialForm = {
  displayName: '',
  email: '',
  password: '',
};

const initialEditForm = {
  uid: '',
  displayName: '',
  email: '',
  password: '',
  active: true,
};

export default function AsistenciaAdminPage() {
  const { idToken } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingUid, setEditingUid] = useState('');
  const [editForm, setEditForm] = useState(initialEditForm);
  const [updating, setUpdating] = useState(false);
  const [showCreatePassword, setShowCreatePassword] = useState(true);
  const [showEditPassword, setShowEditPassword] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editError, setEditError] = useState('');
  const [listSuccess, setListSuccess] = useState('');

  const loadUsers = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.get('/api/asistencia/users');
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (caught) {
      setError(caught?.response?.data?.error || 'No se pudieron cargar los usuarios.');
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const updateField = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    setListSuccess('');

    try {
      const { data } = await axios.post('/api/asistencia/users', form);
      setUsers((current) => [...current, data.user].sort((a, b) =>
        a.displayName.localeCompare(b.displayName)
      ));
      setSuccess(`La cuenta de ${data.user.displayName} fue creada correctamente.`);
      setForm(initialForm);
    } catch (caught) {
      setError(caught?.response?.data?.error || 'No se pudo crear la cuenta.');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (item) => {
    setEditingUid(item.uid);
    setEditForm({
      uid: item.uid,
      displayName: item.displayName,
      email: item.email,
      password: '',
      active: item.active,
    });
    setShowEditPassword(true);
    setEditError('');
    setListSuccess('');
    setError('');
    setSuccess('');
  };

  const cancelEdit = () => {
    setEditingUid('');
    setEditForm(initialEditForm);
  };

  const updateEditField = (event) => {
    const { name, value, type, checked } = event.target;
    setEditForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    setUpdating(true);
    setEditError('');
    setListSuccess('');

    try {
      const { data } = await axios.patch('/api/asistencia/users', editForm);
      setUsers((current) => current
        .map((item) => item.uid === data.user.uid ? { ...item, ...data.user } : item)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)));
      setListSuccess(`La cuenta de ${data.user.displayName} fue actualizada correctamente.`);
      cancelEdit();
    } catch (caught) {
      setEditError(caught?.response?.data?.error || 'No se pudo actualizar la cuenta.');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="attendance-admin-page">
      <nav className="portal-link-bar">
        <Link to="/dashboard">← Volver al portal</Link>
      </nav>

      <main className="attendance-admin-main">
        <header className="attendance-admin-header">
          <div>
            <p className="attendance-admin-kicker">Registro laboral</p>
            <h1>Administración de usuarios</h1>
            <p>Creá las cuentas que podrán ingresar a la aplicación Reloj.</p>
          </div>
          <div className="attendance-admin-count">
            <strong>{users.length}</strong>
            <span>usuarios</span>
          </div>
        </header>

        <div className="attendance-admin-grid">
          <section className="attendance-admin-card">
            <div className="attendance-admin-card__head">
              <span className="attendance-admin-step">01</span>
              <div>
                <h2>Nueva cuenta</h2>
                <p>La contraseña no se almacena en el dashboard.</p>
              </div>
            </div>

            <form className="attendance-admin-form" onSubmit={submit}>
              <label>
                <span>Nombre y apellido</span>
                <input
                  name="displayName"
                  type="text"
                  value={form.displayName}
                  onChange={updateField}
                  minLength={2}
                  maxLength={120}
                  autoComplete="name"
                  required
                  placeholder="Ej. Martina López"
                />
              </label>

              <label>
                <span>Email</span>
                <input
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={updateField}
                  autoComplete="off"
                  required
                  placeholder="empleado@empresa.com"
                />
              </label>

              <label>
                <span>Contraseña inicial</span>
                <div className="attendance-admin-password-field">
                  <input
                    name="password"
                    type={showCreatePassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={updateField}
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                    placeholder="Mínimo 8 caracteres"
                  />
                  <button type="button" onClick={() => setShowCreatePassword((current) => !current)}>
                    {showCreatePassword ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
              </label>

              {error ? <p className="attendance-admin-message attendance-admin-message--error">{error}</p> : null}
              {success ? <p className="attendance-admin-message attendance-admin-message--success">{success}</p> : null}

              <button className="attendance-admin-submit" type="submit" disabled={saving || !idToken}>
                {saving ? 'Creando cuenta…' : 'Crear usuario'}
              </button>
            </form>
          </section>

          <section className="attendance-admin-card attendance-admin-card--list">
            <div className="attendance-admin-card__head">
              <span className="attendance-admin-step">02</span>
              <div>
                <h2>Usuarios de Reloj</h2>
                <p>Cuentas creadas para el registro laboral.</p>
              </div>
            </div>

            {listSuccess ? <p className="attendance-admin-list-message">{listSuccess}</p> : null}

            {loading ? (
              <p className="attendance-admin-empty">Cargando usuarios…</p>
            ) : users.length === 0 ? (
              <p className="attendance-admin-empty">Todavía no hay usuarios creados.</p>
            ) : (
              <div className="attendance-admin-users">
                {users.map((item) => (
                  <React.Fragment key={item.uid}>
                    <article className="attendance-admin-user">
                      <span className="attendance-admin-avatar" aria-hidden="true">
                        {(item.displayName || item.email || 'U').charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <strong>{item.displayName}</strong>
                        <span>{item.email}</span>
                      </div>
                      <span className={item.active ? 'attendance-admin-status' : 'attendance-admin-status attendance-admin-status--inactive'}>
                        {item.active ? 'Activo' : 'Inactivo'}
                      </span>
                      <button className="attendance-admin-edit-button" type="button" onClick={() => startEdit(item)}>
                        Editar
                      </button>
                    </article>

                    {editingUid === item.uid ? (
                      <form className="attendance-admin-edit-form" onSubmit={saveEdit}>
                        <label>
                          <span>Nombre y apellido</span>
                          <input name="displayName" value={editForm.displayName} onChange={updateEditField} minLength={2} maxLength={120} required />
                        </label>
                        <label>
                          <span>Email</span>
                          <input name="email" type="email" value={editForm.email} onChange={updateEditField} required />
                        </label>
                        <label>
                          <span>Nueva contraseña (opcional)</span>
                          <div className="attendance-admin-password-field">
                            <input
                              name="password"
                              type={showEditPassword ? 'text' : 'password'}
                              value={editForm.password}
                              onChange={updateEditField}
                              minLength={8}
                              maxLength={128}
                              autoComplete="new-password"
                              placeholder="Dejar vacío para conservarla"
                            />
                            <button type="button" onClick={() => setShowEditPassword((current) => !current)}>
                              {showEditPassword ? 'Ocultar' : 'Mostrar'}
                            </button>
                          </div>
                          <small>La contraseña actual no puede consultarse. Podés asignar una nueva.</small>
                        </label>
                        {editError ? <p className="attendance-admin-message attendance-admin-message--error">{editError}</p> : null}
                        <label className="attendance-admin-active-field">
                          <input name="active" type="checkbox" checked={editForm.active} onChange={updateEditField} />
                          <span>Usuario activo</span>
                        </label>
                        <div className="attendance-admin-edit-actions">
                          <button type="button" onClick={cancelEdit}>Cancelar</button>
                          <button type="submit" disabled={updating}>{updating ? 'Guardando…' : 'Guardar cambios'}</button>
                        </div>
                      </form>
                    ) : null}
                  </React.Fragment>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
