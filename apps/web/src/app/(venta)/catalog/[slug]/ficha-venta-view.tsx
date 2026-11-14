'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Ficha pública de venta: portada, descripción y las opciones de compra
 * reales del curso (precio único o multi-formato con destacada). El CTA
 * abre el pago ANÓNIMO de Stripe DENTRO de la ficha (`AcademyCheckoutStep`:
 * cabecera, color y resumen del aula) cuando el aula puede; si no, el
 * redirect de siempre. La cuenta del comprador se crea tras el pago con el
 * email confirmado en la pasarela.
 *
 * El curso llega pintado desde el servidor (`initialCourse`, con su
 * descripción ya saneada en `description`): así está en el HTML que lee un
 * buscador. Si el servidor no pudo traerlo, se resuelve aquí por slug contra
 * el catálogo público, como antes; si no está a la venta o no existe, se
 * ofrece volver al catálogo.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AcademyMark } from '@/components/academy-mark';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { AcademyCheckoutStep } from '@/components/checkout/academy-checkout-step';
import { CheckoutTrust, useCheckoutSeller } from '@/components/checkout/checkout-trust';
import type { CheckoutStart } from '@/lib/checkout';
import {
  WithdrawalWaiverCheckbox,
  useWithdrawalWaiver,
} from '@/components/withdrawal-waiver-checkbox';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { authStorage } from '@/lib/auth-storage';
import { formatDuration } from '@/lib/i18n/format';
import { useTenantContext } from '@/lib/tenant-context';
import { formatCents } from '@/lib/membership';
import { showLocalCurrencyNote } from '@/lib/checkout-hints';
import { sanitizeRichHtml } from '@/lib/sanitize-html';
import { getStoredReferralCode } from '@/lib/referrals';
import { captureReferralFromLocation } from '@/lib/referral-links';
import {
  featuredOption,
  getPublicCatalog,
  startPublicCheckout,
  type CatalogCourse,
} from '@/lib/catalog';

interface Props {
  /** El curso, ya leído en el servidor. Sin él, se pide desde el navegador. */
  initialCourse?: CatalogCourse;
  /**
   * La descripción pintada en el servidor con el HTML que saneó la API. Solo
   * cuenta con `initialCourse`; en el camino del navegador se sanea aquí.
   */
  description?: ReactNode;
  /** Nombre y logo del aula para la caja de compra mientras llega su contexto. */
  initialBrand?: {
    name: string;
    logoUrl: string | null;
    brandHue?: number | null;
    brandSaturation?: number | null;
  };
}

export function FichaVentaView({ initialCourse, description, initialBrand }: Props = {}) {
  const t = useTranslations('publicSite');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  // Renuncia al desistimiento: sin marcarla no se puede pagar.
  const waiver = useWithdrawalWaiver('course');
  // Área pública: se pinta en SSR, donde el singleton de `user-prefs` está
  // vacío. Sin `locale` explícito el importe del servidor y el del cliente no
  // coinciden → mismatch de hidratación.
  const locale = useLocale();
  const params = useParams<{ slug: string }>();
  const { tenant: tenantCtx } = useTenantContext();
  const tenant = tenantCtx ?? initialBrand ?? null;

  const [course, setCourse] = useState<CatalogCourse | null | undefined>(initialCourse);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialCourse ? (featuredOption(initialCourse.options)?.id ?? null) : null,
  );
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  // Pago embebido abierto (la sesión recién creada), o `null` en la ficha.
  const [checkout, setCheckout] = useState<Extract<CheckoutStart, { mode: 'embedded' }> | null>(
    null,
  );
  // Quien pulsa «Comprar» sin marcar la casilla: se le señala la casilla.
  const [waiverNudge, setWaiverNudge] = useState(false);
  const waiverInput = useRef<HTMLInputElement>(null);
  const seller = useCheckoutSeller();

  // Si hay sesión (alguien logueado llegó a la página pública), su email
  // precarga el checkout; el provisioning lo reconocerá y no duplicará cuenta.
  const session = useMemo(() => authStorage.getSession(), []);

  // Enlace de referido (?ref=): vale en cualquier página de venta, no solo en
  // /join. Se guarda y viaja en el checkout de este curso.
  useEffect(() => {
    captureReferralFromLocation(window.location.search);
  }, []);

  useEffect(() => {
    // Ya viene del servidor: no se vuelve a pedir.
    if (initialCourse) return;
    let cancelled = false;
    getPublicCatalog()
      .then((r) => {
        if (cancelled) return;
        const found = r.courses.find((c) => c.slug === params.slug) ?? null;
        setCourse(found);
        setSelectedId(found ? (featuredOption(found.options)?.id ?? null) : null);
      })
      .catch(() => {
        if (!cancelled) setCourse(null);
      });
    return () => {
      cancelled = true;
    };
  }, [params.slug, initialCourse]);

  const selected = course?.options.find((o) => o.id === selectedId) ?? null;

  const comprar = useCallback(
    async (uiMode: 'embedded' | 'hosted' = 'embedded') => {
      if (!course || !selected) return;
      if (!waiver.acceptance) {
        // El botón no está apagado sin más: dice por qué y lleva a la casilla.
        setWaiverNudge(true);
        waiverInput.current?.focus();
        waiverInput.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      setPaying(true);
      setPayError(null);
      try {
        const start = await startPublicCheckout(course.id, {
          optionId: selected.id,
          email: session?.user.email,
          withdrawalWaiver: waiver.acceptance,
          referralCode: getStoredReferralCode() ?? undefined,
          // Lo que tiene delante: si el precio cambió con la página abierta, la
          // API no cobra otro importe (antes enseñaba 29 € y se cobró 1 €).
          expectedPrice: { unitAmount: selected.unitAmount, currency: selected.currency },
          uiMode,
        });
        if (start.mode === 'embedded') {
          setCheckout(start);
          setPaying(false);
          return;
        }
        window.location.assign(start.url);
      } catch (err) {
        if (err instanceof ApiHttpError && err.code?.startsWith('CHECKOUT_WITHDRAWAL_WAIVER')) {
          setPayError(apiErrorMessage(err, tErrors));
          waiver.reload();
        } else if (err instanceof ApiHttpError && err.code === 'BILLING_PRICE_CHANGED') {
          setPayError(t('ficha.priceChanged'));
          // Se vuelve a pedir el curso con sus precios de ahora; la opción
          // elegida se mantiene si sigue existiendo.
          const fresh = await getPublicCatalog()
            .then((r) => r.courses.find((c) => c.id === course.id) ?? null)
            .catch(() => null);
          if (fresh) {
            setCourse(fresh);
            if (!fresh.options.some((o) => o.id === selected.id)) {
              setSelectedId(featuredOption(fresh.options)?.id ?? null);
            }
          }
        } else {
          setPayError(t('ficha.payError'));
        }
        setPaying(false);
      }
    },
    [course, selected, session, t, tErrors, waiver],
  );

  const closeCheckout = useCallback(() => setCheckout(null), []);

  if (course === undefined) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-text-muted">
        {t('loading')}
      </div>
    );
  }

  if (course === null) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted">
          <Icon name="alert" className="h-6 w-6" />
        </span>
        <h1 className="text-xl font-bold">{t('ficha.notAvailableTitle')}</h1>
        <p className="text-text-muted">{t('ficha.notAvailableBody')}</p>
        <Button asChild variant="ghost">
          <Link href="/catalog">{t('backToCatalog')}</Link>
        </Button>
      </div>
    );
  }

  if (checkout && selected) {
    const shownPrice = selected.unitAmount;
    const priceChanged =
      checkout.amountTotal !== null &&
      checkout.currency?.toLowerCase() === selected.currency.toLowerCase() &&
      checkout.amountTotal !== shownPrice;
    return (
      <AcademyCheckoutStep
        academy={{
          name: tenant?.name ?? '',
          logoUrl: tenant?.logoUrl ?? null,
          logoDisplayMode: tenantCtx?.logoDisplayMode,
        }}
        item={{
          kind: 'course',
          title: course.title,
          detail: selected.name || null,
          imageUrl: course.thumbnailUrl,
        }}
        amount={checkout.amountTotal}
        currency={checkout.currency}
        totalNote={priceChanged ? t('pago.priceUpdated') : t('ficha.oneTimePayment')}
        seller={seller}
        clientSecret={checkout.clientSecret}
        publishableKey={checkout.publishableKey}
        onBack={closeCheckout}
        onUnavailable={() => {
          setCheckout(null);
          void comprar('hosted');
        }}
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-5xl items-start gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(300px,24rem)]">
      {/* ══ FICHA ══ */}
      <div className="space-y-6">
        <nav className="text-sm text-text-subtle">
          <Link href="/catalog" className="hover:underline">
            {t('ficha.breadcrumbCourses')}
          </Link>{' '}
          / <span className="text-text-muted">{course.title}</span>
        </nav>

        {course.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={course.thumbnailUrl}
            alt=""
            className="aspect-video w-full rounded-2xl border border-border object-cover"
          />
        ) : null}

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-text-subtle">
            {course.category ? (
              <span className="rounded-full bg-surface-3 px-2.5 py-0.5 text-text-muted">
                {course.category}
              </span>
            ) : null}
            {course.estimatedMinutes ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="clock" size={14} />
                {formatDuration(course.estimatedMinutes, tCommon)}
              </span>
            ) : null}
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-text">
            {course.title}
          </h1>
          {/* La descripción se guarda como HTML (la escribe el editor rich-text
              del formador), así que hay que renderizarla como tal — igual que
              hace la ficha autenticada en (app)/courses/[slug]. Pintándola como
              texto plano, el comprador veía las etiquetas «<p>» en crudo. */}
          {initialCourse ? (
            (description ?? null)
          ) : course.description ? (
            <div
              className="prose prose-slate max-w-none leading-relaxed prose-p:text-text-muted prose-a:text-brand-700"
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(course.description) }}
            />
          ) : null}
        </div>

        <Temario syllabus={course.syllabus ?? []} />

        <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-muted">
          {t.rich('ficha.afterPayment', {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </div>
      </div>

      {/* ══ CAJA DE COMPRA (sticky) ══ */}
      <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
          <div
            className="relative px-6 py-5 text-center"
            style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
          >
            {tenant?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tenant.logoUrl}
                alt={tenant?.name ?? ''}
                className="mx-auto h-9 w-auto rounded-lg bg-white/95 p-1"
              />
            ) : (
              // Sin logo, sus iniciales sobre su color (nunca el de Didacta).
              <span className="inline-flex items-center gap-2.5 text-lg font-extrabold text-white">
                {tenant?.name ? (
                  <AcademyMark
                    name={tenant.name}
                    hue={tenant.brandHue}
                    saturation={tenant.brandSaturation}
                    size={36}
                  />
                ) : null}
                {tenant?.name ?? ''}
              </span>
            )}
            <p className="mt-2 text-sm text-white/70">{t('ficha.oneTimePayment')}</p>
          </div>

          <div className="flex flex-col gap-4 p-6">
            {course.options.length > 1 ? (
              <div
                role="radiogroup"
                aria-label={t('ficha.formatsAriaLabel')}
                className="flex flex-col gap-2.5"
              >
                {course.options.map((option) => {
                  const isSelected = option.id === selectedId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedId(option.id)}
                      className={
                        isSelected
                          ? 'rounded-xl border-2 border-brand-600 bg-brand-50 px-4 py-3 text-left'
                          : 'rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-surface-2'
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-text">
                          {option.name || t('ficha.defaultOptionName')}
                          {option.isFeatured ? (
                            <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                              {t('ficha.recommended')}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-baseline gap-1.5">
                          {option.compareAtAmount ? (
                            <span className="text-xs text-text-subtle line-through">
                              {formatCents(option.compareAtAmount, option.currency, { locale })}
                            </span>
                          ) : null}
                          <span className="font-bold text-text">
                            {formatCents(option.unitAmount, option.currency, { locale })}
                          </span>
                        </span>
                      </div>
                      {option.perks.length > 0 ? (
                        <ul className="mt-2 space-y-1">
                          {option.perks.map((perk) => (
                            <li
                              key={perk}
                              className="flex items-start gap-1.5 text-xs text-text-muted"
                            >
                              <Icon name="check" size={13} className="mt-0.5 shrink-0" />
                              {perk}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : selected ? (
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-3xl font-bold text-text" data-testid="precio-curso">
                  {formatCents(selected.unitAmount, selected.currency, { locale })}
                </span>
                {selected.compareAtAmount ? (
                  <span className="text-text-subtle line-through">
                    {formatCents(selected.compareAtAmount, selected.currency, { locale })}
                  </span>
                ) : null}
                {selected.discountPercent ? (
                  <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-semibold text-success-700">
                    {t('discountBadge', { percent: selected.discountPercent })}
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* Solo si el servidor lo afirma: cobro por la plataforma y precio en
                la moneda del creador, que el pago convierte a la del alumno. */}
            {showLocalCurrencyNote(selected) ? (
              <p
                className="-mt-2 text-center text-[13px] text-text-muted"
                data-testid="local-currency-note"
              >
                {t('localCurrencyNote')}
              </p>
            ) : null}

            <WithdrawalWaiverCheckbox
              waiver={waiver.waiver}
              failed={waiver.failed}
              checked={waiver.checked}
              onCheckedChange={(value) => {
                waiver.setChecked(value);
                if (value) setWaiverNudge(false);
              }}
              onRetry={waiver.reload}
              nudge={waiverNudge}
              inputRef={waiverInput}
            />

            {payError ? (
              <p className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
                {payError}
              </p>
            ) : null}

            {/* Sin la casilla el botón no está `disabled` (no diría nada): está
                «aria-disabled» y, al pulsarlo, señala la casilla. */}
            <Button
              size="lg"
              onClick={() => void comprar()}
              disabled={!selected || paying}
              aria-disabled={!waiver.acceptance || undefined}
              aria-describedby={!waiver.acceptance ? 'ficha-casilla-pendiente' : undefined}
              className={!waiver.acceptance ? 'opacity-60' : undefined}
              data-testid="ficha-comprar"
            >
              {paying ? t('ficha.openingPayment') : t('ficha.buyNow')}
            </Button>
            {!waiver.acceptance ? (
              <span id="ficha-casilla-pendiente" className="sr-only">
                {t('withdrawalWaiver.mustTickToPay')}
              </span>
            ) : null}
            <CheckoutTrust
              kind="course"
              seller={seller}
              fallbackName={tenant?.name ?? null}
              variant="compact"
            />
            <p className="text-center text-xs text-text-subtle">{t('ficha.securePayment')}</p>
          </div>
        </section>

        <p className="text-center text-sm text-text-subtle">
          {t.rich('ficha.haveAccountToBuy', {
            link: (chunks) => (
              <Link href="/signin" className="font-medium text-brand-700 hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </aside>
    </div>
  );
}

/**
 * Lo que se lleva quien compra: los títulos de las lecciones, en orden. Sin
 * descripción, era lo único que faltaba para saber qué es el curso (ensayo
 * general del 14-nov). Con varias secciones, cada una con su título; la
 * numeración de las lecciones sigue de corrido.
 */
function Temario({ syllabus }: { syllabus: Array<{ title: string; lessons: string[] }> }) {
  const t = useTranslations('publicSite');
  const total = syllabus.reduce((n, s) => n + s.lessons.length, 0);
  if (total === 0) return null;
  let n = 0;
  return (
    <section
      className="rounded-2xl border border-border bg-surface p-5"
      aria-labelledby="ficha-temario"
      data-testid="ficha-temario"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ficha-temario" className="text-lg font-bold text-text">
          {t('ficha.syllabusTitle')}
        </h2>
        <span className="text-sm text-text-muted">
          {t('ficha.syllabusCount', { count: total })}
        </span>
      </div>
      {syllabus.map((section, i) => (
        <div key={`${i}-${section.title}`} className="mt-3">
          {syllabus.length > 1 ? (
            <h3 className="mb-1.5 text-sm font-semibold text-text-muted">{section.title}</h3>
          ) : null}
          <ol className="space-y-1.5">
            {section.lessons.map((lesson, j) => {
              n += 1;
              return (
                <li key={`${j}-${lesson}`} className="flex gap-3 text-[15px] text-text">
                  <span className="w-6 shrink-0 text-right tabular-nums text-text-subtle">{n}</span>
                  <span className="min-w-0 break-words">{lesson}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}
