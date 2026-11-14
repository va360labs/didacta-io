'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { PayoutsRefundDialog } from '@/components/admin/payouts-refund-dialog';
import { Icon } from '@/components/icon';
import { Dialog } from '@/components/ui/dialog';
import {
  formatDate,
  formatDateTime,
  formatStripeMinor,
  regionNameFormatter,
} from '@/lib/i18n/format';
import { feePercent } from '@/lib/payouts';
import { mailtoBuyer, salesApi, type SaleDetail } from '@/lib/sales';
import { StatusBadge } from './sale-status-badge';

/**
 * Detalle de una venta: quién la compró (y cómo escribirle), qué compró, el
 * recibo (lo que pagó, el cupón o el saldo de referidos, las comisiones y lo
 * que le llega al creador), su historia (cobro, envío, reembolsos,
 * reclamaciones) y las acciones: reembolsar (si la cobró la plataforma y se
 * puede), escribir al comprador, ver su ficha y la factura de Stripe de una
 * cuota.
 */
export function SaleDetailDialog({
  saleId,
  onClose,
  onRefunded,
}: {
  saleId: string;
  onClose: () => void;
  onRefunded?: () => void;
}) {
  const t = useTranslations('modoSencilloVentas.datos');
  const locale = useLocale();
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [error, setError] = useState(false);
  const [refunding, setRefunding] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await salesApi.detail(saleId));
      setError(false);
    } catch {
      setError(true);
    }
  }, [saleId]);
  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number | null | undefined, currency: string | null | undefined) =>
    minor === null || minor === undefined || !currency
      ? '—'
      : formatStripeMinor(minor, currency, { exact: true, locale });
  const sale = detail?.sale;
  const title = sale
    ? t('detalle.titulo', {
        fecha: formatDateTime(sale.at, { locale, dateStyle: 'long', timeStyle: 'short' }),
      })
    : t('detalle.cargando');
  const buyerName = sale
    ? (sale.buyer.name ?? (sale.buyer.deleted ? t('cuentaEliminada') : t('sinNombre')))
    : '';
  const s = sale?.settlement ?? null;
  const operator = detail?.platform?.operatorName ?? 'Didacta';
  const payout = detail?.payout ?? null;

  return (
    <>
      <Dialog
        open={!refunding}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={title}
        ariaLabel={title}
        maxWidthClass="max-w-2xl"
      >
        <div className="space-y-5 text-sm" data-testid="venta-detalle">
          {error ? (
            <p role="alert" className="text-danger-700">
              {t('detalle.error')}
            </p>
          ) : !sale || !detail ? (
            <div className="skeleton h-48" />
          ) : (
            <>
              {/* Comprador y producto */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-xs font-semibold tracking-wide text-text-subtle uppercase">
                    {t('detalle.comprador')}
                  </h3>
                  <p className="mt-1 text-base font-bold text-text" data-testid="detalle-nombre">
                    {buyerName}
                  </p>
                  {sale.buyer.email ? (
                    <a
                      href={`mailto:${sale.buyer.email}`}
                      className="block break-all text-brand-600 hover:underline"
                      data-testid="detalle-correo"
                    >
                      {sale.buyer.email}
                    </a>
                  ) : null}
                  {sale.buyer.checkoutEmail ? (
                    <p className="text-xs text-text-muted">
                      {t('detalle.correoPago', { email: sale.buyer.checkoutEmail })}
                    </p>
                  ) : null}
                  <p className="mt-1 text-text-muted">
                    {t('detalle.pais')}:{' '}
                    {sale.buyer.country ? regionNameFormatter(locale)(sale.buyer.country) : '—'}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold tracking-wide text-text-subtle uppercase">
                    {t('detalle.producto')}
                  </h3>
                  <p className="mt-1 font-semibold text-text">
                    {sale.product.title ?? '—'}
                    {sale.product.option ? ` · ${sale.product.option}` : ''}
                  </p>
                  <p className="text-text-muted">
                    {sale.kind === 'order'
                      ? t('tipo.order')
                      : sale.product.kind === 'membership'
                        ? t('tipo.membership')
                        : t('tipo.subscription')}
                  </p>
                  {detail.period ? (
                    <p className="text-text-muted">
                      {t('detalle.periodo', {
                        inicio: formatDate(detail.period.start, { locale, dateStyle: 'medium' }),
                        fin: formatDate(detail.period.end, { locale, dateStyle: 'medium' }),
                      })}
                    </p>
                  ) : null}
                  <div className="mt-1.5">
                    <StatusBadge sale={sale} />
                  </div>
                </div>
              </div>

              {/* Recibo */}
              <div
                className="rounded-xl border border-border bg-bg-subtle p-4"
                data-testid="detalle-recibo"
              >
                <h3 className="text-xs font-semibold tracking-wide text-text-subtle uppercase">
                  {t('detalle.recibo')}
                </h3>
                <dl className="mt-2 space-y-1.5 tabular-nums">
                  <Line
                    label={t('detalle.pago')}
                    value={money(sale.amount, sale.currency)}
                    strong
                  />
                  {sale.coupon ? (
                    <Line
                      label={t('detalle.cupon')}
                      value={`−${money(sale.coupon, sale.currency)}`}
                    />
                  ) : null}
                  {sale.referralCredit ? (
                    <Line
                      label={t('detalle.saldoReferidos')}
                      value={money(sale.referralCredit, sale.currency)}
                    />
                  ) : null}
                  {s ? (
                    <>
                      {s.currency && s.currency !== sale.currency ? (
                        <p className="text-xs text-text-muted">
                          {t('detalle.enOtraMoneda', {
                            importe: money(sale.amount, sale.currency),
                            moneda: s.currency.toUpperCase(),
                          })}
                        </p>
                      ) : null}
                      <Line
                        label={t('detalle.comisionTarjeta')}
                        value={
                          s.cardFee === null ? t('calculando') : `−${money(s.cardFee, s.currency)}`
                        }
                      />
                      <Line
                        label={t('detalle.comisionOperador', {
                          operador: operator,
                          porcentaje: feePercent(
                            payout?.feeBpsApplied ?? detail.platform?.feeBps ?? 0,
                            locale,
                          ),
                        })}
                        value={
                          s.platformFee === null
                            ? t('calculando')
                            : `−${money(s.platformFee, s.currency)}`
                        }
                      />
                      {s.debtNetted > 0 ? (
                        <Line
                          label={t('detalle.deuda')}
                          value={`−${money(s.debtNetted, s.currency)}`}
                        />
                      ) : null}
                      {s.refunded > 0 ? (
                        <Line label={t('detalle.devuelto')} value={money(s.refunded, s.currency)} />
                      ) : null}
                      <div className="border-t border-border pt-1.5">
                        <Line
                          label={t('detalle.neto')}
                          value={s.net === null ? t('calculando') : money(s.net, s.currency)}
                          strong
                          testId="detalle-neto"
                        />
                      </div>
                      {s.net === null ? (
                        <p className="text-xs text-text-muted">{t('detalle.calculando')}</p>
                      ) : null}
                    </>
                  ) : sale.refundState === 'full' ? (
                    <Line label={t('detalle.devuelto')} value={money(sale.amount, sale.currency)} />
                  ) : null}
                </dl>
                {sale.referral ? (
                  <p className="mt-2 text-xs text-text-muted" data-testid="detalle-referido">
                    {t('detalle.referido', {
                      nombre: sale.referral.referrerName ?? sale.referral.code ?? '—',
                      comision: money(sale.referral.commission, sale.referral.commissionCurrency),
                    })}
                  </p>
                ) : null}
              </div>

              {/* Historia */}
              {detail.events.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold tracking-wide text-text-subtle uppercase">
                    {t('detalle.historia')}
                  </h3>
                  <ol className="mt-2 space-y-1.5">
                    {detail.events.map((e, i) => (
                      <li key={`${e.type}-${i}`} className="flex items-baseline gap-2">
                        <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full bg-brand-600" />
                        <span className="text-text">{t(`detalle.evento.${e.type}`)}</span>
                        {e.amount !== null ? (
                          <span className="text-text-muted tabular-nums">
                            {money(e.amount, e.currency)}
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs whitespace-nowrap text-text-subtle">
                          {formatDateTime(e.at, {
                            locale,
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {/* Acciones */}
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {payout?.canRefund ? (
                  <button
                    type="button"
                    onClick={() => setRefunding(true)}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-danger-100 bg-surface px-3 font-semibold text-danger-700 hover:bg-danger-50"
                    data-testid="detalle-reembolsar"
                  >
                    <Icon name="arrow-left" size={15} />
                    {t('detalle.reembolsar')}
                  </button>
                ) : null}
                {sale.buyer.email ? (
                  <a
                    href={mailtoBuyer(
                      sale.buyer.email,
                      t('detalle.asunto', { producto: sale.product.title ?? '' }),
                    )}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-3 font-semibold text-white hover:bg-brand-700"
                    data-testid="detalle-escribir"
                  >
                    <Icon name="mail" size={15} />
                    {t('detalle.escribir')}
                  </a>
                ) : null}
                {sale.buyer.userId && !sale.buyer.deleted ? (
                  <Link
                    href={`/u/${sale.buyer.userId}`}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 font-semibold text-text hover:border-border-strong"
                    data-testid="detalle-ver-alumno"
                  >
                    <Icon name="user" size={15} />
                    {t('detalle.verAlumno')}
                  </Link>
                ) : null}
                {detail.hostedInvoiceUrl ? (
                  <a
                    href={detail.hostedInvoiceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 font-semibold text-text hover:border-border-strong"
                  >
                    <Icon name="file" size={15} />
                    {t('detalle.factura')}
                  </a>
                ) : null}
              </div>
              {/* Sin reparto de la plataforma la cobró la cuenta propia del aula. */}
              {!payout && !s && sale.refundState !== 'full' ? (
                <p className="text-xs text-text-muted">{t('detalle.reembolsoFuera')}</p>
              ) : null}
              <p className="text-xs text-text-subtle">
                {t('detalle.referencia')}: <span className="font-mono">{sale.id}</span>
              </p>
            </>
          )}
        </div>
      </Dialog>
      {refunding && payout ? (
        <PayoutsRefundDialog
          sale={payout}
          operatorName={operator}
          open
          onOpenChange={(open) => {
            if (!open) setRefunding(false);
          }}
          onRefunded={() => {
            void load();
            onRefunded?.();
          }}
        />
      ) : null}
    </>
  );
}

function Line({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-semibold text-text' : 'text-text-muted'}>{label}</dt>
      <dd className={strong ? 'font-bold text-text' : 'text-text-muted'} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
