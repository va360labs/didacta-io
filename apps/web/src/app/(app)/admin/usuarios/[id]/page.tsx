'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminUsersApi,
  ASSIGNABLE_ROLES,
  ROLE_LABELS,
  STATUS_LABELS,
  type AssignableRole,
  type UserDetail,
  type UserStatus,
} from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';

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

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<AssignableRole>('alumno');
  const [resendStatus, setResendStatus] = useState<'idle' | 'sent' | 'error'>('idle');

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token || !params?.id) return;
    try {
      setError(null);
      setUser(await adminUsersApi.getOne(token, params.id));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar el detalle.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  async function handleStatusChange(status: UserStatus) {
    const token = authStorage.getAccessToken();
    if (!token || !user) return;

    if (status === 'SUSPENDED' || status === 'DEACTIVATED') {
      if (
        !confirm(
          `¿Confirmás cambiar a "${STATUS_LABELS[status]}"? Las sesiones activas se cierran.`,
        )
      ) {
        return;
      }
    }

    setBusy('status');
    try {
      await adminUsersApi.setStatus(token, user.id, status);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cambiar el estado.');
    } finally {
      setBusy(null);
    }
  }

  async function handleAssignRole() {
    const token = authStorage.getAccessToken();
    if (!token || !user) return;
    setBusy('role-add');
    try {
      await adminUsersApi.assignRole(token, user.id, newRole);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos asignar el rol.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveRole(role: string) {
    if (!confirm(`¿Quitarle el rol "${ROLE_LABELS[role as AssignableRole] ?? role}"?`)) return;
    const token = authStorage.getAccessToken();
    if (!token || !user) return;
    setBusy(`role-rm-${role}`);
    try {
      await adminUsersApi.removeRole(token, user.id, role as AssignableRole);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos quitar el rol.');
    } finally {
      setBusy(null);
    }
  }

  async function handleResend() {
    const token = authStorage.getAccessToken();
    if (!token || !user) return;
    setBusy('resend');
    setResendStatus('idle');
    try {
      await adminUsersApi.resendInvite(token, user.id);
      setResendStatus('sent');
      setTimeout(() => setResendStatus('idle'), 4000);
    } catch (e) {
      setResendStatus('error');
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos reenviar el email.');
    } finally {
      setBusy(null);
    }
  }

  if (error && !user) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" asChild className="self-start">
          <Link href="/admin/usuarios">← Volver al listado</Link>
        </Button>
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-10 w-32" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" asChild className="self-start">
        <Link href="/admin/usuarios">← Volver al listado</Link>
      </Button>

      {/* === Hero del usuario === */}
      <Card>
        <CardContent className="flex flex-wrap items-start gap-4 p-5">
          <div
            aria-hidden="true"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-full font-display text-xl font-bold text-white"
            style={{
              background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)',
            }}
          >
            {userInitials(user.name, user.email) || '·'}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-3xl font-bold tracking-tight">
              {user.name ?? user.email}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">{user.email}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={STATUS_VARIANT[user.status]} dot>
                {STATUS_LABELS[user.status]}
              </Badge>
              {user.mfaEnabled ? (
                <Badge variant="success" dot>
                  MFA activo
                </Badge>
              ) : (
                <Badge variant="muted">MFA desactivado</Badge>
              )}
              {user.emailVerified ? null : <Badge variant="warning">Email sin verificar</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        {/* === Acceso === */}
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
                style={{
                  background: 'var(--didacta-info-bg)',
                  color: 'var(--didacta-info-fg)',
                }}
              >
                <Icon name="lock" size={18} />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-base">Acceso</CardTitle>
                <CardDescription>
                  Suspender invalida sus sesiones activas y bloquea el signin.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {user.status !== 'ACTIVE' ? (
              <Button onClick={() => handleStatusChange('ACTIVE')} disabled={busy === 'status'}>
                <Icon name="check" size={16} />
                Reactivar acceso
              </Button>
            ) : null}
            {user.status !== 'SUSPENDED' ? (
              <Button
                variant="destructive"
                onClick={() => handleStatusChange('SUSPENDED')}
                disabled={busy === 'status'}
              >
                <Icon name="lock" size={16} />
                Suspender acceso
              </Button>
            ) : null}
            <Button variant="secondary" onClick={handleResend} disabled={busy === 'resend'}>
              {busy === 'resend' ? (
                'Enviando…'
              ) : resendStatus === 'sent' ? (
                <>
                  <Icon name="check" size={16} />
                  Email reenviado
                </>
              ) : (
                'Reenviar email para definir contraseña'
              )}
            </Button>
          </CardContent>
        </Card>

        {/* === Roles === */}
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
                style={{
                  background: 'var(--didacta-info-bg)',
                  color: 'var(--didacta-info-fg)',
                }}
              >
                <Icon name="shield" size={18} />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-base">Roles</CardTitle>
                <CardDescription>
                  Determinan a qué pantallas y acciones tiene acceso esta persona.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1.5">
              {user.roles.length === 0 ? (
                <p className="text-sm italic text-text-subtle">Sin rol asignado.</p>
              ) : (
                user.roles.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-sm font-semibold text-text"
                  >
                    {ROLE_LABELS[r as AssignableRole] ?? r}
                    <button
                      type="button"
                      onClick={() => handleRemoveRole(r)}
                      disabled={busy === `role-rm-${r}`}
                      className="rounded-full p-0.5 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
                      aria-label={`Quitar rol ${r}`}
                      title={`Quitar rol ${r}`}
                    >
                      <svg
                        aria-hidden="true"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="flex gap-2 border-t border-border-soft pt-3">
              <Select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as AssignableRole)}
                aria-label="Rol a añadir"
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
              <Button onClick={handleAssignRole} disabled={busy === 'role-add'}>
                <Icon name="plus" size={14} />
                Añadir
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* === Sesiones recientes === */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="clock" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">Sesiones recientes</CardTitle>
              <CardDescription>
                Últimas {user.recentSessions.length} sesiones registradas.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {user.recentSessions.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-sm text-text-subtle">
              Sin sesiones registradas.
            </p>
          ) : (
            <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
              {user.recentSessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                >
                  <span className="tabular-nums text-text">
                    Iniciada{' '}
                    {new Date(s.createdAt).toLocaleString('es-AR', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="tabular-nums text-xs text-text-subtle">
                    Vence{' '}
                    {new Date(s.expiresAt).toLocaleString('es-AR', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-text-subtle">
        Creado: {new Date(user.createdAt).toLocaleString('es-AR')} · Última actualización:{' '}
        {new Date(user.updatedAt).toLocaleString('es-AR')}
      </p>
    </div>
  );
}
