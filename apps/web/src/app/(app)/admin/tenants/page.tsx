'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminTenantsApi,
  type TenantCapacityInfo,
  type TenantListItem,
  type TenantStatus,
} from '@/lib/admin-tenants';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';

const VARIANT: Record<TenantStatus, 'success' | 'danger' | 'muted'> = {
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  ARCHIVED: 'muted',
};

export default function TenantsPage() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
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
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tenants.loadError'));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('tenants.title')}</h1>
          <p className="mt-1 text-text-muted">{t('tenants.description')}</p>
        </div>
        {capacity?.canCreate ? (
          <Button asChild>
            <Link href="/admin/tenants/nuevo">{t('tenants.createButton')}</Link>
          </Button>
        ) : capacity ? (
          <Button disabled title={t('tenants.createLockedTitle')}>
            <Icon name="lock" size={16} />
            {t('tenants.createButton')}
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
            <h3 className="font-display text-xl font-semibold">{t('tenants.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('tenants.emptyDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((tn) => (
            <Link
              key={tn.id}
              href={`/admin/tenants/${tn.id}` as never}
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
                      <CardTitle className="text-lg leading-tight">{tn.name}</CardTitle>
                      <CardDescription className="font-mono text-xs">/{tn.slug}</CardDescription>
                    </div>
                    <Badge variant={VARIANT[tn.status]}>{t(`tenantStatus.${tn.status}`)}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {tn.domains.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {tn.domains.map((d) => (
                        <Badge
                          key={d.hostname}
                          variant={d.isPrimary ? 'primary' : 'muted'}
                          className="font-mono text-[10px]"
                        >
                          {d.hostname}
                          {d.isPrimary ? ` · ${t('tenants.primaryBadge')}` : ''}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex gap-5 text-xs text-text-muted tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="users" size={14} />
                      {tn.userCount} {t('tenants.usersCount', { count: tn.userCount })}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="book" size={14} />
                      {tn.courseCount} {t('tenants.coursesCount', { count: tn.courseCount })}
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
  const t = useTranslations('adminMarca');
  if (capacity.capabilityActive) {
    return (
      <Card className="border-success-200 bg-success-50">
        <CardContent className="flex items-center gap-3 p-4 text-sm">
          <Icon name="shield" size={18} aria-hidden="true" />
          <div className="flex-1">
            {t.rich('tenants.capacityEe', {
              count: String(capacity.tenantCount),
              strong: (chunks) => <strong>{chunks}</strong>,
              nums: (chunks) => <span className="tabular-nums">{chunks}</span>,
            })}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (capacity.canCreate) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-text-muted">
          {t.rich('tenants.capacityCe', {
            count: String(capacity.tenantCount),
            limit: String(capacity.limit),
            strong: (chunks) => <strong>{chunks}</strong>,
            nums: (chunks) => <strong className="tabular-nums">{chunks}</strong>,
          })}
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
  const t = useTranslations('adminMarca');
  return (
    <Card role="region" aria-label={t('tenants.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('tenants.upsellTitle')}
        </CardTitle>
        <CardDescription>
          {t.rich('tenants.upsellDescription', {
            count: String(capacity.tenantCount),
            limit: String(capacity.limit),
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('tenants.upsellBody', {
            code: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
            ),
          })}
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('tenants.upsellCta')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
