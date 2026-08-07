'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  auditApi,
  entriesToCsv,
  type AuditEntry,
  type AuditFilters,
  type ChainVerifyResult,
} from '@/lib/audit';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate, formatDateTime, formatNumber, formatTime } from '@/lib/i18n/format';

export default function AuditoriaPage() {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [verifyResult, setVerifyResult] = useState<ChainVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditFilters>({});

  async function reload(applyFilters: AuditFilters) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      setEntries(await auditApi.list(token, applyFilters));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload({});
  }, []);

  async function handleVerify() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setVerifying(true);
    try {
      const result = await auditApi.verify(token);
      setVerifyResult(result);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setVerifying(false);
    }
  }

  function handleExport() {
    if (!entries || entries.length === 0) return;
    const csv = entriesToCsv(entries);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const grouped = useMemo(() => {
    if (!entries) return null;
    const map = new Map<string, AuditEntry[]>();
    for (const e of entries) {
      const date = formatDate(e.timestamp, {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
      const arr = map.get(date) ?? [];
      arr.push(e);
      map.set(date, arr);
    }
    return Array.from(map.entries());
  }, [entries]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('audit.title')}</h1>
          <p className="mt-1 text-text-muted">{t('audit.description')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={handleExport}
            disabled={!entries || entries.length === 0}
          >
            {t('audit.exportCsv')}
          </Button>
          <Button onClick={handleVerify} disabled={verifying}>
            {verifying ? t('audit.verifying') : t('audit.verify')}
          </Button>
        </div>
      </header>

      {verifyResult ? (
        <Card>
          <CardContent className="p-6">
            {verifyResult.valid ? (
              <div className="flex items-start gap-4">
                <div
                  aria-hidden="true"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
                  style={{
                    background: 'var(--didacta-success-bg)',
                    color: 'var(--didacta-success-fg)',
                  }}
                >
                  <Icon name="check" size={20} />
                </div>
                <div>
                  <h3 className="font-display text-lg font-semibold text-success-700">
                    {t('audit.chainValidTitle')}
                  </h3>
                  <p className="mt-1 text-sm text-text-muted">
                    {t('audit.chainValidDescription', {
                      count: formatNumber(verifyResult.totalEntries),
                    })}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-4">
                <div
                  aria-hidden="true"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
                  style={{
                    background: 'var(--didacta-err-bg)',
                    color: 'var(--didacta-err-fg)',
                  }}
                >
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <h3 className="font-display text-lg font-semibold text-danger-700">
                    {t('audit.chainBrokenTitle')}
                  </h3>
                  <p className="mt-1 text-sm text-text">
                    {t('audit.chainBrokenDescription', {
                      id: String(verifyResult.firstBrokenId),
                      fecha: verifyResult.brokenAt
                        ? formatDateTime(verifyResult.brokenAt)
                        : t('audit.dateUnknown'),
                    })}
                  </p>
                  <p className="mt-2 text-xs text-text-subtle">{t('audit.chainBrokenNote')}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="action">
              {t('audit.filterActionLabel')}
            </label>
            <Input
              id="action"
              placeholder={t('audit.filterActionPlaceholder')}
              value={filters.action ?? ''}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="resourceType">
              {t('audit.filterResourceLabel')}
            </label>
            <Input
              id="resourceType"
              placeholder={t('audit.filterResourcePlaceholder')}
              value={filters.resourceType ?? ''}
              onChange={(e) => setFilters({ ...filters, resourceType: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="dateFrom">
              {t('audit.filterFrom')}
            </label>
            <Input
              id="dateFrom"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="dateTo">
              {t('audit.filterTo')}
            </label>
            <Input
              id="dateTo"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
              className="mt-1"
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setFilters({});
                void reload({});
              }}
            >
              {t('audit.clear')}
            </Button>
            <Button onClick={() => void reload(filters)}>{t('audit.apply')}</Button>
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
      ) : entries === null ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-xl font-semibold">{t('audit.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('audit.emptyDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('audit.entriesCount', { count: formatNumber(entries.length) })}
            </CardTitle>
            <CardDescription>{t('audit.entriesDescription')}</CardDescription>
          </CardHeader>
          <div className="space-y-6 px-6 pb-6">
            {grouped?.map(([date, dayEntries]) => (
              <section key={date}>
                <h4 className="label-uppercase mb-2 text-text-muted">{date}</h4>
                <ul className="overflow-hidden rounded-lg border border-border">
                  {dayEntries.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-start gap-3 border-b border-border bg-surface p-3 text-sm last:border-0 hover:bg-surface-2"
                    >
                      <span className="tabular-nums text-text-subtle min-w-[5rem]">
                        {formatTime(e.timestamp, {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                      <Badge variant="outline" className="font-mono">
                        {e.action}
                      </Badge>
                      <span className="text-text-muted">
                        {e.resourceType} <span className="text-text-subtle">·</span>{' '}
                        <span className="font-mono text-xs">{e.resourceId.slice(0, 8)}…</span>
                      </span>
                      {e.actorId ? (
                        <span className="ml-auto text-xs text-text-subtle">
                          {t('audit.by')}{' '}
                          <span className="font-mono">{e.actorId.slice(0, 8)}…</span>
                        </span>
                      ) : null}
                      {e.ip ? (
                        <span className="text-xs text-text-subtle tabular-nums">{e.ip}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
