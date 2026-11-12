'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  MARKET_PRICE_CURRENCIES,
  isForeignCurrency,
  type CurrencyOptionDraft,
  type PriceDraftError,
  type PricePolicy,
} from '@/lib/pricing';
import { stripeDecimals } from '@/lib/stripe-currencies';

/**
 * Campos de un precio: importe, moneda y —en modo plataforma— el bloque plegado
 * «Precio fijo para otros países» (`currency_options` de Stripe).
 *
 * Lo comparten la ficha del curso, Productos y la membresía. No guarda nada:
 * quien lo usa convierte el borrador con `buildPrice` (`@/lib/pricing`).
 *
 *  - Modo plataforma: la moneda por defecto es la del creador; si elige otra,
 *    aviso en llano (2 % de conversión y sin precio en la moneda del alumno).
 *    Sin hacer nada, Adaptive Pricing ya enseña el precio convertido.
 *  - Claves propias / Community: importe y las monedas de siempre, sin más.
 */
export function PriceFields({
  idPrefix,
  policy,
  amount,
  currency,
  options,
  errors,
  onAmount,
  onCurrency,
  onOptions,
  disabled,
}: {
  idPrefix: string;
  policy: PricePolicy;
  amount: string;
  currency: string;
  options: readonly CurrencyOptionDraft[];
  errors: readonly PriceDraftError[];
  onAmount: (value: string) => void;
  onCurrency: (value: string) => void;
  onOptions: (value: CurrencyOptionDraft[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('modBilling.priceFields');
  const currencies = policy.currencies.includes(currency)
    ? policy.currencies
    : [...policy.currencies, currency];
  const amountError = errors.some((e) => e.field === 'amount');
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-amount`}>{t('amountLabel')}</Label>
          <Input
            id={`${idPrefix}-amount`}
            inputMode={stripeDecimals(currency) === 0 ? 'numeric' : 'decimal'}
            placeholder={t('amountPlaceholder')}
            value={amount}
            disabled={disabled}
            aria-invalid={amountError || undefined}
            aria-describedby={amountError ? `${idPrefix}-amount-error` : undefined}
            onChange={(e) => onAmount(e.target.value)}
          />
          {amountError ? (
            <p id={`${idPrefix}-amount-error`} className="text-xs text-danger-700">
              {t('amountInvalid', { currency: currency.toUpperCase() })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-currency`}>{t('currencyLabel')}</Label>
          <Select
            id={`${idPrefix}-currency`}
            value={currency}
            disabled={disabled}
            onChange={(e) => onCurrency(e.target.value)}
          >
            {currencies.map((c) => (
              <option key={c} value={c}>
                {policy.platform && c === policy.settlementCurrency
                  ? t('currencyYours', { currency: c.toUpperCase() })
                  : c.toUpperCase()}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <CurrencyNotice policy={policy} currency={currency} />

      {policy.platform ? (
        <MarketPricesFields
          idPrefix={idPrefix}
          currency={currency}
          options={options}
          errors={errors}
          onOptions={onOptions}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

/**
 * Debajo de la moneda: en modo plataforma, aviso si no es la del creador (2 %
 * de conversión y sin precio en la moneda del alumno) o, si lo es, que el
 * alumno verá el precio en su moneda sin hacer nada. Con claves propias, nada.
 */
export function CurrencyNotice({ policy, currency }: { policy: PricePolicy; currency: string }) {
  const t = useTranslations('modBilling.priceFields');
  if (isForeignCurrency(policy, currency)) {
    return (
      <p
        role="note"
        className="rounded-md border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800"
      >
        {t('foreignCurrencyWarning', {
          settlement: (policy.settlementCurrency ?? '').toUpperCase(),
          currency: currency.toUpperCase(),
        })}
      </p>
    );
  }
  return policy.platform ? <p className="text-sm text-text-subtle">{t('adaptiveHint')}</p> : null;
}

/**
 * Bloque plegado «Precio fijo para otros países» (`currency_options`). Solo en
 * modo plataforma. Inmutable en Stripe: cada cambio crea un Price nuevo.
 */
export function MarketPricesFields({
  idPrefix,
  currency,
  options,
  errors,
  onOptions,
  disabled,
}: {
  idPrefix: string;
  currency: string;
  options: readonly CurrencyOptionDraft[];
  errors: readonly PriceDraftError[];
  onOptions: (value: CurrencyOptionDraft[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('modBilling.priceFields');
  const optionError = (index: number) =>
    errors.find(
      (e): e is Extract<PriceDraftError, { field: 'option' }> =>
        e.field === 'option' && e.index === index,
    );
  const setRow = (index: number, patch: Partial<CurrencyOptionDraft>) =>
    onOptions(options.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const filled = options.filter((o) => o.currency || o.amount).length;

  return (
    <details className="rounded-lg border border-border p-3" open={filled > 0 || undefined}>
      <summary className="cursor-pointer text-sm font-medium text-text">
        {t('advancedSummary')}
      </summary>
      <div className="mt-3 flex flex-col gap-3 text-sm">
        <p className="text-text-subtle">{t('advancedIntro')}</p>
        {options.map((row, index) => {
          const err = optionError(index);
          const code = row.currency.toUpperCase();
          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${idPrefix}-opt-${index}-currency`}>
                    {t('advancedCurrency')}
                  </Label>
                  <Select
                    id={`${idPrefix}-opt-${index}-currency`}
                    value={row.currency}
                    disabled={disabled}
                    onChange={(e) => setRow(index, { currency: e.target.value })}
                  >
                    <option value="">—</option>
                    {(MARKET_PRICE_CURRENCIES.includes(row.currency) || !row.currency
                      ? MARKET_PRICE_CURRENCIES
                      : [...MARKET_PRICE_CURRENCIES, row.currency]
                    )
                      .filter((c) => c !== currency || c === row.currency)
                      .map((c) => (
                        <option key={c} value={c}>
                          {c.toUpperCase()}
                        </option>
                      ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${idPrefix}-opt-${index}-amount`}>{t('advancedAmount')}</Label>
                  <Input
                    id={`${idPrefix}-opt-${index}-amount`}
                    inputMode="decimal"
                    value={row.amount}
                    disabled={disabled}
                    aria-invalid={err ? true : undefined}
                    onChange={(e) => setRow(index, { amount: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onOptions(options.filter((_, i) => i !== index))}
                >
                  {t('advancedRemove', { currency: code || '—' })}
                </Button>
              </div>
              {err ? (
                <p className="text-xs text-danger-700">
                  {err.reason === 'same'
                    ? t('advancedSameCurrency')
                    : err.reason === 'duplicate'
                      ? t('advancedDuplicate', { currency: code })
                      : t('advancedInvalid', { currency: code || '—' })}
                </p>
              ) : null}
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onOptions([...options, { currency: '', amount: '' }])}
          >
            {t('advancedAdd')}
          </Button>
        </div>
        <p className="text-xs text-text-subtle">{t('advancedImmutable')}</p>
        <p className="text-xs text-text-subtle">{t('advancedFee')}</p>
      </div>
    </details>
  );
}
