// src/components/HeaderUserBadge.jsx
import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function HeaderUserBadge() {
  const { user, logout } = useAuth();
  if (!user) return null;

  const name  = user.displayName || user.email || 'Usuario';
  const photo = user.photoURL;

  return (
    <div className="flex items-center gap-2">
      {photo ? (
        <img src={photo} alt={name} className="w-8 h-8 rounded-full" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-gray-300 grid place-items-center text-sm">
          {name[0]?.toUpperCase()}
        </div>
      )}
      <span className="text-sm opacity-80">{name}</span>
      <button className="btn btn--tiny" onClick={logout} title="Cerrar sesión">Salir</button>
    </div>
  );
}