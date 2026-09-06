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

export default function AsistenciaAdminPage() {
  const { idToken } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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
            <p>Creá las cuentas que podrán ingresar a la aplicación Presente.</p>
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
                <input
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={updateField}
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                  placeholder="Mínimo 8 caracteres"
                />
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
                <h2>Usuarios de Presente</h2>
                <p>Cuentas creadas para el registro laboral.</p>
              </div>
            </div>

            {loading ? (
              <p className="attendance-admin-empty">Cargando usuarios…</p>
            ) : users.length === 0 ? (
              <p className="attendance-admin-empty">Todavía no hay usuarios creados.</p>
            ) : (
              <div className="attendance-admin-users">
                {users.map((item) => (
                  <article className="attendance-admin-user" key={item.uid}>
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
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
