'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Diálogo «Reembolsar» de una venta («Tus ventas», modo plataforma, E6).
 *
 * Total o parcial, y ANTES de confirmar explica en llano qué recibe el alumno
 * y qué se le descuenta al creador. Los importes los calcula la API
 * (`GET …/refund-preview`); aquí no se calcula ninguno.
 *
 * Doble clic: al abrirse genera un `requestId` (UUID) que es el id del
 * reembolso en el servidor; dos envíos con el mismo acaban en UN reembolso. El
 * botón además se bloquea mientras se envía.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  formatStripeAmount,
  parseRefundAmount,
  payoutsApi,
  refundAmountInput,
  type PayoutsRefundPreviewDto,
  type PayoutsSaleDto,
} from '@/lib/payouts';

export interface PayoutsRefundDialogProps {
  sale: PayoutsSaleDto;
  operatorName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tras un reembolso hecho: recargar la lista. */
  onRefunded: () => void;
  /** Inyectable para tests. */
  api?: Pick<typeof payoutsApi, 'refundPreview' | 'refund'>;
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Navegadores viejos: UUID v4 a mano (solo identifica el clic; no es secreto).
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

export function PayoutsRefundDialog({
  sale,
  operatorName,
  open,
  onOpenChange,
  onRefunded,
  api = payoutsApi,
}: PayoutsRefundDialogProps): React.JSX.Element | null {
  const t = useTranslations('adminPagos.payouts.sales.refund');
  const tErrors = useTranslations('errors');
  const locale = useLocale();

  const [requestId, setRequestId] = useState(newRequestId);
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amountText, setAmountText] = useState('');
  const [full, setFull] = useState<PayoutsRefundPreviewDto | null>(null);
  const [preview, setPreview] = useState<PayoutsRefundPreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: number; currency: string } | null>(null);

  // Cada apertura es un intento nuevo (y un `requestId` nuevo).
  useEffect(() => {
    if (!open) return;
    setRequestId(newRequestId());
    setMode('full');
    setAmountText('');
    setPreview(null);
    setFull(null);
    setError(null);
    setDone(null);
    setLoading(true);
    api
      .refundPreview(sale.id)
      .then((p) => {
        setFull(p);
        setPreview(p);
      })
      .catch((err: unknown) => setError(apiErrorMessage(err, tErrors)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sale.id]);

  const chargeCurrency = full?.chargeCurrency ?? sale.presentmentCurrency;
  const money = useCallback(
    (amount: number, currency: string) => formatStripeAmount(amount, currency, locale),
    [locale],
  );
  const partialAmount = useMemo(
    () => (mode === 'partial' ? parseRefundAmount(amountText, chargeCurrency) : null),
    [mode, amountText, chargeCurrency],
  );
  const partialValid = partialAmount !== null && full !== null && partialAmount <= full.refundable;

  // Previsualización del parcial, con un respiro mientras se escribe.
  useEffect(() => {
    if (!open || mode !== 'partial' || !partialValid || partialAmount === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .refundPreview(sale.id, partialAmount)
        .then((p) => {
          if (!cancelled) {
            setPreview(p);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(apiErrorMessage(err, tErrors));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, partialAmount, partialValid, sale.id]);

  const shown = mode === 'full' ? full : partialValid ? preview : null;
  const shownMatches =
    shown !== null &&
    (mode === 'full' || (partialAmount !== null && shown.amount === partialAmount));

  const submit = async () => {
    if (!shown || !shownMatches || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.refund(sale.id, {
        requestId,
        ...(mode === 'partial' ? { amount: shown.amount } : {}),
      });
      setDone({ amount: result.amount, currency: result.currency });
      onRefunded();
    } catch (err) {
      setError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('loading'));
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;
  const item = sale.description ?? '—';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!sending) onOpenChange(next);
      }}
      title={done ? t('doneTitle') : t('title', { item })}
      ariaLabel={t('title', { item })}
    >
      <div className="space-y-4 text-[0.9375rem] leading-relaxed" data-testid="refund-dialog">
        {done ? (
          <>
            <p role="status">{t('done', { amount: money(done.amount, done.currency) })}</p>
            <div className="flex justify-end">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('close')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {full ? (
              <fieldset className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="refund-mode"
                    checked={mode === 'full'}
                    onChange={() => setMode('full')}
                  />
                  <span>
                    {t('optionFull', { amount: money(full.refundable, full.chargeCurrency) })}
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="refund-mode"
                    checked={mode === 'partial'}
                    onChange={() => {
                      setMode('partial');
                      if (!amountText) {
                        setAmountText(
                          refundAmountInput(
                            Math.floor(full.refundable / 2),
                            full.chargeCurrency,
                            locale,
                          ),
                        );
                      }
                    }}
                  />
                  <span>{t('optionPartial')}</span>
                </label>
                {mode === 'partial' ? (
                  <div className="space-y-1 pl-6">
                    <Label htmlFor="refund-amount">
                      {t('amountLabel', { currency: full.chargeCurrency.toUpperCase() })}
                    </Label>
                    <Input
                      id="refund-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      value={amountText}
                      onChange={(e) => setAmountText(e.target.value)}
                      aria-invalid={amountText !== '' && !partialValid}
                      className="max-w-[10rem]"
                    />
                    <p className="text-sm text-text-muted">
                      {amountText !== '' && !partialValid
                        ? t('amountInvalid', {
                            amount: money(full.refundable, full.chargeCurrency),
                          })
                        : t('amountHint', { amount: money(full.refundable, full.chargeCurrency) })}
                    </p>
                  </div>
                ) : null}
              </fieldset>
            ) : null}

            {loading && !shown ? (
              <p className="text-sm text-text-muted" aria-live="polite">
                {t('loading')}
              </p>
            ) : null}

            {shown ? (
              <ul
                className="space-y-2 rounded-lg border border-border-soft bg-surface-2 p-3.5"
                data-testid="refund-explanation"
              >
                {refundExplanation(shown, sale, operatorName, money, t as RefundTranslator).map(
                  (line) => (
                    <li
                      key={line.key}
                      className={line.strong ? 'font-semibold text-text' : 'text-text'}
                    >
                      {line.text}
                    </li>
                  ),
                )}
              </ul>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={sending}
                onClick={() => onOpenChange(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!shown || !shownMatches || sending || loading}
                onClick={() => void submit()}
                data-testid="refund-confirm"
              >
                {sending
                  ? t('confirming')
                  : t('confirm', {
                      amount: shown ? money(shown.amount, shown.chargeCurrency) : '',
                    })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Traductor mínimo (el de `adminPagos.payouts.sales.refund`). */
export type RefundTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Las frases que explican el reembolso, en orden. Pura (se prueba sin DOM):
 * cada importe sale tal cual de la previsualización de la API.
 */
export function refundExplanation(
  preview: PayoutsRefundPreviewDto,
  sale: Pick<PayoutsSaleDto, 'refundedAmount' | 'gross'>,
  operator: string,
  money: (amount: number, currency: string) => string,
  t: RefundTranslator,
): Array<{ key: string; text: string; strong?: boolean }> {
  const settle = (amount: number) => money(amount, preview.currency);
  const lines: Array<{ key: string; text: string; strong?: boolean }> = [
    {
      key: 'student',
      text: t('studentGets', { amount: money(preview.amount, preview.chargeCurrency) }),
    },
    { key: 'creator', text: t('creatorShare', { amount: settle(preview.creatorShare) }) },
    { key: 'how', text: t(preview.alreadyPaidOut ? 'paidOutHow' : 'notPaidOutHow') },
  ];
  if (preview.cardFee > 0) {
    lines.push({
      key: 'card',
      text:
        preview.cardFeeToCreator > 0
          ? t('cardFeeCreator', { amount: settle(preview.cardFeeToCreator) })
          : t('cardFeePlatform', { amount: settle(preview.cardFee), operator }),
    });
  }
  if (preview.platformFeeReturned > 0) {
    lines.push({
      key: 'operator',
      text: t('operatorFeeReturned', { amount: settle(preview.platformFeeReturned), operator }),
    });
  } else if (preview.platformFeeToCreator > 0) {
    lines.push({
      key: 'operator',
      text: t('operatorFeeKept', { amount: settle(preview.platformFeeToCreator), operator }),
    });
  }
  lines.push({
    key: 'total',
    text: t('total', { amount: settle(preview.creatorTotal) }),
    strong: true,
  });
  const fullAfter =
    sale.gross !== null && sale.refundedAmount + preview.settlementAmount >= sale.gross;
  lines.push({ key: 'access', text: t(fullAfter ? 'accessFull' : 'accessPartial') });
  return lines;
}
