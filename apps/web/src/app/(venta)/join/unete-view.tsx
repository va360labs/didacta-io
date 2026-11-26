'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Vista de /join — estructura del mockup de referencia del operador:
 *   - Sidebar de pago STICKY: cabecera oscura con logo del tenant, selector de
 *     planes (tachado + badge "Mejor valor"), Total hoy, ahorro, primer cargo,
 *     cupón (no si el aula cobra por la plataforma: ahí el pago no los admite),
 *     CTA y caja de cuenta.
 *   - Catálogo: cabecera con contador real, tiles con DATOS REALES (alumnos
 *     activos, cursos, horas), chips de filtrado por categoría real, parrilla
 *     de tarjetas con DETALLE EXPANDIBLE (módulos, profesor, precio suelto),
 *     banner de ahorro, FAQ y testimonial (solo si el admin lo configuró).
 * Cero datos inventados: todo sale de la API del tenant. El pago se pinta
 * DENTRO de la página (Checkout embebido, `AcademyCheckoutStep`) cuando el aula
 * puede, y si no por el redirect a Stripe. La vuelta pregunta si se pagó y
 * resume qué, cuánto y cuándo (`PurchaseThanks`).
 *
 * Aula CON NIVELES (`page.tiers` no vacío): primero una tarjeta por nivel
 * (`TierCards`); su botón abre ESTA MISMA columna de pago con los planes de ese
 * nivel y el catálogo con sus cursos. Un `?plan=` de un nivel entra directo a
 * su pago. Sin niveles, la página es la de siempre.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AcademyMark } from '@/components/academy-mark';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { AcademyCheckoutStep } from '@/components/checkout/academy-checkout-step';
import { CheckoutTrust, useCheckoutSeller } from '@/components/checkout/checkout-trust';
import { PurchaseThanks } from '@/components/checkout/purchase-thanks';
import {
  checkoutOutcome,
  getMembershipCheckoutSession,
  isCheckoutSessionId,
  type CheckoutStart,
  type MembershipCheckoutSessionView,
} from '@/lib/checkout';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage, type StoredSession } from '@/lib/auth-storage';
import { formatDate, formatDuration, formatNumber } from '@/lib/i18n/format';
import { useTenantContext, type TenantContextResponse } from '@/lib/tenant-context';
import {
  formatCents,
  getMembershipPage,
  startMembershipCheckout,
  type MembershipCourse,
  type MembershipPage,
} from '@/lib/membership';
import { intervalDescriptionLabel, intervalSuffixLabel } from './interval-labels';
import { TierCards, defaultPlanId, hasTiers, plansOfTier, tierCatalog } from './tier-cards';
import { couponsAtCheckout, showLocalCurrencyNote } from '@/lib/checkout-hints';
import {
  WithdrawalWaiverCheckbox,
  useWithdrawalWaiver,
} from '@/components/withdrawal-waiver-checkbox';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { getStoredReferralCode, referralsApi, storeReferralCode } from '@/lib/referrals';
import { richHtmlToPlainText } from '@/lib/sanitize-html';

/** Paleta rotativa (por hash del nombre) para los pills de categoría. */
const CATEGORY_STYLES = [
  'bg-brand-100 text-brand-700',
  'bg-success-100 text-success-700',
  'bg-warning-100 text-warning-700',
  'bg-surface-3 text-text-muted',
];
function categoryStyle(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_STYLES[h % CATEGORY_STYLES.length]!;
}

export function UneteView() {
  const t = useTranslations('publicSite');
  const tCommon = useTranslations('common');
  // `/join` sí se pinta en SSR y ahí el singleton de `user-prefs` está vacío a
  // propósito: sin `locale` explícito el servidor pintaría la fecha del primer
  // cargo con el locale por defecto y el cliente la repintaría → mismatch de
  // hidratación visible.
  const locale = useLocale();
  const params = useSearchParams();
  const status = params.get('status');
  const planParam = params.get('plan');
  const returnSessionId = params.get('session_id');
  const returnEmbedded = params.get('checkout') === 'embedded';
  const { tenant } = useTenantContext();

  const [page, setPage] = useState<MembershipPage | null>(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Aula con niveles: cada cuánto paga en cada nivel (`tierId` → `planId`) y el
  // nivel elegido. Sin nivel elegido se ven las tarjetas; con él, el pago de
  // siempre con sus planes.
  const [periodByTier, setPeriodByTier] = useState<Record<string, string>>({});
  const [chosenTierId, setChosenTierId] = useState<string | null>(null);
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('Todos');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const tErrors = useTranslations('errors');
  // Renuncia al desistimiento: sin marcarla no se puede pagar.
  const waiver = useWithdrawalWaiver('membership');
  // Quien pulsa «Continuar» sin marcarla: se le señala la casilla.
  const [waiverNudge, setWaiverNudge] = useState(false);
  const waiverInput = useRef<HTMLInputElement>(null);
  // Pago embebido abierto (la sesión recién creada), o `null` en la página.
  const [embedded, setEmbedded] = useState<Extract<CheckoutStart, { mode: 'embedded' }> | null>(
    null,
  );
  const seller = useCheckoutSeller();
  // Vuelta del pago: lo que la API sabe de esa sesión (undefined = preguntando).
  const [returnView, setReturnView] = useState<MembershipCheckoutSessionView | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (status !== 'success') return;
    if (!isCheckoutSessionId(returnSessionId)) {
      setReturnView(null);
      return;
    }
    let alive = true;
    getMembershipCheckoutSession(returnSessionId)
      .then((v) => alive && setReturnView(v))
      .catch(() => alive && setReturnView(null));
    return () => {
      alive = false;
    };
  }, [status, returnSessionId]);

  const session = useMemo(() => authStorage.getSession(), []);

  // Captura del enlace de referido (?ref=CODE): persiste el código (last-click,
  // TTL de la ventana configurada) y registra el clic. Best-effort: un código
  // inválido o el programa apagado no afectan en nada a la página de venta.
  useEffect(() => {
    const ref = params.get('ref')?.trim().toLowerCase();
    if (!ref || !/^[a-z0-9]{3,32}$/.test(ref)) return;
    storeReferralCode(ref);
    referralsApi
      .track(ref)
      .then(({ attributionWindowDays }) => storeReferralCode(ref, attributionWindowDays))
      .catch(() => {
        // Silencioso: el clic es métrica, nunca UX.
      });
  }, [params]);

  useEffect(() => {
    let cancelled = false;
    getMembershipPage()
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        // `?plan=<id>` viene del modal «Selecciona tu plan» de la portada.
        const pedido = p.plans.find((x) => x.id === planParam);
        if (hasTiers(p)) {
          // Con niveles: cada tarjeta marca su «mejor valor» (o el plan pedido,
          // en la suya). Si el plan pedido es de un nivel, se va directo a su
          // pago: ya lo eligió en la portada.
          const periods: Record<string, string> = {};
          let pedidoTierId: string | null = null;
          for (const tier of p.tiers ?? []) {
            const plans = plansOfTier(p, tier);
            const own = pedido && plans.some((x) => x.id === pedido.id) ? pedido.id : null;
            if (own) pedidoTierId = tier.id;
            const id = own ?? defaultPlanId(plans);
            if (id) periods[tier.id] = id;
          }
          setPeriodByTier(periods);
          setChosenTierId(pedidoTierId);
          setSelectedId(pedidoTierId ? (pedido?.id ?? null) : null);
          return;
        }
        const featured = p.plans.find((x) => x.isFeatured) ?? p.plans[p.plans.length - 1];
        setSelectedId((pedido ?? featured)?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiHttpError && err.status === 404) setNotAvailable(true);
        else setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [planParam]);

  const selected = page?.plans.find((p) => p.id === selectedId) ?? null;

  const checkout = useCallback(
    async (uiMode: 'embedded' | 'hosted' = 'embedded') => {
      if (!selected) return;
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
        const start = await startMembershipCheckout(
          selected.id,
          session?.user.email,
          getStoredReferralCode() ?? undefined,
          waiver.acceptance,
          uiMode,
        );
        if (start.mode === 'embedded') {
          setEmbedded(start);
          setPaying(false);
          return;
        }
        window.location.assign(start.url);
      } catch (err) {
        if (err instanceof ApiHttpError && err.code?.startsWith('CHECKOUT_WITHDRAWAL_WAIVER')) {
          setPayError(apiErrorMessage(err, tErrors));
          waiver.reload();
        } else {
          setPayError(t('unete.payError'));
        }
        setPaying(false);
      }
    },
    [selected, session, t, tErrors, waiver],
  );
  const closeEmbedded = useCallback(() => setEmbedded(null), []);

  /** Botón de una tarjeta de nivel: el pago de siempre, con ese plan marcado. */
  const chooseTier = useCallback((tierId: string, planId: string) => {
    setPeriodByTier((prev) => ({ ...prev, [tierId]: planId }));
    setSelectedId(planId);
    setChosenTierId(tierId);
    setPayError(null);
    window.scrollTo({ top: 0 });
  }, []);
  /** «Cambiar»: vuelta a las tarjetas, con lo que había marcado en cada una. */
  const backToTiers = useCallback(() => {
    setChosenTierId(null);
    setPayError(null);
    setOpenCourseId(null);
    setFilter('Todos');
  }, []);

  // ── Estados de retorno del checkout ────────────────────────────────────────
  if (status === 'success' && (returnSessionId || returnEmbedded)) {
    const outcome =
      returnView === undefined
        ? ('checking' as const)
        : returnView === null
          ? returnEmbedded
            ? ('unknown' as const)
            : ('paid' as const)
          : checkoutOutcome(returnView);
    return (
      <PurchaseThanks
        outcome={outcome}
        summary={
          returnView
            ? {
                kind: 'membership',
                title: returnView.plan?.name ?? tenant?.name ?? null,
                imageUrl: null,
                amount: returnView.amount,
                currency: returnView.currency,
                at: returnView.at,
              }
            : null
        }
        signedIn={session !== null}
        nextPath="/courses"
        retryHref="/join"
      />
    );
  }

  if (status === 'success') {
    return (
      <ReturnCard tone="success" title={t('unete.paymentReceived')}>
        {session ? (
          <>
            <p className="text-text-muted">{t('unete.activatingMembership')}</p>
            <Link href="/courses" className="inline-block">
              <Button>{t('unete.goToCourses')}</Button>
            </Link>
          </>
        ) : (
          <>
            <p className="text-text-muted">
              {t.rich('unete.checkEmail', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <Link href="/signin" className="inline-block">
              <Button variant="ghost">{t('goToSignIn')}</Button>
            </Link>
          </>
        )}
      </ReturnCard>
    );
  }

  if (notAvailable) {
    return (
      <ReturnCard tone="muted" title={t('unete.notAvailableTitle')}>
        <p className="text-text-muted">{t('unete.notAvailableBody')}</p>
        <Link href="/signin" className="inline-block">
          <Button variant="ghost">{t('unete.signIn')}</Button>
        </Link>
      </ReturnCard>
    );
  }

  if (loadError) {
    return (
      <ReturnCard tone="muted" title={t('unete.errorTitle')}>
        <p className="text-text-muted">{t('unete.loadError')}</p>
      </ReturnCard>
    );
  }

  if (!page) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-text-muted">
        {t('loading')}
      </div>
    );
  }

  // Aula con niveles: el nivel elegido (o ninguno: se ven las tarjetas). Con
  // nivel, la columna de pago ofrece solo sus planes y el catálogo, sus cursos.
  // Sin niveles, todo es la página entera, como siempre.
  const tiers = page.tiers ?? [];
  const chosenTier = tiers.find((x) => x.id === chosenTierId) ?? null;
  const plansShown = chosenTier ? plansOfTier(page, chosenTier) : page.plans;
  const catalog = chosenTier
    ? tierCatalog(page, chosenTier)
    : {
        courses: page.courses,
        totalMinutes: page.stats.totalMinutes,
        standaloneTotalCents: page.standaloneTotalCents,
      };

  const trialDays = selected?.trialDays ?? 0;
  const savings =
    selected?.compareAtCents && selected.compareAtCents > selected.amountCents
      ? selected.compareAtCents - selected.amountCents
      : null;
  const firstChargeDate = new Date(Date.now() + trialDays * 86_400_000);
  const catalogSavings =
    catalog.standaloneTotalCents !== null &&
    selected &&
    catalog.standaloneTotalCents > selected.amountCents
      ? catalog.standaloneTotalCents - selected.amountCents
      : null;

  if (embedded && selected) {
    return (
      <AcademyCheckoutStep
        academy={{
          name: tenant?.name ?? '',
          logoUrl: tenant?.logoUrl ?? null,
          logoDisplayMode: tenant?.logoDisplayMode,
        }}
        item={{
          kind: 'membership',
          // Con niveles, lo que compra es el nivel (el plan solo dice cada cuánto paga).
          title: chosenTier
            ? selected.name && selected.name !== chosenTier.name
              ? `${chosenTier.name} · ${selected.name}`
              : chosenTier.name
            : selected.name || page.headline || t('unete.defaultHeadline'),
          detail: `${intervalDescriptionLabel(t, selected.intervalMonths)} · ${formatCents(
            selected.amountCents,
            selected.currency,
            { locale },
          )}${intervalSuffixLabel(t, selected.intervalMonths)}`,
          imageUrl: null,
        }}
        amount={embedded.amountTotal}
        currency={embedded.currency}
        totalNote={
          trialDays > 0
            ? t('unete.trialFirstCharge', {
                days: trialDays,
                amount: formatCents(selected.amountCents, selected.currency, { locale }),
                date: formatDate(firstChargeDate, {
                  locale,
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                }),
              })
            : t('pago.renewsNote')
        }
        seller={seller}
        clientSecret={embedded.clientSecret}
        publishableKey={embedded.publishableKey}
        onBack={closeEmbedded}
        onUnavailable={() => {
          setEmbedded(null);
          void checkout('hosted');
        }}
      />
    );
  }

  // Cobro por la plataforma: el pago no admite cupones, así que no se prometen.
  const coupons = couponsAtCheckout(page);
  // «¿Qué pasa cuando termina la prueba gratis?» solo si algún plan la tiene.
  const offersTrial = page.plans.some((p) => p.trialDays > 0);

  // ── Aula con niveles y ninguno elegido: una tarjeta por nivel ──────────────
  if (tiers.length > 0 && !chosenTier) {
    return (
      <div className="flex flex-col gap-8">
        {status === 'cancel' && (
          <div className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning-700">
            {t('unete.payCanceledTiers')}
          </div>
        )}
        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
          <MembershipHeader tenant={tenant} page={page} />
        </section>
        <TierCards
          page={page}
          tiers={tiers}
          periodByTier={periodByTier}
          onPeriodChange={(tierId, planId) =>
            setPeriodByTier((prev) => ({ ...prev, [tierId]: planId }))
          }
          onChoose={chooseTier}
          freeSignupPath={page.freeSignupPath ?? null}
        />
        <div className="mx-auto w-full max-w-xl">
          <AccountBox session={session} />
        </div>
        <MembershipFaq coupons={coupons} trial={offersTrial} />
        {page.testimonial ? <MembershipTestimonial testimonial={page.testimonial} /> : null}
      </div>
    );
  }

  // Chips de filtrado: categorías REALES presentes en el catálogo.
  // Los precios de referencia de cursos no llevan moneda propia: se muestran
  // comparados contra los planes, así que heredan la del plan elegido (o la
  // del primero de la página).
  const pageCurrency = selected?.currency ?? page.plans[0]?.currency ?? 'eur';

  const categories = [
    ...new Set(catalog.courses.map((c) => c.category).filter((x): x is string => !!x)),
  ];
  const chips = categories.length > 0 ? ['Todos', ...categories] : [];
  const visibleCourses =
    filter === 'Todos' ? catalog.courses : catalog.courses.filter((c) => c.category === filter);

  const totalHours = Math.round(catalog.totalMinutes / 60);

  return (
    <div className="grid items-start gap-9 lg:grid-cols-[minmax(300px,26rem)_minmax(0,1fr)]">
      {/* ══ SIDEBAR DE PAGO (sticky) ══ */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-6">
        {status === 'cancel' && (
          <div className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning-700">
            {t('unete.payCanceled')}
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
          <MembershipHeader tenant={tenant} page={page} />

          <div className="flex flex-col p-6">
            {/* Con niveles: qué nivel se está pagando y cómo volver a elegir. */}
            {chosenTier ? (
              <div
                className="mb-4 flex items-center justify-between gap-3"
                data-testid="nivel-elegido"
              >
                <div className="min-w-0">
                  <p className="text-[13px] text-text-muted">{t('unete.tierChosenLabel')}</p>
                  <p className="truncate text-lg font-bold">{chosenTier.name}</p>
                </div>
                <button
                  type="button"
                  onClick={backToTiers}
                  className="shrink-0 text-sm font-semibold text-brand-700 hover:underline"
                  data-testid="nivel-cambiar"
                >
                  {t('unete.tierChange')}
                </button>
              </div>
            ) : null}

            {/* Selector de planes */}
            {plansShown.length === 0 ? (
              <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-muted">
                {t('unete.noPlans')}
              </p>
            ) : (
              <div
                role="radiogroup"
                aria-label={t('unete.plansAriaLabel')}
                className="flex flex-col gap-2.5"
              >
                {plansShown.map((plan) => {
                  const isSelected = plan.id === selectedId;
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => {
                        setSelectedId(plan.id);
                        if (chosenTier) {
                          setPeriodByTier((prev) => ({ ...prev, [chosenTier.id]: plan.id }));
                        }
                      }}
                      className={
                        isSelected
                          ? 'flex items-center gap-3.5 rounded-xl border-2 border-brand-500 bg-brand-50 px-4 py-3.5 text-left transition'
                          : 'flex items-center gap-3.5 rounded-xl border border-border bg-surface px-4 py-3.5 text-left transition hover:border-border-strong'
                      }
                    >
                      <span
                        aria-hidden="true"
                        className={
                          isSelected
                            ? 'grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-brand-600'
                            : 'h-5 w-5 shrink-0 rounded-full border-2 border-border-strong'
                        }
                      >
                        {isSelected ? (
                          <span className="h-2.5 w-2.5 rounded-full bg-brand-600" />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex flex-wrap items-baseline gap-2">
                          {plan.compareAtCents && plan.compareAtCents > plan.amountCents ? (
                            <span className="text-sm text-text-subtle line-through">
                              {formatCents(plan.compareAtCents, plan.currency, { locale })}
                            </span>
                          ) : null}
                          <span className="text-xl font-bold">
                            {formatCents(plan.amountCents, plan.currency, { locale })}
                          </span>
                          <span className="text-sm text-text-muted">
                            {intervalSuffixLabel(t, plan.intervalMonths)}
                          </span>
                        </span>
                        <span className="mt-0.5 text-[13px] text-text-muted">
                          {intervalDescriptionLabel(t, plan.intervalMonths)}
                          {plan.trialDays > 0
                            ? ` · ${t('unete.planTrialSuffix', { days: plan.trialDays })}`
                            : ''}
                        </span>
                      </span>
                      {plan.isFeatured ? (
                        <span className="shrink-0 rounded-full bg-success-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                          {t('unete.bestValue')}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}

            {selected ? (
              <>
                <div className="my-5 h-px bg-border-soft" />
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">{t('unete.totalToday')}</span>
                  <span className="text-[22px] font-extrabold">
                    {trialDays > 0
                      ? formatCents(0, selected.currency, { locale })
                      : formatCents(selected.amountCents, selected.currency, { locale })}
                  </span>
                </div>
                {showLocalCurrencyNote(selected) ? (
                  <p
                    className="mt-1 text-right text-[13px] text-text-muted"
                    data-testid="local-currency-note"
                  >
                    {t('localCurrencyNote')}
                  </p>
                ) : null}
                {savings ? (
                  <div className="mt-2 flex justify-between text-sm">
                    <span className="text-text-muted">{t('unete.savingsLabel')}</span>
                    <span className="font-bold text-success-700">
                      {t('unete.savingsAmount', {
                        amount: formatCents(savings, selected.currency, { locale }),
                      })}
                    </span>
                  </div>
                ) : null}
                <p className="mt-3.5 text-[13px] leading-5 text-text-muted">
                  {trialDays > 0
                    ? t('unete.trialFirstCharge', {
                        days: trialDays,
                        amount: formatCents(selected.amountCents, selected.currency, { locale }),
                        date: formatDate(firstChargeDate, {
                          locale,
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        }),
                      })
                    : t('unete.firstChargeToday')}
                </p>
                {trialDays > 0 && page.trialLessonLimit > 0 ? (
                  <p className="mt-1.5 text-[13px] leading-5 text-text-muted">
                    {t('unete.trialLessonLimit', { count: page.trialLessonLimit })}
                  </p>
                ) : null}
                {coupons ? (
                  <p className="mt-1.5 text-[13px] text-text-muted">{t('unete.couponHint')}</p>
                ) : null}
              </>
            ) : null}

            <WithdrawalWaiverCheckbox
              className="mt-4"
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

            {payError && (
              <p className="mt-3 rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700">
                {payError}
              </p>
            )}

            {/* Sin la casilla el botón no está `disabled` (no diría nada): está
                «aria-disabled» y, al pulsarlo, señala la casilla. */}
            <Button
              size="lg"
              className={`mt-4 w-full ${!waiver.acceptance ? 'opacity-60' : ''}`}
              disabled={!selected || paying}
              aria-disabled={!waiver.acceptance || undefined}
              aria-describedby={!waiver.acceptance ? 'unete-casilla-pendiente' : undefined}
              onClick={() => void checkout()}
              data-testid="unete-pagar"
            >
              <Icon name="lock" className="mr-2 h-4 w-4" />
              {paying ? t('unete.openingPayment') : t('unete.continueToPayment')}
            </Button>
            {!waiver.acceptance ? (
              <span id="unete-casilla-pendiente" className="sr-only">
                {t('withdrawalWaiver.mustTickToPay')}
              </span>
            ) : null}
            <p className="mt-3 text-center text-xs text-text-subtle">
              {t('unete.securePaymentNote')}
            </p>
            <div className="mt-4 border-t border-border-soft pt-4">
              <CheckoutTrust
                kind="membership"
                seller={seller}
                fallbackName={tenant?.name ?? null}
                variant="compact"
              />
            </div>
          </div>
        </section>

        {/* Caja de cuenta */}
        <AccountBox session={session} />
      </div>

      {/* ══ CATÁLOGO ══ */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-[28px] font-bold tracking-tight">
              {chosenTier
                ? t('unete.tierIncludesTitle', { name: chosenTier.name })
                : t('unete.includesTitle')}
            </h2>
            <p className="mt-2 text-[15px] text-text-muted">{t('unete.includesSubtitle')}</p>
          </div>
          <span className="whitespace-nowrap text-sm text-text-muted">
            {t('unete.coursesCountFull', { count: catalog.courses.length })}
          </span>
        </div>

        {/* Tiles con datos REALES del tenant */}
        <div className="my-5 flex flex-wrap gap-3">
          {page.stats.activeMembers > 0 && (
            <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-surface p-4">
              <div className="text-[26px] font-bold">{formatNumber(page.stats.activeMembers)}</div>
              <div className="mt-0.5 text-[13px] text-text-muted">
                {t('unete.activeMembers', { count: page.stats.activeMembers })}
              </div>
            </div>
          )}
          <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-surface p-4">
            <div className="text-[26px] font-bold">{catalog.courses.length}</div>
            <div className="mt-0.5 text-[13px] text-text-muted">
              {t('unete.coursesIncluded', { count: catalog.courses.length })}
            </div>
          </div>
          {totalHours > 0 && (
            <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-surface p-4">
              <div className="text-[26px] font-bold">
                {t('unete.hoursTile', { hours: totalHours })}
              </div>
              <div className="mt-0.5 text-[13px] text-text-muted">{t('unete.hoursTileLabel')}</div>
            </div>
          )}
        </div>

        {/* Chips de filtrado por categoría real */}
        {chips.length > 1 && (
          <div className="mb-5 flex flex-wrap gap-2">
            {chips.map((chip) => {
              const on = filter === chip;
              return (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setFilter(chip)}
                  className={
                    on
                      ? 'rounded-full border border-brand-600 bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white transition'
                      : 'rounded-full border border-border bg-surface px-4 py-2 text-[13px] font-semibold text-text-muted transition hover:border-border-strong'
                  }
                >
                  {chip === 'Todos' ? t('unete.filterAll') : chip}
                </button>
              );
            })}
          </div>
        )}

        {/* Parrilla con detalle expandible */}
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleCourses.map((course) => {
            const open = openCourseId === course.id;
            return (
              <CourseCardWithDetail
                key={course.id}
                course={course}
                currency={pageCurrency}
                open={open}
                onToggle={() => setOpenCourseId(open ? null : course.id)}
              />
            );
          })}
        </div>

        {/* Banner de ahorro */}
        {catalog.standaloneTotalCents !== null && selected ? (
          <div className="mt-6 flex flex-wrap items-center gap-6 rounded-2xl border border-border bg-surface px-6 py-5">
            <div>
              <div className="text-[13px] text-text-muted">{t('unete.boughtSeparately')}</div>
              <div className="text-[22px] font-bold text-text-subtle line-through">
                {formatCents(catalog.standaloneTotalCents, selected.currency, { locale })}
              </div>
            </div>
            <Icon name="arrow-right" className="h-6 w-6 text-success-600" />
            <div>
              <div className="text-[13px] text-text-muted">{t('unete.withMembership')}</div>
              <div className="text-[22px] font-bold">
                {formatCents(selected.amountCents, selected.currency, { locale })}
                {intervalSuffixLabel(t, selected.intervalMonths)}
              </div>
            </div>
            {catalogSavings ? (
              <span className="ml-auto rounded-full bg-success-100 px-4 py-2.5 text-sm font-bold text-success-700">
                {t('unete.youSave', {
                  amount: formatCents(catalogSavings, selected.currency, { locale }),
                })}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* FAQ: afirmaciones verificables del producto (no datos inventados). */}
        <MembershipFaq coupons={coupons} trial={offersTrial} className="mt-8" />

        {/* Testimonial oscuro (solo si el admin lo configuró) */}
        {page.testimonial && (
          <MembershipTestimonial testimonial={page.testimonial} className="mt-6" />
        )}
      </div>
    </div>
  );
}

/**
 * Cabecera oscura con brillo radial tintado al brand: logo (o iniciales) del
 * aula, titular y subtítulo. La usan la columna de pago y, con niveles, la
 * pantalla de las tarjetas.
 */
function MembershipHeader({
  tenant,
  page,
}: {
  tenant: TenantContextResponse['tenant'];
  page: MembershipPage;
}) {
  const t = useTranslations('publicSite');
  return (
    <div
      className="relative px-7 py-7 text-center"
      style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% -20%, hsl(var(--brand-h) 63% 55% / 0.28), transparent 60%)',
        }}
      />
      <div className="relative">
        {tenant?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={tenant.logoUrl}
            alt={tenant?.name ?? ''}
            className="mx-auto h-11 w-auto rounded-lg bg-white/95 p-1"
          />
        ) : tenant?.name ? (
          // Sin logo, sus iniciales sobre su color (nunca el de Didacta).
          <span className="inline-flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/25 px-3 py-2 text-xl font-extrabold text-white">
            <AcademyMark
              name={tenant.name}
              hue={tenant.brandHue}
              saturation={tenant.brandSaturation}
              size={32}
            />
            {tenant.name}
          </span>
        ) : null}
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
          {page.headline ?? t('unete.defaultHeadline')}
        </h1>
        {page.subheadline ? (
          <p className="mx-4 mt-2 text-sm leading-5 text-white/70">{page.subheadline}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Con quién se compra: la cuenta con la que entró, o que se crea al pagar. */
function AccountBox({ session }: { session: StoredSession | null }) {
  const t = useTranslations('publicSite');
  if (session) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-100 font-bold text-brand-700">
          {(session.user.name ?? session.user.email).slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          {session.user.name ? (
            <p className="truncate text-sm font-semibold">{session.user.name}</p>
          ) : null}
          <p className="truncate text-[13px] text-text-muted">{session.user.email}</p>
        </div>
        <span className="text-right text-xs leading-4 text-text-subtle">
          {t.rich('unete.buyWithAccount', { br: () => <br /> })}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3.5">
      <p className="text-sm text-text-muted">{t('unete.accountAutoCreated')}</p>
      <Link href="/signin" className="text-sm font-semibold text-brand-700 hover:underline">
        {t('unete.haveAccountLink')}
      </Link>
    </div>
  );
}

/**
 * Preguntas frecuentes: afirmaciones verificables del producto. La de la
 * prueba gratis solo sale si algún plan tiene prueba (`trial`): sin ella,
 * la pregunta promete algo que el aula no ofrece.
 */
function MembershipFaq({
  coupons,
  trial,
  className,
}: {
  coupons: boolean;
  trial: boolean;
  className?: string;
}) {
  const t = useTranslations('publicSite');
  const faqs = [
    { q: t('unete.faq1Q'), a: t('unete.faq1A') },
    ...(trial ? [{ q: t('unete.faq2Q'), a: t('unete.faq2A') }] : []),
    { q: t('unete.faq3Q'), a: t('unete.faq3A') },
    {
      q: t('unete.faq4Q'),
      a: coupons ? t('unete.faq4A') : t('unete.faq4ANoCoupon'),
    },
  ];
  return (
    <div className={className}>
      <h3 className="mb-4 text-xl font-bold">{t('unete.faqTitle')}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {faqs.map((faq) => (
          <div key={faq.q} className="rounded-xl border border-border bg-surface px-5 py-4">
            <div className="mb-1.5 text-[15px] font-semibold">{faq.q}</div>
            <div className="text-sm leading-[21px] text-text-muted">{faq.a}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Testimonio oscuro (solo si el admin lo configuró). */
function MembershipTestimonial({
  testimonial,
  className,
}: {
  testimonial: NonNullable<MembershipPage['testimonial']>;
  className?: string;
}) {
  return (
    <figure
      className={`relative overflow-hidden rounded-2xl px-8 py-7 ${className ?? ''}`}
      style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(90% 120% at 100% 0%, hsl(var(--brand-h) 63% 55% / 0.22), transparent 55%)',
        }}
      />
      <div className="relative">
        <div
          aria-hidden="true"
          className="text-[40px] font-extrabold leading-none"
          style={{ color: 'hsl(var(--brand-h) 63% 55%)' }}
        >
          &ldquo;
        </div>
        <blockquote className="mb-4 mt-2 max-w-3xl text-[17px] leading-7 text-white/90">
          {testimonial.quote}
        </blockquote>
        <figcaption>
          <div className="text-[15px] font-semibold text-white">{testimonial.author}</div>
          {testimonial.role ? (
            <div className="text-[13px] text-white/55">{testimonial.role}</div>
          ) : null}
        </figcaption>
      </div>
    </figure>
  );
}

/**
 * Tarjeta de curso + fila de detalle expandible (a ancho completo de la
 * parrilla, como en el mockup). Todo el contenido del detalle es real:
 * descripción sin HTML, módulos, profesor y precio suelto configurado.
 */
function CourseCardWithDetail({
  course,
  currency,
  open,
  onToggle,
}: {
  course: MembershipCourse;
  /** Moneda de los planes de la página: los precios sueltos se comparan contra ellos. */
  currency: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('publicSite');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const meta = [
    course.estimatedMinutes ? formatDuration(course.estimatedMinutes, tCommon) : null,
    course.moduleCount > 0 ? t('unete.modulesCount', { count: course.moduleCount }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={
          open
            ? 'group overflow-hidden rounded-2xl border-2 border-brand-500 bg-surface text-left shadow-sm transition'
            : 'group overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md'
        }
      >
        <div
          className="relative h-[130px] w-full overflow-hidden"
          style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
        >
          {course.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={course.thumbnailUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <Icon name="play" className="h-8 w-8 text-white/70" />
            </div>
          )}
          {course.amountCents !== null ? (
            <span className="absolute right-2.5 top-2.5 rounded-lg bg-black/75 px-2.5 py-1 text-xs font-bold text-white">
              {formatCents(course.amountCents, currency, { locale })}
            </span>
          ) : null}
        </div>
        <div className="p-4">
          {course.category ? (
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${categoryStyle(course.category)}`}
            >
              {course.category}
            </span>
          ) : null}
          <div className="mb-1.5 mt-2.5 text-base font-semibold leading-[22px]">{course.title}</div>
          {meta ? <div className="text-[13px] text-text-muted">{meta}</div> : null}
          <div className="mt-3.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[13px] font-bold text-success-700">
              <Icon name="check" className="h-3.5 w-3.5" />
              {t('unete.included')}
            </span>
            <span className="flex items-center gap-1 text-[13px] font-semibold text-brand-700">
              {open ? t('unete.hide') : t('unete.viewDetail')}
              <Icon
                name="chevron-down"
                className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              />
            </span>
          </div>
        </div>
      </button>

      {open && (
        <div className="col-span-full flex flex-wrap gap-6 rounded-2xl border border-brand-200 bg-surface-2 p-6">
          <div
            className="h-[158px] w-[280px] shrink-0 overflow-hidden rounded-xl"
            style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
          >
            {course.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <Icon name="play" className="h-9 w-9 text-white/70" />
              </div>
            )}
          </div>
          <div className="min-w-[280px] flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              {course.category ? (
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${categoryStyle(course.category)}`}
                >
                  {course.category}
                </span>
              ) : null}
              {meta ? <span className="text-[13px] text-text-muted">{meta}</span> : null}
            </div>
            <h4 className="mb-2 mt-3 text-xl font-bold">{course.title}</h4>
            {/* Texto plano por lo mismo que en la tarjeta del catálogo: la
                descripción es HTML del editor y aquí se lista en compacto. */}
            {course.description ? (
              <p className="mb-3.5 max-w-2xl text-sm leading-[22px]">
                {richHtmlToPlainText(course.description)}
              </p>
            ) : null}
            {course.moduleTitles.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {course.moduleTitles.map((title) => (
                  <span
                    key={title}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-brand-700"
                  >
                    <Icon name="check" className="h-3 w-3 text-success-600" />
                    {title}
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
              {course.teacherName ? (
                <span className="text-[13px] text-text-muted">
                  {t.rich('unete.taughtBy', {
                    teacher: course.teacherName,
                    name: (chunks) => <span className="font-semibold text-text">{chunks}</span>,
                  })}
                </span>
              ) : null}
              {course.amountCents !== null ? (
                <span className="text-[13px] text-text-subtle line-through">
                  {t('unete.standalonePrice', {
                    amount: formatCents(course.amountCents, currency, { locale }),
                  })}
                </span>
              ) : null}
              <span className="flex items-center gap-1.5 text-[13px] font-bold text-success-700">
                <Icon name="check" className="h-3.5 w-3.5" />
                {t('unete.includedInMembership')}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ReturnCard({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'muted';
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
      <span
        className={
          tone === 'success'
            ? 'grid h-12 w-12 place-items-center rounded-full bg-success-100 text-success-700'
            : 'grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted'
        }
      >
        <Icon name={tone === 'success' ? 'check' : 'alert'} className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
    </div>
  );
}
