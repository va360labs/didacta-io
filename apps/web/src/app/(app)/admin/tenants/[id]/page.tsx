'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminTenantsApi,
  STATUS_LABELS,
  type TenantListItem,
  type TenantStatus,
} from '@/lib/admin-tenants';
import { authStorage } from '@/lib/auth-storage';

const VARIANT: Record<TenantStatus, 'success' | 'danger' | 'muted'> = {
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  ARCHIVED: 'muted',
};

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<TenantListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState('');

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token || !params?.id) return;
    try {
      setError(null);
      setTenant(await adminTenantsApi.getOne(token, params.id));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar el tenant.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  async function handleStatus(status: TenantStatus) {
    if (
      status !== 'ACTIVE' &&
      !confirm(
        `¿Cambiar a "${STATUS_LABELS[status]}"? Las sesiones de TODOS los usuarios del tenant se cierran y no podrán entrar.`,
      )
    ) {
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token || !tenant) return;
    setBusy('status');
    try {
      await adminTenantsApi.setStatus(token, tenant.id, status);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cambiar el estado.');
    } finally {
      setBusy(null);
    }
  }

  async function handleAddDomain() {
    const host = newDomain.trim().toLowerCase();
    if (!host) return;
    const token = authStorage.getAccessToken();
    if (!token || !tenant) return;
    setBusy('add-domain');
    try {
      await adminTenantsApi.addDomain(token, tenant.id, host);
      setNewDomain('');
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos añadir el dominio.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveDomain(hostname: string) {
    if (!confirm(`¿Quitar el dominio ${hostname} del tenant?`)) return;
    const token = authStorage.getAccessToken();
    if (!token || !tenant) return;
    setBusy(`rm-${hostname}`);
    try {
      await adminTenantsApi.removeDomain(token, tenant.id, hostname);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos quitar el dominio.');
    } finally {
      setBusy(null);
    }
  }

  if (error && !tenant) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" asChild className="self-start">
          <Link href="/admin/tenants">← Volver al listado</Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-danger-700">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!tenant) {
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
        <Link href="/admin/tenants">← Volver al listado</Link>
      </Button>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{tenant.name}</h1>
          <p className="mt-1 font-mono text-sm text-text-muted">/{tenant.slug}</p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant={VARIANT[tenant.status]}>{STATUS_LABELS[tenant.status]}</Badge>
            <span className="text-xs text-text-subtle tabular-nums">
              creado{' '}
              {new Date(tenant.createdAt).toLocaleDateString('es-AR', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </div>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Acceso</CardTitle>
            <CardDescription>
              Suspender bloquea el login de todos los usuarios y cierra sus sesiones.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tenant.status !== 'ACTIVE' ? (
              <Button onClick={() => handleStatus('ACTIVE')} disabled={busy === 'status'}>
                Reactivar tenant
              </Button>
            ) : null}
            {tenant.status !== 'SUSPENDED' ? (
              <Button
                variant="destructive"
                onClick={() => handleStatus('SUSPENDED')}
                disabled={busy === 'status'}
              >
                Suspender
              </Button>
            ) : null}
            {tenant.status !== 'ARCHIVED' ? (
              <Button
                variant="ghost"
                onClick={() => handleStatus('ARCHIVED')}
                disabled={busy === 'status'}
              >
                Archivar
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estadísticas</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <p className="label-uppercase text-text-muted">Usuarios</p>
              <p className="font-display mt-1 text-3xl font-extrabold tabular-nums">
                {tenant.userCount}
              </p>
            </div>
            <div>
              <p className="label-uppercase text-text-muted">Cursos</p>
              <p className="font-display mt-1 text-3xl font-extrabold tabular-nums">
                {tenant.courseCount}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dominios</CardTitle>
          <CardDescription>
            Hosts donde este tenant resuelve. Cada signin/signup desde el host correspondiente
            identifica el tenant automáticamente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {tenant.domains.map((d) => (
              <li
                key={d.hostname}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{d.hostname}</span>
                  {d.isPrimary ? <Badge variant="primary">primary</Badge> : null}
                  {d.isVerified ? (
                    <Badge variant="success">verificado</Badge>
                  ) : (
                    <Badge variant="warning">pendiente</Badge>
                  )}
                </div>
                {!d.isPrimary ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveDomain(d.hostname)}
                    disabled={busy === `rm-${d.hostname}`}
                    className="text-xs font-semibold text-danger-700 hover:underline"
                  >
                    Quitar
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pt-2 border-t border-border">
            <Input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="otro-dominio.com"
              className="flex-1 font-mono"
            />
            <Button onClick={handleAddDomain} disabled={busy === 'add-domain' || !newDomain.trim()}>
              Añadir dominio
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
