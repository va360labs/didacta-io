'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminUsersApi,
  ROLE_LABELS,
  STATUS_LABELS,
  type AssignableRole,
  type UserListItem,
  type UserStatus,
} from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';

/// Tamaño de página por defecto. Coincide con el `limit` default del API.
/// Si cambia, ajustar también en backend (admin-users.controller.ts).
const PAGE_SIZE = 100;

const STATUS_VARIANT: Record<UserStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  ACTIVE: 'success',
  PENDING: 'warning',
  SUSPENDED: 'danger',
  DEACTIVATED: 'muted',
};

function userInitials(name: string | null, email: string): string {
  return (name ?? email)
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
}

export default function UsuariosPage() {
  const [users, setUsers] = useState<UserListItem[] | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | UserStatus>('');
  const [roleFilter, setRoleFilter] = useState<'' | AssignableRole>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');

  async function reload(targetPage: number = page) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const res = await adminUsersApi.list(token, {
        search: search.trim() || undefined,
        status: statusFilter || undefined,
        role: roleFilter || undefined,
        externalSource: sourceFilter || undefined,
        page: targetPage,
        limit: PAGE_SIZE,
      });
      setUsers(res.items);
      setTotal(res.total);
      setHasMore(res.hasMore);
      setPage(res.page);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los usuarios.');
    }
  }

  /// Aplicar filtros = volver siempre a página 1, si no el operador puede
  /// quedar "atascado" en una página fuera de rango después de filtrar.
  function applyFilters() {
    void reload(1);
  }

  useEffect(() => {
    void reload(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = users && users.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = users ? (page - 1) * PAGE_SIZE + users.length : 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Usuarios</h1>
          <p className="mt-1 text-text-muted">
            Gestioná las personas que tienen acceso a tu organización.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/usuarios/invitar">Invitar persona</Link>
        </Button>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex-1 min-w-[240px]">
            <label className="text-xs font-semibold text-text-muted" htmlFor="search">
              Buscar
            </label>
            <Input
              id="search"
              type="search"
              placeholder="Email o nombre…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="status">
              Estado
            </label>
            <Select
              id="status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as UserStatus)}
              className="mt-1 min-w-[160px]"
            >
              <option value="">Todos</option>
              <option value="ACTIVE">Activos</option>
              <option value="PENDING">Pendientes</option>
              <option value="SUSPENDED">Suspendidos</option>
              <option value="DEACTIVATED">Desactivados</option>
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="role">
              Rol
            </label>
            <Select
              id="role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as AssignableRole)}
              className="mt-1 min-w-[180px]"
            >
              <option value="">Todos</option>
              {Object.entries(ROLE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="source">
              Origen
            </label>
            <Select
              id="source"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="mt-1 min-w-40"
            >
              <option value="">Todos</option>
              <option value="learndash">LearnDash</option>
            </Select>
          </div>
          <Button variant="secondary" onClick={applyFilters}>
            Aplicar
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : users === null ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : users.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-xl font-semibold">No hay usuarios todavía</h3>
            <p className="max-w-md text-text-muted">
              Invitá a tu primer usuario o ajustá los filtros si esperabas ver a alguien acá.
            </p>
            <Button asChild>
              <Link href="/admin/usuarios/invitar">Invitar persona</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {total === 0
                ? '0 usuarios'
                : `Mostrando ${rangeStart}–${rangeEnd} de ${total} usuarios`}
            </CardTitle>
            <CardDescription>
              Click sobre un usuario para ver el detalle y gestionar su acceso.
            </CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-6 py-3 font-semibold">Persona</th>
                  <th className="px-3 py-3 font-semibold">Roles</th>
                  <th className="px-3 py-3 font-semibold">Estado</th>
                  <th className="px-3 py-3 font-semibold">Origen</th>
                  <th className="px-3 py-3 font-semibold">MFA</th>
                  <th className="px-6 py-3 font-semibold text-right">Último login</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-6 py-3">
                      <Link
                        href={`/admin/usuarios/${u.id}` as never}
                        className="flex items-center gap-3 hover:text-brand-700"
                      >
                        <span
                          aria-hidden="true"
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-full font-display text-xs font-bold text-white"
                          style={{
                            background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)',
                          }}
                        >
                          {userInitials(u.name, u.email) || '·'}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-text">{u.name ?? u.email}</p>
                          {u.name ? (
                            <p className="truncate text-xs text-text-subtle">{u.email}</p>
                          ) : null}
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0 ? (
                          <span className="text-xs italic text-text-subtle">Sin rol</span>
                        ) : (
                          u.roles.map((r) => (
                            <Badge key={r} variant="muted">
                              {ROLE_LABELS[r as AssignableRole] ?? r}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={STATUS_VARIANT[u.status]}>{STATUS_LABELS[u.status]}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      {u.externalSource ? (
                        <Badge variant="muted" title={u.externalId ?? undefined}>
                          {u.externalSource}
                        </Badge>
                      ) : (
                        <span className="text-xs text-text-subtle">Nativo</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {u.mfaEnabled ? (
                        <Badge variant="success" dot>
                          Activo
                        </Badge>
                      ) : (
                        <Badge variant="muted">No</Badge>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right text-xs text-text-muted tabular-nums">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('es-ES') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* === Paginación === */}
          {totalPages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2 px-6 py-3">
              <p className="text-xs text-text-muted tabular-nums">
                Página {page} de {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void reload(page - 1)}
                  disabled={page <= 1}
                >
                  ← Anterior
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void reload(page + 1)}
                  disabled={!hasMore}
                >
                  Siguiente →
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
