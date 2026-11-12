'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Tus ventas» (Administración → Cobros, solo en modo plataforma).
 *
 * Cada venta con lo que pagó el alumno, la comisión de la tarjeta, la del
 * operador, lo que recibe el creador, cuándo le llega y en qué está, en
 * lenguaje llano. Encima, un resumen por moneda: nunca se suman monedas
 * distintas. Los datos vienen de `GET /modules/payouts/sales` y `/summary`,
 * que leen lo que se liquidó contra Stripe; aquí no se calcula ningún
 * importe.
 *
 * Sin modo plataforma las rutas no existen (404) y la sección no se pinta.
 *
 * E6: botón «Reembolsar» en cada venta que se pueda (diálogo con lo que
 * recibe el alumno y lo que se descuenta al creador), avisos de deuda («Te
 * descontaremos {importe} de tus próximos cobros por {motivo}») y de
 * reclamaciones abiertas con su fecha límite.
 */

import { useCallback, useEffect, useState } from 'react';
import { PayoutsRefundDialog } from '@/components/admin/payouts-refund-dialog';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import {
  debtReasonKey,
  feePercent,
  formatStripeAmount,
  payoutsApi,
  saleStatusView,
  type PayoutsCurrencySummaryDto,
  type PayoutsSaleDto,
  type PayoutsSalesPageDto,
  type PayoutsSummaryDto,
} from '@/lib/payouts';

const PAGE_SIZE = 20;

const BADGE_BY_TONE = {
  neutral: 'muted',
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
} as const;

export interface PayoutsSalesSectionProps {
  /** Inyectable para tests. */
  api?: Pick<typeof payoutsApi, 'sales' | 'summary' | 'refundPreview' | 'refund'>;
}

export function PayoutsSalesSection({
  api = payoutsApi,
}: PayoutsSalesSectionProps): React.JSX.Element | null {
  const t = useTranslations('adminPagos.payouts.sales');
  const tPayouts = useTranslations('adminPagos.payouts');
  const tErrors = useTranslations('errors');
  const locale = useLocale();

  const [page, setPage] = useState(1);
  const [sales, setSales] = useState<PayoutsSalesPageDto | null | undefined>(undefined);
  const [summary, setSummary] = useState<PayoutsSummaryDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<PayoutsSaleDto | null>(null);

  const load = useCallback(
    async (target: number) => {
      try {
        const [nextSales, nextSummary] = await Promise.all([
          api.sales(target, PAGE_SIZE),
          api.summary(),
        ]);
        setSales(nextSales);
        setSummary(nextSummary);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('loadError'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  useEffect(() => {
    void load(page);
  }, [load, page]);

  // Sin modo plataforma: nada que enseñar.
  if (sales === null || summary === null) return null;

  const operator = summary?.operatorName ?? '';
  const percent = feePercent(summary?.feeBps ?? 0, locale);
  const money = (amount: number | null, currency: string | null) =>
    amount === null || !currency ? null : formatStripeAmount(amount, currency, locale);
  const currencyName = (code: string) =>
    labelOr(tPayouts, `currencies.${code.toLowerCase()}`, code.toUpperCase());
  const pages = sales ? Math.max(1, Math.ceil(sales.total / sales.pageSize)) : 1;
  const anyHeld = sales?.items.some(
    (s) =>
      s.status === 'HELD' &&
      s.reason !== 'charge_refunded' &&
      s.reason !== 'charge_disputed' &&
      !s.disputeOpen,
  );
  const debts = summary?.debts ?? [];
  const disputes = summary?.disputes ?? [];
  const date = (iso: string) =>
    formatDate(iso, { locale, day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <section
      className="space-y-4"
      aria-labelledby="payouts-sales-title"
      data-testid="payouts-sales"
    >
      <header className="space-y-1">
        <h2 id="payouts-sales-title" className="font-display text-xl font-bold tracking-tight">
          {t('title')}
        </h2>
        {summary ? (
          <p className="max-w-2xl text-sm text-text-muted">{t('intro', { percent, operator })}</p>
        ) : null}
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {sales === undefined && !error ? (
        <p className="text-sm text-text-muted" aria-live="polite">
          {t('loading')}
        </p>
      ) : null}

      {summary && summary.currencies.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2" data-testid="payouts-summary">
          {summary.currencies.map((c) => (
            <CurrencySummaryCard
              key={c.currency}
              summary={c}
              title={t('summaryTitle', { currency: currencyName(c.currency) })}
              operatorFeeLabel={t('summaryOperatorFees', { percent, operator })}
              money={(amount) => money(amount, c.currency) ?? ''}
            />
          ))}
        </div>
      ) : null}

      {summary && summary.awaitingFeeCount > 0 ? (
        <Notice tone="info">{t('awaiting', { count: summary.awaitingFeeCount })}</Notice>
      ) : null}
      {anyHeld ? <Notice tone="warning">{t('noticeHeld')}</Notice> : null}
      {disputes.map((d) => (
        <Notice key={d.id} tone="warning" testId="payouts-notice-dispute">
          {d.evidenceDueBy
            ? t('noticeDispute', {
                item: d.saleDescription ?? t('noDescription'),
                amount: money(d.amount, d.currency) ?? '',
                date: date(d.evidenceDueBy),
              })
            : t('noticeDisputeNoDate', {
                item: d.saleDescription ?? t('noDescription'),
                amount: money(d.amount, d.currency) ?? '',
              })}
        </Notice>
      ))}
      {debts.map((d) => (
        <Notice key={d.id} tone="warning" testId="payouts-notice-debt">
          {t('noticeDebtItem', {
            amount: money(d.amountOutstanding, d.currency) ?? '',
            reason: t(`debtReasons.${debtReasonKey(d.reason)}`, {
              item: d.saleDescription ?? t('noDescription'),
            }),
          })}
          {d.frozen ? ` ${t('noticeDebtFrozen')}` : null}
        </Notice>
      ))}

      {sales && sales.total === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-text-muted">{t('empty')}</p>
          </CardContent>
        </Card>
      ) : null}

      {sales && sales.items.length > 0 ? (
        <Card>
          <CardContent className="pt-2 md:pt-4">
            {/* Escritorio: tabla. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm" data-testid="payouts-sales-table">
                <thead>
                  <tr className="border-b border-border-soft text-left text-xs text-text-subtle">
                    <th className="py-2 pr-3 font-medium">{t('colDate')}</th>
                    <th className="py-2 pr-3 font-medium">{t('colItem')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('colPaid')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('colCardFee')}</th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t('colOperatorFee', { percent, operator })}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">{t('colYouGet')}</th>
                    <th className="py-2 pr-3 font-medium">{t('colArrives')}</th>
                    <th className="py-2 pr-3 font-medium">{t('colStatus')}</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">{t('refundCta')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sales.items.map((sale) => {
                    const row = describeSale(sale, money, locale, t as SalesTranslator);
                    return (
                      <tr key={sale.id} className="border-b border-border-soft align-top">
                        <td className="whitespace-nowrap py-3 pr-3 text-text-muted">{row.date}</td>
                        <td className="py-3 pr-3 font-medium text-text">{row.item}</td>
                        <td className="whitespace-nowrap py-3 pr-3 text-right tabular-nums text-text">
                          {row.paid}
                          {row.studentPaid ? (
                            <span className="block text-xs font-normal text-text-subtle">
                              {row.studentPaid}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-3 text-right tabular-nums text-text-muted">
                          {row.cardFee}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-3 text-right tabular-nums text-text-muted">
                          {row.operatorFee}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-3 text-right font-semibold tabular-nums text-text">
                          {row.youGet}
                          {row.debtNote ? (
                            <span className="block text-xs font-normal text-text-subtle">
                              {row.debtNote}
                            </span>
                          ) : null}
                          {row.refundNote ? (
                            <span className="block text-xs font-normal text-text-subtle">
                              {row.refundNote}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-3 text-text-muted">
                          {row.arrives}
                        </td>
                        <td className="py-3 pr-3">
                          <Badge
                            variant={BADGE_BY_TONE[row.status.tone]}
                            className="whitespace-nowrap"
                          >
                            {t(`status.${row.status.key}`)}
                          </Badge>
                        </td>
                        <td className="py-3 text-right">
                          {sale.canRefund ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setRefunding(sale)}
                              data-testid="refund-open"
                            >
                              {t('refundCta')}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Móvil: una ficha por venta. */}
            <ul className="divide-y divide-border-soft md:hidden" data-testid="payouts-sales-list">
              {sales.items.map((sale) => {
                const row = describeSale(sale, money, locale, t as SalesTranslator);
                return (
                  <li key={sale.id} className="space-y-2 py-4">
                    <div>
                      <p className="font-medium text-text">{row.item}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-xs text-text-subtle">{row.date}</span>
                        <Badge variant={BADGE_BY_TONE[row.status.tone]}>
                          {t(`status.${row.status.key}`)}
                        </Badge>
                      </div>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-text-muted">{t('colPaid')}</dt>
                      <dd className="text-right tabular-nums">
                        {row.paid}
                        {row.studentPaid ? (
                          <span className="block text-xs text-text-subtle">{row.studentPaid}</span>
                        ) : null}
                      </dd>
                      <dt className="text-text-muted">{t('colCardFee')}</dt>
                      <dd className="text-right tabular-nums text-text-muted">{row.cardFee}</dd>
                      <dt className="text-text-muted">
                        {t('colOperatorFee', { percent, operator })}
                      </dt>
                      <dd className="text-right tabular-nums text-text-muted">{row.operatorFee}</dd>
                      <dt className="font-medium text-text">{t('colYouGet')}</dt>
                      <dd className="text-right font-semibold tabular-nums">
                        {row.youGet}
                        {row.debtNote ? (
                          <span className="block text-xs font-normal text-text-subtle">
                            {row.debtNote}
                          </span>
                        ) : null}
                        {row.refundNote ? (
                          <span className="block text-xs font-normal text-text-subtle">
                            {row.refundNote}
                          </span>
                        ) : null}
                      </dd>
                      <dt className="text-text-muted">{t('colArrives')}</dt>
                      <dd className="text-right text-text-muted">{row.arrives}</dd>
                    </dl>
                    {sale.canRefund ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setRefunding(sale)}
                      >
                        {t('refundCta')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {pages > 1 ? (
              <div className="flex items-center justify-between gap-3 border-t border-border-soft pt-4 text-sm">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  {t('newer')}
                </Button>
                <span className="text-text-muted">{t('pageOf', { page, pages })}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                >
                  {t('older')}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {refunding ? (
        <PayoutsRefundDialog
          sale={refunding}
          operatorName={operator}
          open
          onOpenChange={(open) => {
            if (!open) setRefunding(null);
          }}
          onRefunded={() => void load(page)}
          api={api}
        />
      ) : null}
    </section>
  );
}

/** Traductor mínimo (el de `adminPagos.payouts.sales`). */
export type SalesTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Textos de una fila. Puro (se prueba sin DOM): lo que se ve sale de la venta
 * tal como la da la API, sin calcular ningún importe.
 */
export function describeSale(
  sale: PayoutsSaleDto,
  money: (amount: number | null, currency: string | null) => string | null,
  locale: string,
  t: SalesTranslator,
) {
  const status = saleStatusView(sale);
  const settled = sale.currency !== null && sale.gross !== null;
  const paid = settled
    ? money(sale.gross, sale.currency)!
    : money(sale.presentmentAmount, sale.presentmentCurrency)!;
  // Lo que pagó el alumno en SU moneda, solo si no es la de cobro.
  const studentPaid =
    settled && sale.presentmentCurrency !== sale.currency
      ? t('studentPaid', { amount: money(sale.presentmentAmount, sale.presentmentCurrency)! })
      : null;
  const pending = t('pending');
  const youGet =
    sale.status === 'SETTLED_NETTED'
      ? money(0, sale.currency)!
      : (money(sale.transferAmount ?? sale.creatorNet, sale.currency) ?? pending);
  let arrives: string;
  if (sale.status === 'AWAITING_FEE') arrives = t('arrivesPending');
  else if ((sale.status === 'TRANSFERRED' || sale.status === 'READY') && sale.estimatedArrival) {
    arrives = t('arrivesOn', {
      date: formatDate(`${sale.estimatedArrival}T12:00:00Z`, {
        locale,
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
      }),
    });
  } else arrives = t('arrivesNone');
  return {
    status,
    date: sale.chargedAt
      ? formatDate(sale.chargedAt, { locale, day: 'numeric', month: 'short', year: 'numeric' })
      : '—',
    item: sale.description ?? t('noDescription'),
    paid,
    studentPaid,
    cardFee: money(sale.stripeFee, sale.currency) ?? pending,
    operatorFee: money(sale.platformFee, sale.currency) ?? pending,
    youGet,
    debtNote:
      sale.debtNetted > 0
        ? t('debtPaid', { amount: money(sale.debtNetted, sale.currency)! })
        : null,
    refundNote:
      (sale.refundedAmount ?? 0) > 0
        ? t('refundedNote', { amount: money(sale.refundedAmount, sale.currency)! })
        : null,
    arrives,
  };
}

function CurrencySummaryCard({
  summary,
  title,
  operatorFeeLabel,
  money,
}: {
  summary: PayoutsCurrencySummaryDto;
  title: string;
  operatorFeeLabel: string;
  money: (amount: number) => string;
}): React.JSX.Element {
  const t = useTranslations('adminPagos.payouts.sales');
  const rows: Array<[string, number, boolean?]> = [
    [t('summarySold'), summary.gross],
    [t('summaryCardFees'), summary.stripeFees],
    [operatorFeeLabel, summary.platformFees],
    [t('summaryReceived'), summary.received, true],
    [t('summaryPending'), summary.pending],
  ];
  if ((summary.refunded ?? 0) > 0) rows.push([t('summaryRefunded'), summary.refunded]);
  if ((summary.reversed ?? 0) > 0) rows.push([t('summaryReversed'), summary.reversed]);
  if (summary.debtNetted > 0) rows.push([t('summaryDebtNetted'), summary.debtNetted]);
  if (summary.debtOutstanding > 0) rows.push([t('summaryDebt'), summary.debtOutstanding]);
  return (
    <Card data-currency={summary.currency}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{t('summarySalesCount', { count: summary.salesCount })}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1.5 text-sm">
          {rows.map(([label, amount, strong]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className={strong ? 'font-medium text-text' : 'text-text-muted'}>{label}</dt>
              <dd
                className={`tabular-nums ${strong ? 'font-semibold text-text' : 'text-text-muted'}`}
              >
                {money(amount)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function Notice({
  tone,
  children,
  testId,
}: {
  tone: 'info' | 'warning';
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  const styles =
    tone === 'info'
      ? 'border-brand-100 bg-brand-50 text-brand-800'
      : 'border-warning-200 bg-warning-50 text-warning-700';
  return (
    <p
      role="status"
      data-testid={testId}
      className={`rounded-lg border p-3.5 text-[0.9375rem] leading-relaxed ${styles}`}
    >
      {children}
    </p>
  );
}
