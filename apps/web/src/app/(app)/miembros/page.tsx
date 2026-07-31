'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { UserChip } from '@/components/user-chip';
import { authStorage } from '@/lib/auth-storage';
import { adminUsersApi, type UserListItem } from '@/lib/admin-users';

const ROLE_STYLE: Record<string, string> = {
  tenant_admin: 'bg-(--didacta-coral)/10 text-(--didacta-coral)',
  super_admin: 'bg-(--didacta-coral)/10 text-(--didacta-coral)',
  formador: 'bg-(--didacta-growth)/10 text-(--didacta-growth)',
  alumno: 'bg-(--didacta-trust)/10 text-(--didacta-trust)',
  auditor: 'bg-(--didacta-balance)/10 text-(--didacta-balance)',
  empresa_manager: 'bg-bg-subtle text-text-muted',
};

function primaryRole(roles: string[]): string {
  const priority = [
    'super_admin',
    'tenant_admin',
    'formador',
    'auditor',
    'empresa_manager',
    'alumno',
  ];
  return priority.find((r) => roles.includes(r)) ?? roles[0] ?? 'alumno';
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'SuperAdmin',
  tenant_admin: 'Admin',
  formador: 'Formador',
  alumno: 'Alumno',
  auditor: 'Auditor',
  empresa_manager: 'Empresa',
};

export default function MiembrosPage() {
  const session = authStorage.getSession();
  const isAdmin =
    session?.user.roles.some((r) => ['super_admin', 'tenant_admin'].includes(r)) ?? false;

  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(isAdmin);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    async function load() {
      try {
        const token = authStorage.getAccessToken();
        if (!token) return;
        const result = await adminUsersApi.list(token, { search: query || undefined, limit: 50 });
        if (!cancelled) {
          setUsers(result.items);
          setTotal(result.total);
        }
      } catch {
        if (!cancelled) setError('No se pudo cargar el directorio de miembros.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    setLoading(true);
    load();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, query]);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold text-text">Miembros</h1>
          {isAdmin && !loading && !error && (
            <span className="rounded-full bg-bg-subtle px-3 py-1 text-sm font-medium text-text-muted">
              {total} miembros
            </span>
          )}
        </div>

        {/* Buscador (solo admin) */}
        {isAdmin && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <svg
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="shrink-0 text-text-muted"
              viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por nombre o email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-text-muted hover:text-text"
              >
                ×
              </button>
            )}
          </div>
        )}

        {/* Contenido */}
        {!isAdmin ? (
          <div className="rounded-xl border border-border bg-surface p-12 text-center">
            <p className="text-base font-semibold text-text">Directorio de miembros</p>
            <p className="mt-1 text-sm text-text-muted">
              El directorio público de miembros estará disponible próximamente.
            </p>
          </div>
        ) : error ? (
          <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">
            {error}
          </div>
        ) : loading ? (
          <p className="text-sm text-text-muted">Cargando…</p>
        ) : users.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-12 text-center">
            <p className="text-sm text-text-muted">
              {query ? `Sin resultados para "${query}"` : 'No hay miembros en este tenant.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {users.map((u) => {
              const role = primaryRole(u.roles);
              return (
                <div
                  key={u.id}
                  className="flex items-center gap-2 rounded-xl border border-border bg-surface p-4 transition-shadow hover:border-border-strong hover:shadow-sm"
                >
                  <UserChip
                    userId={u.id}
                    name={u.name}
                    email={u.email}
                    size={40}
                    className="min-w-0 flex-1"
                    nameClassName="truncate text-sm font-semibold text-text"
                  />
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${ROLE_STYLE[role] ?? 'bg-bg-subtle text-text-muted'}`}
                  >
                    {ROLE_LABELS[role] ?? role}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
