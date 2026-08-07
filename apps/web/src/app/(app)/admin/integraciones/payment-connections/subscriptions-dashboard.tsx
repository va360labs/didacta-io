'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Dashboard de control de suscripciones (mod.payment-connections).
 *
 * Vista única de TODAS las suscripciones de TODAS las cuentas conectadas
 * (Stripe + WooCommerce + PayPal), leída de la tabla materializada por el sync
 * (no en vivo). Muestra estado normalizado (vigente / impago / baja), filtros y
 * contadores, y permite "Sincronizar ahora" (on-demand). Solo super_admin.
 *
 * Todo el dato viene en vivo de la API (BD real). Cero datos de cartón.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/i18n/format';
import {
  subscriptionsDashboardApi,
  type DashboardSubscriber,
  type SubscribersSummary,
} from '@/lib/payment-connections';
import { RenewalEmailModal } from '@/components/renewal-email-modal';

/** Estados de impago en los que tiene sentido enviar un recordatorio de renovación. */
function isImpago(category: string): boolean {
  return category === 'past_due' || category === 'unpaid';
}

const PAGE_SIZE = 50;

type SubCategoryKey =
  | 'all'
  | 'active'
  | 'pastDue'
  | 'unpaid'
  | 'canceled'
  | 'paused'
  | 'incomplete'
  | 'unknown';

/** Categorías mostrables en el filtro (orden + key de etiqueta en el catálogo). */
const CATEGORY_FILTERS: Array<{ value: string; key: SubCategoryKey }> = [
  { value: '', key: 'all' },
  { value: 'active', key: 'active' },
  { value: 'past_due', key: 'pastDue' },
  { value: 'unpaid', key: 'unpaid' },
  { value: 'canceled', key: 'canceled' },
  { value: 'paused', key: 'paused' },
  { value: 'incomplete', key: 'incomplete' },
  { value: 'unknown', key: 'unknown' },
];

const CATEGORY_BADGE: Record<string, string> = {
  active: 'border-success/30 bg-success/10 text-success-700',
  past_due: 'border-warning/40 bg-warning/10 text-warning-700',
  unpaid: 'border-danger/30 bg-danger/10 text-danger',
  canceled: 'border-border bg-surface-2 text-text-muted',
  paused: 'border-warning/30 bg-warning/5 text-warning-700',
  incomplete: 'border-border bg-surface-2 text-text-muted',
  unknown: 'border-border bg-surface-2 text-text-muted',
};

type SubStatusKey =
  | 'active'
  | 'trialing'
  | 'pastDue'
  | 'unpaid'
  | 'onHold'
  | 'paused'
  | 'pendingCancel'
  | 'canceled'
  | 'expired'
  | 'incomplete'
  | 'pending';

/**
 * Status crudo del proveedor (normalizado a minúsculas) → key de etiqueta en el
 * catálogo. Espejo del diccionario de `classifySubscriptionStatus` de
 * `lib/payment-connections.ts` (aquí solo la PRESENTACIÓN; la categoría ya
 * viene materializada en `statusCategory` desde el backend).
 */
const SUB_STATUS_KEYS: Record<string, SubStatusKey> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'pastDue',
  unpaid: 'unpaid',
  'on-hold': 'onHold',
  paused: 'paused',
  'pending-cancel': 'pendingCancel',
  canceled: 'canceled',
  cancelled: 'canceled',
  expired: 'expired',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete',
  pending: 'pending',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : formatDate(d);
}

/** Importe en céntimos + moneda → moneda formateada según el locale activo. */
function fmtAmount(unitAmount: number, currency: string | null): string {
  const cur = (currency ?? 'eur').toUpperCase();
  try {
    return formatCurrency(unitAmount / 100, cur);
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${cur}`;
  }
}

export function SubscriptionsDashboard() {
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
  const [summary, setSummary] = useState<SubscribersSummary | null>(null);
  const [rows, setRows] = useState<DashboardSubscriber[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [provider, setProvider] = useState('');
  const [statusCategory, setStatusCategory] = useState('');
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<DashboardSubscriber | null>(null);

  const statusLabel = (status: string): string => {
    const key = SUB_STATUS_KEYS[(status ?? '').toLowerCase().trim()];
    return key ? t(`subStatus.${key}`) : status || t('subStatus.unknown');
  };

  const load = useCallback(async () => {
    const tk = authStorage.getAccessToken();
    if (!tk) return;
    try {
      setError(null);
      const [sum, list] = await Promise.all([
        subscriptionsDashboardApi.summary(tk),
        subscriptionsDashboardApi.list(tk, {
          provider: provider || undefined,
          statusCategory: statusCategory || undefined,
          onlyUnmatched: onlyUnmatched || undefined,
          q: q.trim() || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      ]);
      setSummary(sum);
      setRows(list.rows);
      setTotal(list.total);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dashboard.loadError'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, statusCategory, onlyUnmatched, q, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    const tk = authStorage.getAccessToken();
    if (!tk) return;
    setSyncing(true);
    setNotice(null);
    try {
      setError(null);
      const r = await subscriptionsDashboardApi.sync(tk);
      setNotice(
        r.failures.length
          ? t('dashboard.syncInfoWithFailures', {
              connections: r.connections,
              upserted: r.upserted,
              markedGone: r.markedGone,
              failures: r.failures.length,
            })
          : t('dashboard.syncInfo', {
              connections: r.connections,
              upserted: r.upserted,
              markedGone: r.markedGone,
            }),
      );
      setPage(0);
      await load();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dashboard.syncError'));
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t('dashboard.title')}</CardTitle>
            <p className="mt-1 text-sm text-text-muted">
              {t('dashboard.subtitle')}{' '}
              {summary?.lastSyncedAt
                ? summary.lastSyncStatus && summary.lastSyncStatus !== 'success'
                  ? t('dashboard.lastSyncWithStatus', {
                      date: formatDateTime(summary.lastSyncedAt),
                      status: summary.lastSyncStatus,
                    })
                  : t('dashboard.lastSync', { date: formatDateTime(summary.lastSyncedAt) })
                : t('dashboard.neverSynced')}
            </p>
          </div>
          <Button onClick={() => void sync()} disabled={syncing}>
            {syncing ? t('dashboard.syncingCta') : t('dashboard.syncNowCta')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-brand-500/30 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {notice}
          </div>
        )}

        {/* Contadores por estado */}
        {summary && (
          <div className="flex flex-wrap gap-2">
            <Badge className="border-border bg-surface-2 text-text">
              {t('dashboard.totalBadge', { count: summary.total })}
            </Badge>
            {CATEGORY_FILTERS.filter((c) => c.value && summary.byCategory[c.value]).map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => {
                  setStatusCategory(statusCategory === c.value ? '' : c.value);
                  setPage(0);
                }}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                  CATEGORY_BADGE[c.value] ?? 'border-border bg-surface-2 text-text-muted'
                } ${statusCategory === c.value ? 'ring-2 ring-brand-500/40' : ''}`}
              >
                {t(`subCategory.${c.key}`)} {summary.byCategory[c.value]}
              </button>
            ))}
          </div>
        )}

        {/* Filtros */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-44 flex-1">
            <Label htmlFor="sub-q">{t('dashboard.searchLabel')}</Label>
            <Input
              id="sub-q"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder={t('dashboard.searchPh')}
            />
          </div>
          <div className="w-44">
            <Label htmlFor="sub-provider">{t('dashboard.providerLabel')}</Label>
            <Select
              id="sub-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setPage(0);
              }}
            >
              <option value="">{t('dashboard.providerAll')}</option>
              <option value="stripe">Stripe</option>
              <option value="woocommerce">WooCommerce</option>
              <option value="paypal">PayPal</option>
            </Select>
          </div>
          <div className="w-52">
            <Label htmlFor="sub-status">{t('dashboard.statusLabel')}</Label>
            <Select
              id="sub-status"
              value={statusCategory}
              onChange={(e) => {
                setStatusCategory(e.target.value);
                setPage(0);
              }}
            >
              {CATEGORY_FILTERS.map((c) => (
                <option key={c.value || 'all'} value={c.value}>
                  {t(`subCategory.${c.key}`)}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-text">
            <input
              type="checkbox"
              checked={onlyUnmatched}
              onChange={(e) => {
                setOnlyUnmatched(e.target.checked);
                setPage(0);
              }}
            />
            {t('dashboard.onlyUnmatched')}
          </label>
        </div>

        {/* Tabla */}
        {rows === null ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-text-muted">
            {summary && summary.total === 0
              ? t('dashboard.emptyNoData')
              : t('dashboard.emptyFiltered')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colSubscriber')}</th>
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colProvider')}</th>
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colPlan')}</th>
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colStatus')}</th>
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colAmount')}</th>
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colRenewal')}</th>
                  <th className="py-2 pr-3 font-medium">{t('dashboard.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/60">
                    <td className="py-2 pr-3">
                      <div className="text-text">{r.userEmail || '—'}</div>
                      {r.userId === null && (
                        <span className="text-xs text-text-muted">
                          {t('dashboard.notInDidacta')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 capitalize">{r.provider}</td>
                    <td className="py-2 pr-3">{r.productName ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                          CATEGORY_BADGE[r.statusCategory] ?? CATEGORY_BADGE['unknown']
                        }`}
                      >
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {r.unitAmount !== null ? fmtAmount(r.unitAmount, r.currency) : '—'}
                      {r.interval ? <span className="text-text-muted">/{r.interval}</span> : ''}
                    </td>
                    <td className="py-2 pr-3 text-text-muted">{fmtDate(r.currentPeriodEnd)}</td>
                    <td className="py-2 pr-3">
                      {isImpago(r.statusCategory) ? (
                        <Button variant="ghost" onClick={() => setEmailFor(r)}>
                          {t('dashboard.reminderCta')}
                        </Button>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Paginación */}
        {rows !== null && total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>{t('dashboard.pagination', { total, page: page + 1, pages: totalPages })}</span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t('dashboard.prevCta')}
              </Button>
              <Button
                variant="ghost"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('dashboard.nextCta')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {emailFor && (
        <RenewalEmailModal
          to={emailFor.userEmail}
          productName={emailFor.productName}
          unitAmount={emailFor.unitAmount}
          currency={emailFor.currency}
          loadContext={async () => {
            const tk = authStorage.getAccessToken();
            if (!tk) throw new Error(t('dashboard.noActiveSession'));
            const [template, ru] = await Promise.all([
              subscriptionsDashboardApi.getTemplate(tk),
              subscriptionsDashboardApi.renewalUrl(tk, emailFor.id).catch(() => ({ url: null })),
            ]);
            return { template, renewalUrl: ru.url };
          }}
          send={async (payload) => {
            const tk = authStorage.getAccessToken();
            if (!tk) throw new Error(t('dashboard.noActiveSession'));
            return subscriptionsDashboardApi.sendRenewalEmail(tk, emailFor.id, payload);
          }}
          onClose={() => setEmailFor(null)}
          onSent={(msg) => {
            setEmailFor(null);
            setNotice(msg);
          }}
        />
      )}
    </Card>
  );
}
