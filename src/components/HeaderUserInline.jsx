import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function HeaderUserInline() {
  const { user } = useAuth();
  if (!user) return null;

  const name  = user.displayName || user.email || 'Usuario';
  const photo = user.photoURL;

  return (
    <span className="header__userline">
      <span className="mx-1 opacity-50">•</span>
      Usuario:
      {photo ? (
        <img src={photo} alt={name} className="header__userline__avatar" />
      ) : null}
      <strong className="ml-1">{name}</strong>
    </span>
  );
}