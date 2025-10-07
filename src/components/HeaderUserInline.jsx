import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function HeaderUserInline() {
  const { user } = useAuth();
  if (!user) return null;

  const name  = user.displayName || user.email || 'Usuario';
  const photo = user.photoURL;

  return (
    <span className="header__userline">
      <span className="header__userline__label">Usuario:</span>
      {photo ? (
        <img src={photo} alt={name} className="header__userline__avatar" />
      ) : (
        <span className="header__userline__avatar header__userline__avatar--fallback">
          {name?.[0]?.toUpperCase() || 'U'}
        </span>
      )}
      <strong className="header__userline__name">{name}</strong>
    </span>
  );
}