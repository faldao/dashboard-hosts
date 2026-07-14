// src/pages/DashboardPage.jsx
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { doc, getDoc } from 'firebase/firestore';
import { firestore } from '../../lib/firebase'; // Asegúrate que la ruta a tu config de firebase sea correcta

// Esta es la lista "maestra" de todas las aplicaciones que existen en tu sistema.
// Firestore solo dirá a CUÁLES tiene acceso el usuario, pero aquí definimos
// los detalles de cada una (nombre, ícono, ruta, etc.).
const REPORTES_APP = {
  name: 'Reportes',
  description: 'Consulta recaudacion por periodo, forma de pago y propiedad.',
  href: '/reportes',
  icon: '\uD83D\uDCCA',
};

const GASTOS_APP = {
  name: 'Gastos',
  description: 'Registra pagos y gastos operativos por proveedor, concepto y origen.',
  href: '/gastos',
  icon: '\uD83D\uDCB8',
};

const DEFAULT_APP_IDS = ['reportes', 'gastos'];

const ALL_APPS = {
  'planilla_hosts': {
    name: 'Planilla de Hosts',
    description: 'Gestiona check-ins, check-outs y pagos de reservas.',
    href: '/planilla-hosts',
    icon: '📅' // Los emojis son una forma fácil y rápida de poner íconos
  },
  'reportes_financieros': {
    name: REPORTES_APP.name,
    description: REPORTES_APP.description,
    href: '/reportes', // Ruta para una futura app
    icon: '📊'
  },
  'reportes': {
    ...REPORTES_APP,
  },
  'gastos': {
    ...GASTOS_APP,
  },

  'liquidaciones': {
    name: 'Liquidaciones',
    description: 'Arma liquidaciones por unidad o por propiedad (por check-in).',
    href: '/liquidaciones',
    icon: '🧾',
  },

  // Podés agregar más aplicaciones aquí en el futuro
};

export default function DashboardPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const [userApps, setUserApps] = useState([]);
  const [isLoadingApps, setIsLoadingApps] = useState(true);

  // Este efecto se ejecuta cuando el componente se monta o cuando cambia el usuario
  useEffect(() => {
    // Si la autenticación no está cargando y no hay usuario, no debería estar aquí.
    // Aunque ProtectedRoute ya lo protege, esta es una doble seguridad.
    if (!authLoading && !user) {
      navigate('/login');
      return;
    }

    // Si hay un usuario, buscamos sus permisos en Firestore
    if (user) {
      const fetchUserApps = async () => {
        setIsLoadingApps(true);
        // Creamos una referencia al documento del usuario en la colección 'users'
        const userDocRef = doc(firestore, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          const userData = userDoc.data();
          const accessibleAppIds = Array.from(new Set([...(userData.apps || []), ...DEFAULT_APP_IDS])); // Obtenemos el array 'apps'

          // Mapeamos los IDs de las apps a los objetos completos de nuestra lista ALL_APPS
          const appsToShow = accessibleAppIds
            .map(appId => ALL_APPS[appId])
            .filter(Boolean) // Este filtro elimina cualquier app que no exista en nuestra lista maestra
            .filter((app, index, apps) => apps.findIndex(a => a.href === app.href) === index);

          setUserApps(appsToShow);
        } else {
          console.warn("Usuario autenticado pero sin perfil en Firestore. No tendrá acceso a ninguna app.");
          setUserApps([]);
        }
        setIsLoadingApps(false);
      };

      fetchUserApps();
    }
  }, [user, authLoading, navigate]);

  // Mostramos un loader general mientras se verifica la sesión o se cargan las apps
  if (authLoading || isLoadingApps) {
    return (
      <div className="loader-container">
        <div className="loader">Cargando portal...</div>
      </div>
    );
  }
  
  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Portal de Aplicaciones</h1>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span>Hola, {user.displayName}!</span>
          <button onClick={logout} className="btn btn--muted" style={{ marginLeft: '1rem' }}>
            Cerrar Sesión
          </button>
        </div>
      </header>

      <main className="app-grid">
        {userApps.length > 0 ? (
          // Si el usuario tiene apps, las mostramos como tarjetas clickeables
          userApps.map(app => (
            <Link key={app.href} to={app.href} className="app-card">
              <div className="app-card__icon">{app.icon}</div>
              <h2 className="app-card__name">{app.name}</h2>
              <p className="app-card__description">{app.description}</p>
            </Link>
          ))
        ) : (
          // Si el array de apps está vacío, mostramos un mensaje
          <p>No tienes acceso a ninguna aplicación. Por favor, contacta a un administrador.</p>
        )}
      </main>
    </div>
  );
}
