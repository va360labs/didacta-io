'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Tus facturas» (Administración → Cobros, solo en modo plataforma).
 *
 * Cada mes, la factura de nuestra comisión con el IVA desglosado, y las
 * rectificativas (devoluciones de comisión por reembolsos de meses
 * anteriores, o la que sustituye a una que salió sin tus datos fiscales). Se
 * descarga el PDF tal como se emitió. Los importes los da la API; aquí no se
 * calcula ninguno.
 *
 * Al super_admin se le añade el botón para emitir un mes a mano.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import {
  formatStripeAmount,
  payoutsApi,
  type PayoutsInvoiceDto,
  type PayoutsInvoicesDto,
} from '@/lib/payouts';

export interface PayoutsInvoicesSectionProps {
  api?: Pick<typeof payoutsApi, 'invoices' | 'invoicePdf' | 'runInvoices'>;
  /** Para recargar desde fuera (al guardar los datos fiscales). */
  refreshKey?: number;
}

/** Mes anterior en `AAAA-MM` (el que se factura). Puro. */
export function previousMonth(now: Date): string {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11: el mes actual; el anterior es m (1-12) salvo enero
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

export function PayoutsInvoicesSection({
  api = payoutsApi,
  refreshKey = 0,
}: PayoutsInvoicesSectionProps): React.JSX.Element | null {
  const t = useTranslations('adminPagos.payouts.invoices');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [data, setData] = useState<PayoutsInvoicesDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [month, setMonth] = useState(() => previousMonth(new Date()));
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const isSuperAdmin = useMemo(
    () => authStorage.getSession()?.user.roles.includes('super_admin') ?? false,
    [],
  );

  const load = useCallback(async () => {
    try {
      setData(await api.invoices());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('loadError'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (data === null) return null;
  if (data && !data.enabled && !isSuperAdmin) return null;

  const money = (amount: number, currency: string) => formatStripeAmount(amount, currency, locale);
  const day = (iso: string) =>
    formatDate(`${iso}T12:00:00Z`, {
      locale,
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

  async function download(invoice: PayoutsInvoiceDto) {
    setDownloading(invoice.id);
    try {
      const blob = await api.invoicePdf(invoice.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.fullNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError(t('downloadError'));
    } finally {
      setDownloading(null);
    }
  }

  async function run() {
    setRunning(true);
    setRunResult(null);
    try {
      const result = await api.runInvoices(month);
      setRunResult(
        t('runDone', {
          month: result.month,
          issued: result.issued,
          sent: result.emails.sent,
          errors: result.errors,
        }),
      );
      await load();
    } catch (err) {
      setRunResult(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('runError'));
    } finally {
      setRunning(false);
    }
  }

  const items = data?.items ?? [];

  return (
    <section
      className="space-y-4"
      aria-labelledby="payouts-invoices-title"
      data-testid="payouts-invoices"
    >
      <header className="space-y-1">
        <h2 id="payouts-invoices-title" className="font-display text-xl font-bold tracking-tight">
          {t('title')}
        </h2>
        <p className="max-w-2xl text-sm text-text-muted">{t('intro')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {data && !data.enabled ? (
        <p className="rounded-lg border border-border-soft bg-surface-2 p-3.5 text-sm text-text-muted">
          {t('disabled')}
        </p>
      ) : null}

      {data?.enabled && items.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-text-muted">{t('empty')}</p>
          </CardContent>
        </Card>
      ) : null}

      {items.length > 0 ? (
        <Card>
          <CardContent className="pt-2 md:pt-4">
            <ul className="divide-y divide-border-soft" data-testid="payouts-invoices-list">
              {items.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between"
                  data-invoice={invoice.fullNumber}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold tabular-nums text-text">
                        {invoice.fullNumber}
                      </span>
                      {invoice.kind === 'RECTIFYING' ? (
                        <Badge variant="info">{t('rectifying')}</Badge>
                      ) : null}
                      {invoice.replacedBy ? (
                        <Badge variant="muted">
                          {t('replaced', { number: invoice.replacedBy })}
                        </Badge>
                      ) : null}
                      {!invoice.recipientComplete && !invoice.replacedBy ? (
                        <Badge variant="warning">{t('pendingData')}</Badge>
                      ) : null}
                      {!invoice.livemode ? <Badge variant="muted">{t('testMode')}</Badge> : null}
                    </div>
                    <p className="text-sm text-text-muted">
                      {t('line', {
                        date: day(invoice.issueDate),
                        from: day(invoice.periodStart),
                        to: day(invoice.periodEnd),
                      })}
                    </p>
                    {invoice.rectifies.length > 0 ? (
                      <p className="text-xs text-text-subtle">
                        {t('rectifies', {
                          numbers: invoice.rectifies.map((r) => r.fullNumber).join(', '),
                        })}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-4 md:justify-end">
                    <div className="text-right">
                      <p className="font-semibold tabular-nums text-text">
                        {money(invoice.total, invoice.currency)}
                      </p>
                      <p className="text-xs text-text-muted">
                        {invoice.vatRateBps > 0
                          ? t('vatBreakdown', {
                              base: money(invoice.taxBase, invoice.currency),
                              vat: money(invoice.vatAmount, invoice.currency),
                              rate: invoice.vatRateBps / 100,
                            })
                          : t(`regime.${invoice.regime}`)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={downloading === invoice.id}
                      onClick={() => void download(invoice)}
                      data-testid="invoice-download"
                    >
                      {downloading === invoice.id ? t('downloading') : t('download')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {isSuperAdmin && data?.enabled ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="invoices-month">{t('runMonthLabel')}</Label>
              <Input
                id="invoices-month"
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="w-44"
              />
            </div>
            <Button type="button" disabled={running || !month} onClick={() => void run()}>
              {running ? t('running') : t('run')}
            </Button>
            {runResult ? (
              <p role="status" className="text-sm text-text-muted sm:ml-2">
                {runResult}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
