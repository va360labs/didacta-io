'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
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
        <Button variant="ghost" asChild>
          <Link href="/admin/usuarios">← Volver al listado</Link>
        </Button>
        <Card>
          <CardContent className="p-6">
            <p className="text-danger-700">{error}</p>
          </CardContent>
        </Card>
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

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            {user.name ?? user.email}
          </h1>
          <p className="mt-1 text-text-muted">{user.email}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant={STATUS_VARIANT[user.status]}>{STATUS_LABELS[user.status]}</Badge>
            {user.mfaEnabled ? <Badge variant="success">MFA activo</Badge> : null}
            {user.emailVerified ? null : <Badge variant="warning">Email sin verificar</Badge>}
          </div>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Acceso</CardTitle>
            <CardDescription>
              Suspender invalida sus sesiones activas y bloquea el signin.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {user.status !== 'ACTIVE' ? (
              <Button onClick={() => handleStatusChange('ACTIVE')} disabled={busy === 'status'}>
                Reactivar acceso
              </Button>
            ) : null}
            {user.status !== 'SUSPENDED' ? (
              <Button
                variant="destructive"
                onClick={() => handleStatusChange('SUSPENDED')}
                disabled={busy === 'status'}
              >
                Suspender acceso
              </Button>
            ) : null}
            <Button variant="secondary" onClick={handleResend} disabled={busy === 'resend'}>
              {busy === 'resend'
                ? 'Enviando…'
                : resendStatus === 'sent'
                  ? '✓ Email reenviado'
                  : 'Reenviar email para definir contraseña'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Roles</CardTitle>
            <CardDescription>
              Determinan a qué pantallas y acciones tiene acceso esta persona.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {user.roles.length === 0 ? (
                <span className="text-sm text-text-subtle">Sin rol asignado.</span>
              ) : (
                user.roles.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1 text-sm"
                  >
                    {ROLE_LABELS[r as AssignableRole] ?? r}
                    <button
                      type="button"
                      onClick={() => handleRemoveRole(r)}
                      disabled={busy === `role-rm-${r}`}
                      className="text-text-subtle hover:text-danger-700"
                      aria-label={`Quitar rol ${r}`}
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <Select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as AssignableRole)}
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
              <Button onClick={handleAssignRole} disabled={busy === 'role-add'}>
                Añadir
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sesiones recientes</CardTitle>
          <CardDescription>
            Últimas {user.recentSessions.length} sesiones registradas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {user.recentSessions.length === 0 ? (
            <p className="text-sm text-text-subtle">Sin sesiones registradas.</p>
          ) : (
            <ul className="space-y-2">
              {user.recentSessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="tabular-nums text-text-muted">
                    Iniciada: {new Date(s.createdAt).toLocaleString('es-AR')}
                  </span>
                  <span className="tabular-nums text-text-subtle">
                    Vence: {new Date(s.expiresAt).toLocaleString('es-AR')}
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
