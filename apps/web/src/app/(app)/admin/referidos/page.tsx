'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Administración del programa de referidos (mod.referrals).
///
/// - Config del programa: comisión, ámbito, ventanas, mínimo, copy. Los
///   cambios NO recalculan comisiones ya devengadas (bps sellados por fila).
/// - Referidores: ranking con métricas reales y liquidación manual del saldo
///   aprobado (referencia externa obligatoria — v1 sin Stripe Connect).
/// - Comisiones: listado con filtros y acciones aprobar / revocar (motivo).

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents, formatDate } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import {
  referralsAdminApi,
  type AdminCommissionRow,
  type AdminReferrerRow,
  type ReferralCommissionStatus,
  type ReferralsConfig,
} from '@/lib/referrals';

const STATUS_VARIANT: Record<string, 'warning' | 'info' | 'success' | 'danger'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  REVOKED: 'danger',
};

interface ConfigForm {
  active: boolean;
  commissionPercent: string;
  scope: 'FIRST_PAYMENT' | 'RECURRING';
  recurringMonths: string;
  attributionWindowDays: string;
  guaranteeDays: string;
  minPayoutEur: string;
  requireActiveMembership: boolean;
  memberCopy: string;
}

function toForm(config: ReferralsConfig): ConfigForm {
  return {
    active: config.active,
    commissionPercent: (config.commissionBps / 100).toString(),
    scope: config.scope,
    recurringMonths: config.recurringMonths === null ? '' : String(config.recurringMonths),
    attributionWindowDays: String(config.attributionWindowDays),
    guaranteeDays: String(config.guaranteeDays),
    minPayoutEur: (config.minPayoutCents / 100).toString(),
    requireActiveMembership: config.requireActiveMembership,
    memberCopy: config.memberCopy ?? '',
  };
}

function dateLabel(iso: string): string {
  return formatDate(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Céntimos → "2,97 €" / "19 €" en el locale activo.
 *
 * Usa el `formatCents` canónico, que quita el céntimo cero en las cantidades
 * redondas. Es la misma regla que ya ven `/referidos` (la pantalla del
 * prescriptor, que lee estas MISMAS comisiones), `/unete` y `/catalogo`: las
 * dos caras del programa de referidos tienen que escribir el importe igual.
 */
function amountLabel(cents: number, currency = 'eur'): string {
  return formatCents(cents, currency.toUpperCase());
}

export default function AdminReferidosPage() {
  const t = useTranslations('adminMonetizacion.referrals');
  const tStatus = useTranslations('adminMonetizacion.commissionStatus');
  const tErrors = useTranslations('errors');
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [referrers, setReferrers] = useState<AdminReferrerRow[]>([]);
  const [commissions, setCommissions] = useState<AdminCommissionRow[]>([]);
  const [totals, setTotals] = useState<
    Array<{ status: ReferralCommissionStatus; totalCents: number; count: number }>
  >([]);
  const [statusFilter, setStatusFilter] = useState<'' | ReferralCommissionStatus>('');
  const [minPayoutCents, setMinPayoutCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (filter: '' | ReferralCommissionStatus = '') => {
    const [config, refs, comms] = await Promise.all([
      referralsAdminApi.getConfig(),
      referralsAdminApi.listReferrers(),
      referralsAdminApi.listCommissions(filter ? { status: filter } : {}),
    ]);
    setForm(toForm(config));
    setMinPayoutCents(config.minPayoutCents);
    setReferrers(refs);
    setCommissions(comms.commissions);
    setTotals(comms.totalsByStatus);
  }, []);

  useEffect(() => {
    reload().catch((e) => {
      setError(apiErrorMessage(e, tErrors));
    });
  }, [reload, tErrors]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await reload(statusFilter);
      setNotice(label);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!form) return;
    const percent = Number(form.commissionPercent.replace(',', '.'));
    const minPayout = Number(form.minPayoutEur.replace(',', '.'));
    await run(t('configSaved'), async () => {
      await referralsAdminApi.updateConfig({
        active: form.active,
        commissionBps: Math.round(percent * 100),
        scope: form.scope,
        recurringMonths: form.recurringMonths.trim() === '' ? null : Number(form.recurringMonths),
        attributionWindowDays: Number(form.attributionWindowDays),
        guaranteeDays: Number(form.guaranteeDays),
        minPayoutCents: Math.round(minPayout * 100),
        requireActiveMembership: form.requireActiveMembership,
        memberCopy: form.memberCopy.trim() === '' ? null : form.memberCopy.trim(),
      });
    });
  }

  async function liquidate(referrer: AdminReferrerRow) {
    const reference = window.prompt(
      t('liquidatePrompt', {
        amount: amountLabel(referrer.approvedCents),
        code: referrer.code,
      }),
    );
    if (!reference || reference.trim().length < 3) return;
    await run(t('payoutRecorded'), async () => {
      const approved = await referralsAdminApi.listCommissions({
        status: 'APPROVED',
        referrerUserId: referrer.referrerUserId,
      });
      await referralsAdminApi.recordPayout({
        referrerUserId: referrer.referrerUserId,
        commissionIds: approved.commissions.map((c) => c.id),
        externalReference: reference.trim(),
      });
    });
  }

  async function revoke(commission: AdminCommissionRow) {
    const reason = window.prompt(
      t('revokePrompt', {
        amount: amountLabel(commission.amountCents, commission.currency),
      }),
    );
    if (!reason || reason.trim().length < 3) return;
    await run(t('commissionRevoked'), () =>
      referralsAdminApi.revokeCommission(commission.id, reason.trim()),
    );
  }

  if (!form) {
    return (
      <div className="mx-auto max-w-4xl space-y-2">
        <div className="skeleton h-40 w-full" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">{t('title')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('intro')}</p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700"
        >
          {notice}
        </div>
      ) : null}

      <Card data-testid="referrals-config-card">
        <CardHeader>
          <CardTitle>{t('configTitle')}</CardTitle>
          <CardDescription>{t('configDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-3">
              <Switch
                id="ref-active"
                checked={form.active}
                onCheckedChange={(v) => setForm({ ...form, active: v })}
              />
              <Label htmlFor="ref-active">{t('activeLabel')}</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="ref-require"
                checked={form.requireActiveMembership}
                onCheckedChange={(v) => setForm({ ...form, requireActiveMembership: v })}
              />
              <Label htmlFor="ref-require">{t('requireMembershipLabel')}</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-percent">{t('commissionLabel')}</Label>
              <Input
                id="ref-percent"
                inputMode="decimal"
                value={form.commissionPercent}
                onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-scope">{t('scopeLabel')}</Label>
              <Select
                id="ref-scope"
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as ConfigForm['scope'] })}
              >
                <option value="RECURRING">{t('scopeRecurring')}</option>
                <option value="FIRST_PAYMENT">{t('scopeFirstPayment')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-months">{t('recurringMonthsLabel')}</Label>
              <Input
                id="ref-months"
                inputMode="numeric"
                value={form.recurringMonths}
                onChange={(e) => setForm({ ...form, recurringMonths: e.target.value })}
                disabled={form.scope !== 'RECURRING'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-window">{t('attributionWindowLabel')}</Label>
              <Input
                id="ref-window"
                inputMode="numeric"
                value={form.attributionWindowDays}
                onChange={(e) => setForm({ ...form, attributionWindowDays: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-guarantee">{t('guaranteeDaysLabel')}</Label>
              <Input
                id="ref-guarantee"
                inputMode="numeric"
                value={form.guaranteeDays}
                onChange={(e) => setForm({ ...form, guaranteeDays: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-min">{t('minPayoutLabel')}</Label>
              <Input
                id="ref-min"
                inputMode="decimal"
                value={form.minPayoutEur}
                onChange={(e) => setForm({ ...form, minPayoutEur: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ref-copy">{t('memberCopyLabel')}</Label>
              <textarea
                id="ref-copy"
                rows={3}
                value={form.memberCopy}
                onChange={(e) => setForm({ ...form, memberCopy: e.target.value })}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder={t('memberCopyPlaceholder')}
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end border-t border-border-soft pt-3">
            <Button type="button" onClick={() => void saveConfig()} disabled={busy}>
              {busy ? t('saving') : t('saveConfig')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="referrals-referrers-card">
        <CardHeader>
          <CardTitle>{t('referrersTitle')}</CardTitle>
          <CardDescription>{t('referrersDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {referrers.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('referrersEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-soft text-left text-xs text-text-subtle">
                    <th className="py-2 pr-3">{t('colCode')}</th>
                    <th className="py-2 pr-3">{t('colClicks')}</th>
                    <th className="py-2 pr-3">{t('colSignups')}</th>
                    <th className="py-2 pr-3">{t('colPending')}</th>
                    <th className="py-2 pr-3">{t('colApproved')}</th>
                    <th className="py-2 pr-3">{t('colPaid')}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {referrers.map((r) => (
                    <tr key={r.referrerUserId} className="border-b border-border-soft">
                      <td className="py-2 pr-3 font-mono">{r.code}</td>
                      <td className="py-2 pr-3">{r.clicks}</td>
                      <td className="py-2 pr-3">{r.referrals}</td>
                      <td className="py-2 pr-3">{amountLabel(r.pendingCents)}</td>
                      <td className="py-2 pr-3 font-semibold">{amountLabel(r.approvedCents)}</td>
                      <td className="py-2 pr-3">{amountLabel(r.paidCents)}</td>
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            busy ||
                            r.approvedCents === 0 ||
                            (minPayoutCents > 0 && r.approvedCents < minPayoutCents)
                          }
                          onClick={() => void liquidate(r)}
                          title={
                            minPayoutCents > 0 && r.approvedCents < minPayoutCents
                              ? t('belowMinimum', { amount: amountLabel(minPayoutCents) })
                              : undefined
                          }
                        >
                          {t('liquidate')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="referrals-commissions-card">
        <CardHeader>
          <CardTitle>{t('commissionsTitle')}</CardTitle>
          <CardDescription>
            {totals.length === 0
              ? t('commissionsEmptyTotals')
              : totals
                  .map((row) =>
                    t('totalsItem', {
                      status: labelOr(tStatus, row.status, row.status),
                      count: row.count,
                      amount: amountLabel(row.totalCents),
                    }),
                  )
                  .join(' · ')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 max-w-xs">
            <Label htmlFor="ref-filter">{t('filterLabel')}</Label>
            <Select
              id="ref-filter"
              value={statusFilter}
              onChange={(e) => {
                const next = e.target.value as '' | ReferralCommissionStatus;
                setStatusFilter(next);
                void reload(next).catch((err) => setError(apiErrorMessage(err, tErrors)));
              }}
            >
              <option value="">{t('filterAll')}</option>
              <option value="PENDING">{t('filterPending')}</option>
              <option value="APPROVED">{t('filterApproved')}</option>
              <option value="PAID">{t('filterPaid')}</option>
              <option value="REVOKED">{t('filterRevoked')}</option>
            </Select>
          </div>
          {commissions.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('commissionsEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {commissions.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="text-text-subtle">{dateLabel(c.createdAt)}</span>
                  <span className="font-semibold text-text">
                    {amountLabel(c.amountCents, c.currency)}
                  </span>
                  <span className="text-xs text-text-subtle">
                    {t('commissionBase', {
                      amount: amountLabel(c.baseAmountCents, c.currency),
                      percent: (c.commissionBps / 100).toFixed(0),
                    })}
                  </span>
                  <Badge variant={STATUS_VARIANT[c.status] ?? 'muted'}>
                    {labelOr(tStatus, c.status, c.status)}
                  </Badge>
                  {c.status === 'REVOKED' && c.revokeReason ? (
                    <span className="text-xs text-danger-700">{c.revokeReason}</span>
                  ) : null}
                  <span className="ml-auto flex gap-2">
                    {c.status === 'PENDING' ? (
                      <>
                        <button
                          type="button"
                          className="text-xs text-brand-700 hover:underline"
                          disabled={busy}
                          onClick={() =>
                            void run(t('commissionApproved'), () =>
                              referralsAdminApi.approveCommission(c.id),
                            )
                          }
                        >
                          {t('approveNow')}
                        </button>
                        <button
                          type="button"
                          className="text-xs text-danger-700 hover:underline"
                          disabled={busy}
                          onClick={() => void revoke(c)}
                        >
                          {t('revoke')}
                        </button>
                      </>
                    ) : c.status === 'APPROVED' ? (
                      <button
                        type="button"
                        className="text-xs text-danger-700 hover:underline"
                        disabled={busy}
                        onClick={() => void revoke(c)}
                      >
                        {t('revoke')}
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
