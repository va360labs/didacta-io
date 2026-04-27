'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

export default function TenantsPage() {
  const [items, setItems] = useState<TenantListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      setItems(await adminTenantsApi.list(token));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los tenants.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Tenants</h1>
          <p className="mt-1 text-text-muted">
            Organizaciones que usan Didacta. Solo super_admin puede crear nuevos tenants y asignar
            dominios custom.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/tenants/nuevo">Crear tenant</Link>
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : items === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-xl font-semibold">No hay tenants</h3>
            <p className="max-w-md text-text-muted">
              Creá el primero para empezar a darle acceso a una organización.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/admin/tenants/${t.id}` as never}
              className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <Card interactive>
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
                      style={{
                        background: 'var(--didacta-info-bg)',
                        color: 'var(--didacta-info-fg)',
                      }}
                    >
                      <Icon name="building" size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-lg leading-tight">{t.name}</CardTitle>
                      <CardDescription className="font-mono text-xs">/{t.slug}</CardDescription>
                    </div>
                    <Badge variant={VARIANT[t.status]}>{STATUS_LABELS[t.status]}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {t.domains.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {t.domains.map((d) => (
                        <Badge
                          key={d.hostname}
                          variant={d.isPrimary ? 'primary' : 'muted'}
                          className="font-mono text-[10px]"
                        >
                          {d.hostname}
                          {d.isPrimary ? ' · primary' : ''}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex gap-5 text-xs text-text-muted tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="users" size={14} />
                      {t.userCount} {t.userCount === 1 ? 'usuario' : 'usuarios'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="book" size={14} />
                      {t.courseCount} {t.courseCount === 1 ? 'curso' : 'cursos'}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
