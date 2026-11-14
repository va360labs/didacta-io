'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatStripeMinor } from '@/lib/i18n/format';
import { bpsToPercent, estimateTakeHome, type PriceFees } from '@/lib/price-estimate';
import { parseAmount, simpleModeApi } from '@/lib/simple-mode';
import { minorToInput } from '@/lib/stripe-currencies';
import { cn } from '@/lib/utils';

/**
 * Monedas en las que el aula puede poner precio y las comisiones para estimar
 * lo que le llega al creador. Una sola petición por pantalla.
 */
export function usePriceOptions(initialCurrency: string): {
  currencies: string[];
  fees: PriceFees | null;
} {
  const [currencies, setCurrencies] = useState<string[]>([initialCurrency]);
  const [fees, setFees] = useState<PriceFees | null>(null);
  useEffect(() => {
    let cancelled = false;
    simpleModeApi
      .currencies()
      .then((r) => {
        if (cancelled) return;
        setCurrencies(
          r.currencies.includes(initialCurrency)
            ? r.currencies
            : [initialCurrency, ...r.currencies],
        );
        setFees(r.fees ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initialCurrency]);
  return { currencies, fees };
}

/**
 * «Con 49 € te llegan ~44,25 €», con el desglose (tarjeta y comisión del
 * operador) y la advertencia de que es aproximado. Las comisiones son las de
 * la API (`fees`): nunca una constante de la web.
 */
export function TakeHomeEstimate({
  amount,
  currency,
  fees,
  className,
}: {
  amount: number | null;
  currency: string;
  fees: PriceFees | null;
  className?: string;
}) {
  const t = useTranslations('modoSencilloVentas.estimacion');
  const locale = useLocale();
  if (!fees || !amount) return null;
  const take = estimateTakeHome(amount, fees);
  if (!take) return null;
  const money = (minor: number) => formatStripeMinor(minor, currency, { locale });
  return (
    <div className={cn('text-[13px] text-text-muted', className)} data-testid="te-llega">
      <p className="font-semibold text-text">
        {t('llegan', { precio: money(take.amount), neto: money(take.net) })}
      </p>
      <p>
        {fees.platformFeeBps !== null
          ? t('desglose', {
              tarjeta: money(take.cardFee),
              porcentaje: bpsToPercent(fees.cardFeeBps, locale),
              fijo: money(fees.cardFeeFixed),
              operador: fees.operatorName ?? 'Didacta',
              plataforma: money(take.platformFee),
              comision: bpsToPercent(fees.platformFeeBps, locale),
            })
          : t('desgloseSinOperador', {
              tarjeta: money(take.cardFee),
              porcentaje: bpsToPercent(fees.cardFeeBps, locale),
              fijo: money(fees.cardFeeFixed),
            })}
      </p>
      <p className="text-text-subtle">{t('aproximado')}</p>
    </div>
  );
}

/**
 * Importe + moneda + «lo que te llega» en vivo + guardar. El mismo formulario
 * en «Empieza aquí», «Ventas», el editor del curso y al publicar: cada uno le
 * dice qué hacer al guardar (todos acaban en el mismo precio de la API).
 */
export function PriceEditor({
  amountCents,
  currency: initialCurrency,
  onSave,
  onCancel,
  saveLabel,
  cancelLabel,
  amountLabel,
  currencyLabel,
  invalidText,
  errorText,
  size = 'md',
  testId,
}: {
  amountCents: number;
  currency: string;
  onSave: (price: { amountCents: number; currency: string }) => Promise<void>;
  onCancel?: () => void;
  saveLabel: string;
  cancelLabel?: string;
  amountLabel: string;
  currencyLabel: string;
  invalidText: string;
  errorText: string;
  size?: 'md' | 'lg';
  testId?: string;
}) {
  const locale = useLocale();
  const { currencies, fees } = usePriceOptions(initialCurrency);
  const [currency, setCurrency] = useState(initialCurrency);
  const [amount, setAmount] = useState(
    amountCents > 0 ? minorToInput(amountCents, initialCurrency, locale) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cents = parseAmount(amount, currency);

  async function save() {
    if (!cents) return setError(invalidText);
    setSaving(true);
    setError(null);
    try {
      await onSave({ amountCents: cents, currency });
    } catch {
      setError(errorText);
    } finally {
      setSaving(false);
    }
  }

  const height = size === 'lg' ? 'h-12' : 'h-11';
  return (
    <div data-testid={testId}>
      <div className="grid max-w-[360px] grid-cols-[minmax(0,1fr)_104px] gap-2">
        <input
          aria-label={amountLabel}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
          className={cn(
            height,
            'rounded-xl border border-border bg-surface px-3 font-bold text-text tabular-nums outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100',
            size === 'lg' ? 'text-xl' : 'text-lg',
          )}
        />
        <select
          aria-label={currencyLabel}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className={cn(
            height,
            'rounded-xl border border-border bg-surface px-2 font-semibold text-text',
          )}
        >
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <TakeHomeEstimate amount={cents} currency={currency} fees={fees} className="mt-2" />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveLabel}
        </button>
        {onCancel && cancelLabel ? (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm font-semibold text-text-muted hover:text-text"
          >
            {cancelLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
