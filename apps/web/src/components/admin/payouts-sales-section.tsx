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
import { useLocale, useTranslations } from 'next-intl';
import { SalesLedger } from '@/components/sales/sales-ledger';
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
  type PayoutsDebtDto,
  type PayoutsSaleDto,
  type PayoutsSalesPageDto,
  type PayoutsSummaryDto,
} from '@/lib/payouts';

const PAGE_SIZE = 100;

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

  const [sales, setSales] = useState<PayoutsSalesPageDto | null | undefined>(undefined);
  const [summary, setSummary] = useState<PayoutsSummaryDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: number) => {
      try {
        const [nextSales, nextSummary] = await Promise.all([
          // Solo para los avisos (retenidas…): la lista es la de «Ventas».
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
    void load(1);
  }, [load]);

  // Sin modo plataforma: nada que enseñar.
  if (sales === null || summary === null) return null;

  const operator = summary?.operatorName ?? '';
  const percent = feePercent(summary?.feeBps ?? 0, locale);
  const money = (amount: number | null, currency: string | null) =>
    amount === null || !currency ? null : formatStripeAmount(amount, currency, locale);
  const currencyName = (code: string) =>
    labelOr(tPayouts, `currencies.${code.toLowerCase()}`, code.toUpperCase());
  const anyHeld = sales?.items.some(
    (s) =>
      s.status === 'HELD' &&
      s.reason !== 'charge_refunded' &&
      s.reason !== 'charge_disputed' &&
      s.reason !== 'tax_profile_incomplete' &&
      !s.disputeOpen,
  );
  // Retenidas por faltar los datos fiscales: se arregla en la tarjeta de arriba.
  const anyTaxHeld = sales?.items.some(
    (s) => s.status === 'HELD' && s.reason === 'tax_profile_incomplete',
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
      {anyTaxHeld ? (
        <Notice tone="warning" testId="payouts-notice-tax-held">
          {t('noticeHeldTaxData')}
        </Notice>
      ) : null}
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
          {debtNoticeText(d, money, t as SalesTranslator)}
        </Notice>
      ))}

      {/* Cada venta con quién la compró, sus comisiones, lo que te llega y en
          qué está; búsqueda, filtros, detalle (con reembolsar) y exportar. */}
      <SalesLedger onChanged={() => void load(1)} />
    </section>
  );
}

/** Traductor mínimo (el de `adminPagos.payouts.sales`). */
export type SalesTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Aviso de una deuda abierta, en llano. La tasa de una reclamación que
 * GANAMOS tiene su propio texto: primero que se ganó y luego que el banco no
 * devuelve su tasa y se descuenta de los próximos cobros. Puro.
 */
export function debtNoticeText(
  debt: PayoutsDebtDto,
  money: (amount: number | null, currency: string | null) => string | null,
  t: SalesTranslator,
): string {
  const amount = money(debt.amountOutstanding, debt.currency) ?? '';
  const item = debt.saleDescription ?? t('noDescription');
  if (debt.fromWonDispute) return t('noticeDebtDisputeWon', { amount, item });
  const text = t('noticeDebtItem', {
    amount,
    reason: t(`debtReasons.${debtReasonKey(debt.reason)}`, { item }),
  });
  return debt.frozen ? `${text} ${t('noticeDebtFrozen')}` : text;
}

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
  const disputed = sale.disputeOpen || (sale.disputeOutcome ?? null) !== null;
  const reinstated = sale.reinstatedAmount ?? 0;
  const youGet =
    sale.status === 'SETTLED_NETTED'
      ? money(reinstated, sale.currency)!
      : sale.transferAmount === null
        ? (money(sale.creatorNet, sale.currency) ?? pending)
        : money(sale.transferAmount + reinstated, sale.currency)!;
  let arrives: string;
  if (sale.status === 'AWAITING_FEE') arrives = t('arrivesPending');
  // Devuelta entera: ya no llega ningún día (ensayo general: «hacia el 23 nov»
  // en una venta reembolsada).
  else if (sale.refundState === 'full') arrives = t('arrivesNone');
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
    // Con reclamación, lo retenido NO es «para saldar lo que debías»: se explica aparte.
    debtNote: disputed
      ? t(
          sale.disputeOpen
            ? 'disputeNoteOpen'
            : sale.disputeOutcome === 'won'
              ? 'disputeNoteWon'
              : 'disputeNoteLost',
        )
      : sale.debtNetted > 0
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
    // Lo que de verdad le queda: tras devolver una venta entera, no lo que se
    // le envió en su día (ensayo general: «Recibido 44,76 €» tras reembolsarla).
    [t('summaryReceived'), summary.receivedNet ?? summary.received, true],
    [t('summaryPending'), summary.pending],
  ];
  // Lo retenido, aparte: no está «en camino».
  if ((summary.held ?? 0) > 0) rows.push([t('summaryHeld'), summary.held ?? 0]);
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
