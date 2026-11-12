'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { PriceFields } from '@/components/admin/price-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatStripeMinor } from '@/lib/i18n/format';
import {
  buildPrice,
  usePricePolicy,
  type CurrencyOptionDraft,
  type PriceDraftError,
} from '@/lib/pricing';
import { OWN_KEYS_PRICE_CURRENCIES, minorToInput } from '@/lib/stripe-currencies';
import { billingApi, type BillingProduct } from '@/modules/billing';

/**
 * Precio del curso en su propia ficha: importe y moneda, sin `price_…`.
 *
 * `mod.billing` es un módulo built-in (como el DRIP de al lado): su UI vive en
 * `apps/web`. Guarda con `POST`/`PATCH /modules/billing/products`; cambiar el
 * importe, la moneda o los precios por mercado crea un Price nuevo en Stripe
 * sobre el mismo Product (las compras ya hechas no cambian).
 *
 * Solo para la administración del aula: con otro rol la API responde 403 y el
 * panel no se pinta. Un curso con varias opciones de compra se gestiona en
 * Productos (aquí solo el precio único).
 */
export function PricePanel({ courseId, published }: { courseId: string; published: boolean }) {
  const t = useTranslations('modBilling.coursePrice');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const policy = usePricePolicy(OWN_KEYS_PRICE_CURRENCIES);
  const [state, setState] = useState<'loading' | 'hidden' | 'ready'>('loading');
  const [products, setProducts] = useState<BillingProduct[]>([]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [options, setOptions] = useState<CurrencyOptionDraft[]>([]);
  const [errors, setErrors] = useState<PriceDraftError[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const product = products.length === 1 && !products[0]!.name ? products[0]! : null;
  const severalOptions = products.length > 1 || (products.length === 1 && !product);

  function fill(p: BillingProduct | null) {
    if (!p) return;
    setAmount(minorToInput(p.unitAmount, p.currency, locale));
    setCurrency(p.currency);
    setOptions(
      Object.entries(p.currencyOptions ?? {}).map(([code, minor]) => ({
        currency: code,
        amount: minorToInput(minor, code, locale),
      })),
    );
  }

  async function load() {
    const token = authStorage.getAccessToken();
    if (!token) return setState('hidden');
    try {
      const { products: all } = await billingApi.listProducts(token);
      const mine = all.filter((p) => p.courseId === courseId);
      setProducts(mine);
      fill(mine.length === 1 && !mine[0]!.name ? mine[0]! : null);
      setState('ready');
    } catch (e) {
      // 403 = no es administración del aula: el precio no es cosa suya.
      setState(e instanceof ApiHttpError && e.status === 403 ? 'hidden' : 'ready');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cambiar de curso
  }, [courseId]);

  if (state === 'hidden' || !policy) return null;
  if (state === 'loading') return <div className="skeleton h-40 w-full" />;

  const shownCurrency = currency ?? policy.defaultCurrency;

  async function save() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const built = buildPrice({ amount, currency: shownCurrency, options }, locale);
    setErrors(built.errors);
    setMessage(null);
    if (built.errors.length || built.amountCents === null) return;
    setBusy(true);
    try {
      const price = {
        amountCents: built.amountCents,
        currency: shownCurrency,
        currencyOptions: built.currencyOptions,
      };
      const res = product
        ? await billingApi.updateProduct(token, product.id, price)
        : await billingApi.createProduct(token, courseId, price);
      setProducts([res.product]);
      fill(res.product);
      setMessage({ ok: true, text: t('saved') });
    } catch (e) {
      setMessage({
        ok: false,
        text: e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    const token = authStorage.getAccessToken();
    if (!token || !product) return;
    setBusy(true);
    try {
      const res = await billingApi.updateProduct(token, product.id, { active: !product.active });
      setProducts([res.product]);
    } catch (e) {
      setMessage({
        ok: false,
        text: e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>
          {policy.platform ? t('descriptionPlatform') : t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {severalOptions ? (
          <p className="text-sm text-text-subtle">
            {t('optionsElsewhere')}{' '}
            <Link href={'/admin/billing/products' as never} className="text-brand-500 underline">
              {t('optionsLink')}
            </Link>
          </p>
        ) : (
          <>
            <p className="text-sm text-text" data-testid="course-price-status">
              {product
                ? product.active
                  ? t('currentPrice', {
                      price: formatStripeMinor(product.unitAmount, product.currency),
                    })
                  : t('paused')
                : t('notForSale')}
            </p>
            {!product && !published ? (
              <p className="text-sm text-text-subtle">{t('publishFirst')}</p>
            ) : (
              <>
                <PriceFields
                  idPrefix="course-price"
                  policy={policy}
                  amount={amount}
                  currency={shownCurrency}
                  options={options}
                  errors={errors}
                  disabled={busy}
                  onAmount={setAmount}
                  onCurrency={setCurrency}
                  onOptions={setOptions}
                />
                {policy.platform && !policy.ready ? (
                  <p className="text-sm text-text-subtle">
                    {t('connectFirst')}{' '}
                    <Link href={'/admin/cobros' as never} className="text-brand-500 underline">
                      {t('connectLink')}
                    </Link>
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={() => void save()} disabled={busy}>
                    {busy ? t('saving') : product ? t('save') : t('putForSale')}
                  </Button>
                  {product ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void toggleActive()}
                      disabled={busy}
                    >
                      {product.active ? t('pause') : t('resume')}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
        {message ? (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={message.ok ? 'text-sm text-success-700' : 'text-sm text-danger-700'}
          >
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
