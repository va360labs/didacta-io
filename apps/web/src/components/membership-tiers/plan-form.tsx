'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CurrencyNotice, MarketPricesFields } from '@/components/admin/price-fields';
import { TakeHomeEstimate, usePriceOptions } from '@/components/simple-price/price-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { MembershipAdminPlan, MembershipAdminTier, PlanInput } from '@/lib/membership';
import type { PriceDraftError, PricePolicy } from '@/lib/pricing';
import { parseMajorInput, stripeDecimals } from '@/lib/stripe-currencies';
import { cn } from '@/lib/utils';
import {
  MEMBERSHIP_CURRENCY_OPTIONS,
  PLAN_NAME_MAX,
  buildPlanInput,
  followPlanName,
  intervalOptions,
  newPlanDraft,
  planDraftFromPlan,
  suggestCurrency,
  suggestInterval,
  type PlanDraft,
  type PlanDraftError,
} from './tier-helpers';
import { TIER_STYLES, useTierTexts, type TiersVariant } from './tier-ui';

/** Nombre corto de la periodicidad («Mensual», «Cada 2 meses»), el de la página de membresía. */
export function useIntervalLabel(): (months: number) => string {
  const t = useTranslations('adminMonetizacion.interval');
  return (n: number) => {
    if (n === 1) return t('monthly');
    if (n === 3) return t('quarterly');
    if (n === 6) return t('semiannual');
    if (n === 12) return t('annual');
    return t('everyMonths', { months: n });
  };
}

/**
 * Alta o edición de un precio de un nivel (una periodicidad): nombre, cada
 * cuánto se paga, moneda, precio, precio tachado, días de prueba y
 * «recomendado». En el modo completo con cobros de plataforma, también los
 * precios fijos por mercado; en el sencillo, «lo que te llega» en vivo.
 */
export function PlanForm({
  variant,
  tier,
  tiers,
  plan,
  policy,
  busy,
  onSubmit,
  onCancel,
}: {
  variant: TiersVariant;
  tier: MembershipAdminTier;
  /** Todos los niveles (para proponer la moneda de los precios que ya hay). */
  tiers: readonly MembershipAdminTier[];
  /** Precio que se edita, o `null` para crear uno. */
  plan: MembershipAdminPlan | null;
  /** Monedas y moneda por defecto (`usePricePolicy`); `null` mientras se consulta. */
  policy: PricePolicy | null;
  busy: boolean;
  /** Guarda; devuelve el error que hay que enseñar, o `null` si fue bien. */
  onSubmit: (input: Omit<PlanInput, 'tierId'>) => Promise<string | null>;
  onCancel: () => void;
}) {
  const t = useTierTexts(variant);
  const tPrice = useTranslations('modBilling.priceFields');
  const locale = useLocale();
  const s = TIER_STYLES[variant];
  const intervalLabel = useIntervalLabel();
  const fallbackCurrency = policy?.defaultCurrency ?? MEMBERSHIP_CURRENCY_OPTIONS[0]!;
  const [draft, setDraft] = useState<PlanDraft>(() => {
    if (plan) return planDraftFromPlan(plan, locale);
    const months = suggestInterval(tier.plans);
    return newPlanDraft({
      tierName: tier.name,
      intervalMonths: months,
      intervalLabel: intervalLabel(months),
      currency: suggestCurrency(tier, tiers, fallbackCurrency),
    });
  });
  const [error, setError] = useState<PlanDraftError | string | null>(null);
  const [marketErrors, setMarketErrors] = useState<PriceDraftError[]>([]);
  const [touched, setTouched] = useState(false);

  // La política llega después del primer pintado: un precio nuevo, sin tocar y
  // sin otros precios de los que copiar la moneda, nace en la del creador.
  useEffect(() => {
    if (!policy || plan || touched) return;
    const currency = suggestCurrency(tier, tiers, policy.defaultCurrency);
    setDraft((d) => (d.currency === currency ? d : { ...d, currency }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando llega la política
  }, [policy]);

  const withMarketPrices = variant === 'full' && Boolean(policy?.platform);

  function update(patch: Partial<PlanDraft>) {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  }

  function changeInterval(months: number) {
    setTouched(true);
    setDraft((d) => ({
      ...d,
      intervalMonths: months,
      name: followPlanName(
        d.name,
        tier.name,
        intervalLabel(d.intervalMonths),
        intervalLabel(months),
      ),
    }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const built = buildPlanInput(draft, { locale, withMarketPrices });
    if (!built.ok) {
      setError(built.error);
      setMarketErrors(built.marketErrors);
      return;
    }
    setError(null);
    setMarketErrors([]);
    setError(await onSubmit(built.input));
  }

  const errorText = (() => {
    switch (error) {
      case null:
        return null;
      case 'name':
        return t('planForm.nameRequired');
      case 'amount':
        return t('planForm.amountInvalid');
      case 'compareAt':
        return t('planForm.compareInvalid');
      case 'trial':
        return t('planForm.trialInvalid');
      case 'market':
        return t('planForm.marketInvalid');
      default:
        return error;
    }
  })();
  const title = plan
    ? t('planForm.editTitle', { name: plan.name })
    : t('planForm.newTitle', { tier: tier.name });
  const decimalMode = stripeDecimals(draft.currency) === 0 ? 'numeric' : 'decimal';

  return (
    <form
      className={s.form}
      onSubmit={(e) => void submit(e)}
      aria-label={title}
      data-testid="nivel-plan-formulario"
    >
      <p className={cn('font-semibold text-text', s.span)}>{title}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nivel-plan-nombre">{t('planForm.nameLabel')}</Label>
        <Input
          id="nivel-plan-nombre"
          className={s.field}
          value={draft.name}
          maxLength={PLAN_NAME_MAX}
          disabled={busy}
          aria-invalid={error === 'name' || undefined}
          aria-describedby="nivel-plan-nombre-ayuda"
          onChange={(e) => update({ name: e.target.value })}
        />
        <p id="nivel-plan-nombre-ayuda" className="text-[13px] text-text-subtle">
          {t('planForm.nameHint')}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nivel-plan-intervalo">{t('planForm.intervalLabel')}</Label>
        <Select
          id="nivel-plan-intervalo"
          className={s.field}
          value={String(draft.intervalMonths)}
          disabled={busy}
          onChange={(e) => changeInterval(Number(e.target.value))}
        >
          {intervalOptions(draft.intervalMonths).map((n) => (
            <option key={n} value={String(n)}>
              {intervalLabel(n)}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nivel-plan-precio">
          {t('planForm.priceLabel', { currency: draft.currency.toUpperCase() })}
        </Label>
        <Input
          id="nivel-plan-precio"
          className={cn(s.field, 'font-semibold tabular-nums')}
          inputMode={decimalMode}
          value={draft.amountRaw}
          disabled={busy}
          aria-invalid={error === 'amount' || undefined}
          onChange={(e) => update({ amountRaw: e.target.value })}
        />
      </div>

      {variant === 'simple' ? (
        <SimpleCurrencyField
          label={t('planForm.currencyLabel')}
          draft={draft}
          initialCurrency={plan?.currency ?? fallbackCurrency}
          busy={busy}
          onCurrency={(currency) => update({ currency })}
        />
      ) : (
        <CurrencyField
          label={t('planForm.currencyLabel')}
          currencies={policy?.currencies ?? MEMBERSHIP_CURRENCY_OPTIONS}
          currency={draft.currency}
          busy={busy}
          renderOption={(c) =>
            policy?.platform && c === policy.settlementCurrency
              ? tPrice('currencyYours', { currency: c.toUpperCase() })
              : c.toUpperCase()
          }
          onCurrency={(currency) => update({ currency })}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nivel-plan-tachado">{t('planForm.compareLabel')}</Label>
        <Input
          id="nivel-plan-tachado"
          className={cn(s.field, 'tabular-nums')}
          inputMode={decimalMode}
          value={draft.compareAtRaw}
          disabled={busy}
          aria-invalid={error === 'compareAt' || undefined}
          onChange={(e) => update({ compareAtRaw: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nivel-plan-prueba">{t('planForm.trialLabel')}</Label>
        <Input
          id="nivel-plan-prueba"
          className={cn(s.field, 'tabular-nums')}
          inputMode="numeric"
          value={draft.trialDays}
          disabled={busy}
          aria-invalid={error === 'trial' || undefined}
          aria-describedby="nivel-plan-prueba-ayuda"
          onChange={(e) => update({ trialDays: e.target.value })}
        />
        <p id="nivel-plan-prueba-ayuda" className="text-[13px] text-text-subtle">
          {t('planForm.trialHint')}
        </p>
      </div>

      {variant === 'full' && policy?.platform ? (
        <div className={cn('flex flex-col gap-3', s.span)}>
          <CurrencyNotice policy={policy} currency={draft.currency} />
          <MarketPricesFields
            idPrefix="nivel-plan"
            currency={draft.currency}
            options={draft.marketPrices}
            errors={marketErrors}
            disabled={busy}
            onOptions={(marketPrices) => update({ marketPrices })}
          />
        </div>
      ) : null}

      <div className={cn('flex items-center gap-2', s.span)}>
        <Switch
          id="nivel-plan-recomendado"
          data-testid="nivel-plan-recomendado"
          checked={draft.isFeatured}
          disabled={busy}
          onCheckedChange={(v) => update({ isFeatured: v })}
        />
        <Label htmlFor="nivel-plan-recomendado">{t('planForm.featuredLabel')}</Label>
      </div>

      {errorText ? (
        <p role="alert" className={cn('text-sm text-danger-700', s.span)}>
          {errorText}
        </p>
      ) : null}

      <div className={cn('flex flex-wrap items-center gap-2', s.span)}>
        <Button
          type="submit"
          className={s.primary}
          disabled={busy}
          data-testid="nivel-plan-guardar"
        >
          {t('planForm.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={variant === 'simple' ? 'h-11 rounded-xl' : undefined}
          disabled={busy}
          onClick={onCancel}
        >
          {t('planForm.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Selector de moneda (con la del precio aunque no esté en la lista). */
function CurrencyField({
  label,
  currencies,
  currency,
  busy,
  className,
  renderOption = (c) => c.toUpperCase(),
  onCurrency,
}: {
  label: string;
  currencies: readonly string[];
  currency: string;
  busy: boolean;
  className?: string;
  renderOption?: (code: string) => string;
  onCurrency: (currency: string) => void;
}) {
  const list = currencies.includes(currency) ? currencies : [...currencies, currency];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="nivel-plan-moneda">{label}</Label>
      <Select
        id="nivel-plan-moneda"
        className={className}
        value={currency}
        disabled={busy}
        onChange={(e) => onCurrency(e.target.value)}
      >
        {list.map((c) => (
          <option key={c} value={c}>
            {renderOption(c)}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Modo sencillo: las monedas en las que el aula puede cobrar y, debajo, «lo
 * que te llega» en vivo, como el editor de precio de «Ventas».
 */
function SimpleCurrencyField({
  label,
  draft,
  initialCurrency,
  busy,
  onCurrency,
}: {
  label: string;
  draft: PlanDraft;
  initialCurrency: string;
  busy: boolean;
  onCurrency: (currency: string) => void;
}) {
  const locale = useLocale();
  const s = TIER_STYLES.simple;
  const { currencies, fees } = usePriceOptions(initialCurrency);
  return (
    <>
      <CurrencyField
        label={label}
        currencies={currencies}
        currency={draft.currency}
        busy={busy}
        className={s.field}
        onCurrency={onCurrency}
      />
      <TakeHomeEstimate
        amount={parseMajorInput(draft.amountRaw, draft.currency, locale)}
        currency={draft.currency}
        fees={fees}
        className={s.span}
      />
    </>
  );
}
