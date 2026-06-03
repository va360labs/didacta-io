'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminTenantsApi,
  STATUS_LABELS,
  type TenantCapacityInfo,
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
  const [capacity, setCapacity] = useState<TenantCapacityInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const [list, cap] = await Promise.all([
        adminTenantsApi.list(token),
        adminTenantsApi.capacity(token),
      ]);
      setItems(list);
      setCapacity(cap);
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
        {capacity?.canCreate ? (
          <Button asChild>
            <Link href="/admin/tenants/nuevo">Crear tenant</Link>
          </Button>
        ) : capacity ? (
          <Button
            disabled
            title="Tu plan community ya tiene un tenant. Activa Enterprise para añadir más."
          >
            <Icon name="lock" size={16} />
            Crear tenant
          </Button>
        ) : null}
      </header>

      {capacity ? <CapacityBanner capacity={capacity} /> : null}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : items === null ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-xl font-semibold">No hay tenants</h3>
            <p className="max-w-md text-text-muted">
              Crea el primero para empezar a darle acceso a una organización.
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

/**
 * Banner de capacidad multi-tenant. En CE muestra el cap (1 tenant) y un
 * upsell inline; en EE muestra el contador y "ilimitado".
 */
function CapacityBanner({ capacity }: { capacity: TenantCapacityInfo }) {
  if (capacity.capabilityActive) {
    return (
      <Card className="border-success-200 bg-success-50">
        <CardContent className="flex items-center gap-3 p-4 text-sm">
          <Icon name="shield" size={18} aria-hidden="true" />
          <div className="flex-1">
            <strong>Enterprise · multi-tenant activo.</strong> Tenants actuales:{' '}
            <span className="tabular-nums">{capacity.tenantCount}</span> · sin límite.
          </div>
        </CardContent>
      </Card>
    );
  }
  if (capacity.canCreate) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-text-muted">
          Plan community · usas <strong className="tabular-nums">{capacity.tenantCount}</strong> de{' '}
          <strong>{capacity.limit}</strong> tenants. Activa Enterprise para crear varias
          organizaciones aisladas en esta misma instancia.
        </CardContent>
      </Card>
    );
  }
  return <MultiTenantUpsellCard capacity={capacity} />;
}

/**
 * Tarjeta de upsell para community que ya tiene 1 tenant y quiere crear más.
 * Sigue el patrón de `CustomDomainsUpsellCard` y `WhiteLabelUpsellCard`.
 *
 * Recordatorio: el backend rechaza `POST /admin/tenants` con 402 cuando se
 * supera el cap sin licencia EE — esto es solo UX.
 */
export function MultiTenantUpsellCard({ capacity }: { capacity: TenantCapacityInfo }) {
  return (
    <Card role="region" aria-label="Multi-tenant real (Enterprise)" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Multi-tenant real — función Enterprise
        </CardTitle>
        <CardDescription>
          Tu plan community tiene <strong>{capacity.tenantCount}</strong> de{' '}
          <strong>{capacity.limit}</strong> tenants. Para alojar varias organizaciones aisladas en
          la misma instancia (datos, usuarios, cursos y dominios separados), activa Enterprise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            feat:multi_tenant.real
          </code>
          . Si tu licencia Enterprise expira o se revoca, los tenants existentes se conservan, pero
          NO se pueden crear nuevos hasta renovar.
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Ver planes Enterprise
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
