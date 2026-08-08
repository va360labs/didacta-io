'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiHttpError } from '@/lib/api-client';
import { adminTenantsApi, type TenantListItem, type TenantStatus } from '@/lib/admin-tenants';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';

const VARIANT: Record<TenantStatus, 'success' | 'danger' | 'muted'> = {
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  ARCHIVED: 'muted',
};

export default function TenantDetailPage() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
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
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tenantDetail.loadError'),
      );
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  async function handleStatus(status: TenantStatus) {
    if (
      status !== 'ACTIVE' &&
      !confirm(t('tenantDetail.statusConfirm', { status: t(`tenantStatus.${status}`) }))
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
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tenantDetail.statusError'),
      );
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
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tenantDetail.addDomainError'),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveDomain(hostname: string) {
    if (!confirm(t('tenantDetail.removeDomainConfirm', { hostname }))) return;
    const token = authStorage.getAccessToken();
    if (!token || !tenant) return;
    setBusy(`rm-${hostname}`);
    try {
      await adminTenantsApi.removeDomain(token, tenant.id, hostname);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? apiErrorMessage(e, tErrors)
          : t('tenantDetail.removeDomainError'),
      );
    } finally {
      setBusy(null);
    }
  }

  if (error && !tenant) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" asChild className="self-start">
          <Link href="/admin/tenants">{t('tenantDetail.backLink')}</Link>
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
        <Link href="/admin/tenants">{t('tenantDetail.backLink')}</Link>
      </Button>

      {/* === Hero === */}
      <Card>
        <CardContent className="flex flex-wrap items-start gap-4 p-5">
          <span
            aria-hidden="true"
            className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="building" size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-bold tracking-tight">{tenant.name}</h1>
            <p className="mt-0.5 font-mono text-sm text-text-muted">/{tenant.slug}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant={VARIANT[tenant.status]} dot>
                {t(`tenantStatus.${tenant.status}`)}
              </Badge>
              <span className="text-xs tabular-nums text-text-subtle">
                {t('tenantDetail.createdAt', {
                  date: formatDate(tenant.createdAt, {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  }),
                })}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-5 text-text">
            <div className="text-center">
              <p className="font-display text-3xl font-bold tabular-nums">{tenant.userCount}</p>
              <p className="label-uppercase text-text-muted">
                {t('tenantDetail.usersCount', { count: tenant.userCount })}
              </p>
            </div>
            <div className="text-center">
              <p className="font-display text-3xl font-bold tabular-nums">{tenant.courseCount}</p>
              <p className="label-uppercase text-text-muted">
                {t('tenantDetail.coursesCount', { count: tenant.courseCount })}
              </p>
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
              <CardTitle className="text-base">{t('tenantDetail.accessTitle')}</CardTitle>
              <CardDescription>{t('tenantDetail.accessDescription')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2.5">
          {tenant.status !== 'ACTIVE' ? (
            <Button onClick={() => handleStatus('ACTIVE')} disabled={busy === 'status'}>
              <Icon name="check" size={16} />
              {t('tenantDetail.reactivate')}
            </Button>
          ) : null}
          {tenant.status !== 'SUSPENDED' ? (
            <Button
              variant="destructive"
              onClick={() => handleStatus('SUSPENDED')}
              disabled={busy === 'status'}
            >
              <Icon name="lock" size={16} />
              {t('tenantDetail.suspend')}
            </Button>
          ) : null}
          {tenant.status !== 'ARCHIVED' ? (
            <Button
              variant="ghost"
              onClick={() => handleStatus('ARCHIVED')}
              disabled={busy === 'status'}
            >
              {t('tenantDetail.archive')}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* === Dominios === */}
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
              <Icon name="route" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">{t('tenantDetail.domainsTitle')}</CardTitle>
              <CardDescription>{t('tenantDetail.domainsDescription')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
            {tenant.domains.map((d) => (
              <li
                key={d.hostname}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-sm font-semibold text-text">{d.hostname}</code>
                  {d.isPrimary ? (
                    <Badge variant="primary">{t('tenantDetail.primaryBadge')}</Badge>
                  ) : null}
                  {d.isVerified ? (
                    <Badge variant="success" dot>
                      {t('tenantDetail.verifiedBadge')}
                    </Badge>
                  ) : (
                    <Badge variant="warning" dot>
                      {t('tenantDetail.pendingBadge')}
                    </Badge>
                  )}
                </div>
                {!d.isPrimary ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveDomain(d.hostname)}
                    disabled={busy === `rm-${d.hostname}`}
                    aria-label={t('tenantDetail.removeDomainLabel', { hostname: d.hostname })}
                    title={t('tenantDetail.removeDomainLabel', { hostname: d.hostname })}
                    className="rounded p-1.5 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
                  >
                    <Icon name="trash" size={16} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
            <Input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder={t('tenantDetail.newDomainPlaceholder')}
              className="min-w-[220px] flex-1 font-mono"
              aria-label={t('tenantDetail.newDomainLabel')}
            />
            <Button onClick={handleAddDomain} disabled={busy === 'add-domain' || !newDomain.trim()}>
              <Icon name="plus" size={14} />
              {t('tenantDetail.addDomainButton')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
