import { Outlet, Link, useLocation } from 'react-router-dom';

export default function HostsLayout() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen grid grid-cols-[240px_1fr]">
      <aside className="border-r p-4">
        <h2 className="font-bold mb-3">Anfitriones</h2>
        <nav className="flex flex-col gap-2">
          <Link className={linkCls(pathname === '/hosts')} to="/hosts">Planillas diarias</Link>
          <Link className={linkCls(pathname === '/hosts/new')} to="/hosts/new">Nueva planilla</Link>
          {/* Más adelante: <Link to="/hosts/pagos">Pagos</Link> */}
        </nav>
      </aside>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
const linkCls = (active) => `px-2 py-1 rounded ${active ? 'bg-blue-600 text-white' : 'hover:bg-gray-100'}`;