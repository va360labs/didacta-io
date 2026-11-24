'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type Course } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents, formatList } from '@/lib/i18n/format';
import {
  membershipAdminApi,
  type MembershipAdminPlan,
  type MembershipAdminTier,
  type MembershipAdminTiers,
  type PlanInput,
} from '@/lib/membership';
import { usePricePolicy } from '@/lib/pricing';
import { cn } from '@/lib/utils';
import { PlanForm, useIntervalLabel } from './plan-form';
import { TierForm } from './tier-form';
import { MEMBERSHIP_CURRENCY_OPTIONS, moveTier, tierCourses, type TierDraft } from './tier-helpers';
import { TIER_STYLES, useTierTexts, type TierTexts, type TiersVariant } from './tier-ui';

/** Formulario abierto: uno solo a la vez (sus campos llevan ids fijos). */
type OpenForm =
  | { kind: 'tier-new'; isFree: boolean }
  | { kind: 'tier-edit'; tierId: string }
  | { kind: 'plan'; tierId: string; planId: string | null }
  | null;

/** Error de una acción de la lista, pegado a la tarjeta de su nivel. */
interface CardError {
  tierId: string;
  text: string;
  /** El nivel tiene gente dentro (409): se ofrece apagarlo en su lugar. */
  inUse: boolean;
}

/** Ajustes del registro gratis (la puerta del nivel gratis). */
const FREE_SIGNUP_SETTINGS = '/admin/settings?tab=registration';

/**
 * Editor de los NIVELES de la membresía (Básico, Pro, Gratis…): cada nivel con
 * sus cursos y sus precios (una periodicidad cada uno). El mismo en la página
 * completa de la membresía (`variant="full"`, tarjeta como sus hermanas) y en
 * «Ventas» del modo sencillo (`variant="simple"`). Todo sale de la API: los
 * niveles (`GET /membership/admin/tiers`) y los cursos publicados del aula.
 *
 * Si la API no ofrece los niveles (módulo apagado o API anterior), no pinta
 * nada: la pantalla sigue como antes.
 */
export function TiersEditor({
  variant,
  className,
  onData,
  onMutated,
}: {
  variant: TiersVariant;
  className?: string;
  /** Cada vez que llegan los niveles (al cargar y tras cada cambio). */
  onData?: (data: MembershipAdminTiers) => void;
  /** Tras un cambio guardado: la pantalla puede refrescar lo suyo (precios, oferta). */
  onMutated?: () => void;
}) {
  const t = useTierTexts(variant);
  const tErrors = useTranslations('errors');
  const policy = usePricePolicy(MEMBERSHIP_CURRENCY_OPTIONS);
  const [data, setData] = useState<MembershipAdminTiers | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
  const [open, setOpen] = useState<OpenForm>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cardError, setCardError] = useState<CardError | null>(null);

  const onDataRef = useRef(onData);
  const onMutatedRef = useRef(onMutated);
  useEffect(() => {
    onDataRef.current = onData;
    onMutatedRef.current = onMutated;
  });
  useEffect(() => {
    if (data) onDataRef.current?.(data);
  }, [data]);

  useEffect(() => {
    const bearer = authStorage.getAccessToken();
    if (!bearer) return;
    let alive = true;
    Promise.all([
      membershipAdminApi.listTiers(bearer),
      coursesApi.list({ status: 'PUBLISHED' }),
    ]).then(
      ([tiers, list]) => {
        if (!alive) return;
        setData(tiers);
        setCourses(list);
        setState('ready');
      },
      (e: unknown) => {
        if (!alive) return;
        const missing = e instanceof ApiHttpError && (e.status === 403 || e.status === 404);
        setState(missing ? 'unavailable' : 'error');
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const openForm = useCallback((next: OpenForm) => {
    setOpen(next);
    setNotice(null);
    setCardError(null);
  }, []);

  /**
   * Ejecuta un cambio y recarga los niveles. Devuelve el error ya traducido
   * (para que lo enseñe el formulario) o `null` si fue bien.
   */
  async function mutate(
    action: (bearer: string) => Promise<string>,
    onError?: (e: unknown, text: string) => void,
  ): Promise<string | null> {
    const bearer = authStorage.getAccessToken();
    if (!bearer) return tErrors('sessionExpired');
    setBusy(true);
    setNotice(null);
    setCardError(null);
    try {
      const ok = await action(bearer);
      setData(await membershipAdminApi.listTiers(bearer));
      setNotice(ok);
      onMutatedRef.current?.();
      return null;
    } catch (e) {
      const text = apiErrorMessage(e, tErrors);
      onError?.(e, text);
      return text;
    } finally {
      setBusy(false);
    }
  }

  /** Error de una acción de la lista: en la tarjeta de su nivel. */
  const onCardError = (tierId: string) => (e: unknown, text: string) =>
    setCardError({
      tierId,
      text,
      inUse: e instanceof ApiHttpError && e.code === 'MEMBERSHIP_TIER_IN_USE',
    });

  async function submitTier(draft: TierDraft, tier: MembershipAdminTier | null, isFree: boolean) {
    const name = draft.name.trim();
    const description = draft.description.trim() || null;
    const error = await mutate(async (bearer) => {
      if (tier) {
        await membershipAdminApi.updateTier(bearer, tier.id, {
          name,
          description,
          ...(tier.allCourses ? {} : { courseIds: draft.courseIds }),
        });
        return t('notices.saved');
      }
      const created = await membershipAdminApi.createTier(bearer, {
        name,
        description,
        isFree,
        allCourses: draft.content === 'all',
        ...(draft.content === 'choose' ? { courseIds: draft.courseIds } : {}),
      });
      if (isFree) {
        // La API enciende el registro gratis: el menú del aula lo tiene que saber.
        window.dispatchEvent(new Event('didacta:modules-changed'));
        return t('notices.createdFree');
      }
      return created.plans.length > 0
        ? t('notices.createdWithPrices', { name: created.name })
        : t('notices.created', { name: created.name });
    });
    if (!error) setOpen(null);
    return error;
  }

  async function submitPlan(
    tier: MembershipAdminTier,
    plan: MembershipAdminPlan | null,
    input: Omit<PlanInput, 'tierId'>,
  ) {
    const error = await mutate(async (bearer) => {
      if (plan) {
        await membershipAdminApi.updatePlan(bearer, plan.id, input);
        return t('notices.priceSaved');
      }
      await membershipAdminApi.createPlan(bearer, { ...input, tierId: tier.id });
      return t('notices.priceCreated');
    });
    if (!error) setOpen(null);
    return error;
  }

  if (state === 'unavailable') return null;

  const tiers = data?.tiers ?? [];
  const ids = tiers.map((tier) => tier.id);
  const hasFree = tiers.some((tier) => tier.isFree);
  const hasPaid = tiers.some((tier) => !tier.isFree);
  const s = TIER_STYLES[variant];

  const body: ReactNode =
    state === 'loading' ? (
      <p className="text-sm text-text-muted">{t('loading')}</p>
    ) : state === 'error' || !data ? (
      <p role="alert" className="text-sm text-danger-700">
        {t('loadError')}
      </p>
    ) : (
      <>
        {notice ? (
          <p
            role="status"
            className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success-700"
            data-testid="niveles-aviso"
          >
            {notice}
          </p>
        ) : null}

        {tiers.length === 0 ? (
          <p className="text-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tiers.map((tier, index) => (
              <TierCard
                key={tier.id}
                variant={variant}
                tier={tier}
                tiers={tiers}
                courses={courses}
                freeSignupOpen={data.freeSignup.open}
                manualReview={data.freeSignup.manualReview === true}
                onToggleManualReview={() =>
                  void mutate(async (bearer) => {
                    const next = data.freeSignup.manualReview !== true;
                    await membershipAdminApi.updateTier(bearer, tier.id, { manualReview: next });
                    return next ? t('notices.manualReviewOn') : t('notices.manualReviewOff');
                  }, onCardError(tier.id))
                }
                first={index === 0}
                last={index === tiers.length - 1}
                open={open}
                busy={busy}
                error={cardError?.tierId === tier.id ? cardError : null}
                policy={policy}
                onOpen={openForm}
                onCloseForm={() => setOpen(null)}
                onSubmitTier={(draft) => submitTier(draft, tier, tier.isFree)}
                onSubmitPlan={(plan, input) => submitPlan(tier, plan, input)}
                onMove={(delta) => {
                  const order = moveTier(ids, tier.id, delta);
                  if (!order) return;
                  void mutate(async (bearer) => {
                    await membershipAdminApi.reorderTiers(bearer, order);
                    return t('notices.reordered');
                  }, onCardError(tier.id));
                }}
                onToggle={() =>
                  void mutate(async (bearer) => {
                    await membershipAdminApi.updateTier(bearer, tier.id, { active: !tier.active });
                    return tier.active
                      ? t('notices.turnedOff', { name: tier.name })
                      : t('notices.turnedOn', { name: tier.name });
                  }, onCardError(tier.id))
                }
                onDelete={() =>
                  void mutate(async (bearer) => {
                    await membershipAdminApi.deleteTier(bearer, tier.id);
                    if (open && open.kind !== 'tier-new' && open.tierId === tier.id) setOpen(null);
                    return t('notices.deleted');
                  }, onCardError(tier.id))
                }
                onTogglePlan={(plan) =>
                  void mutate(async (bearer) => {
                    await membershipAdminApi.updatePlan(bearer, plan.id, { active: !plan.active });
                    return plan.active ? t('notices.priceTurnedOff') : t('notices.priceTurnedOn');
                  }, onCardError(tier.id))
                }
                onDeletePlan={(plan) =>
                  void mutate(async (bearer) => {
                    await membershipAdminApi.deletePlan(bearer, plan.id);
                    if (open?.kind === 'plan' && open.planId === plan.id) setOpen(null);
                    return t('notices.priceDeleted');
                  }, onCardError(tier.id))
                }
              />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            className={s.primary}
            disabled={busy}
            data-testid="nivel-nuevo"
            onClick={() => openForm({ kind: 'tier-new', isFree: false })}
          >
            <Icon name="plus" size={16} />
            {t('newTier')}
          </Button>
          {!hasFree ? (
            <Button
              type="button"
              variant="secondary"
              className={s.secondary}
              disabled={busy}
              data-testid="nivel-gratis-nuevo"
              onClick={() => openForm({ kind: 'tier-new', isFree: true })}
            >
              {t('newFreeTier')}
            </Button>
          ) : null}
        </div>
        {!hasFree && open?.kind !== 'tier-new' ? (
          <p className="text-[13px] text-text-subtle">{t('freeTierHint')}</p>
        ) : null}

        {open?.kind === 'tier-new' ? (
          <TierForm
            key={open.isFree ? 'free' : 'paid'}
            variant={variant}
            tier={null}
            isFree={open.isFree}
            courses={courses}
            showLegacyNotice={!hasPaid && data.legacyPlanCount > 0}
            busy={busy}
            onSubmit={(draft) => submitTier(draft, null, open.isFree)}
            onCancel={() => setOpen(null)}
          />
        ) : null}
      </>
    );

  if (variant === 'full') {
    return (
      <Card className={className} data-testid="niveles-editor">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('intro')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{body}</CardContent>
      </Card>
    );
  }
  return (
    <section
      id="tiers"
      aria-label={t('title')}
      data-testid="niveles-editor"
      className={cn('scroll-mt-32 rounded-2xl border border-border bg-surface p-5', className)}
    >
      <div className="flex flex-wrap items-start gap-4">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700"
          aria-hidden
        >
          <Icon name="award" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-text">{t('title')}</h2>
          <p className="mt-1 max-w-[65ch] text-sm text-text-muted">{t('intro')}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-4">{body}</div>
    </section>
  );
}

// ── Tarjeta de un nivel ─────────────────────────────────────────────────────

function TierCard({
  variant,
  tier,
  tiers,
  courses,
  freeSignupOpen,
  manualReview,
  onToggleManualReview,
  first,
  last,
  open,
  busy,
  error,
  policy,
  onOpen,
  onCloseForm,
  onSubmitTier,
  onSubmitPlan,
  onMove,
  onToggle,
  onDelete,
  onTogglePlan,
  onDeletePlan,
}: {
  variant: TiersVariant;
  tier: MembershipAdminTier;
  tiers: readonly MembershipAdminTier[];
  courses: readonly Course[];
  freeSignupOpen: boolean;
  /** Solo el nivel gratis: el creador revisa a mano cada alta. */
  manualReview: boolean;
  onToggleManualReview: () => void;
  first: boolean;
  last: boolean;
  open: OpenForm;
  busy: boolean;
  error: CardError | null;
  policy: ReturnType<typeof usePricePolicy>;
  onOpen: (form: OpenForm) => void;
  onCloseForm: () => void;
  onSubmitTier: (draft: TierDraft) => Promise<string | null>;
  onSubmitPlan: (
    plan: MembershipAdminPlan | null,
    input: Omit<PlanInput, 'tierId'>,
  ) => Promise<string | null>;
  onMove: (delta: -1 | 1) => void;
  onToggle: () => void;
  onDelete: () => void;
  onTogglePlan: (plan: MembershipAdminPlan) => void;
  onDeletePlan: (plan: MembershipAdminPlan) => void;
}) {
  const t = useTierTexts(variant);
  const locale = useLocale();
  const s = TIER_STYLES[variant];
  const editing = open?.kind === 'tier-edit' && open.tierId === tier.id;
  const planForm = open?.kind === 'plan' && open.tierId === tier.id ? open : null;

  if (editing) {
    return (
      <li data-testid={`nivel-${tier.id}`} data-tier-name={tier.name} className={s.item}>
        <TierForm
          variant={variant}
          tier={tier}
          isFree={tier.isFree}
          courses={courses}
          showLegacyNotice={false}
          busy={busy}
          onSubmit={onSubmitTier}
          onCancel={onCloseForm}
        />
      </li>
    );
  }

  const action = (
    testId: string,
    label: string,
    onClick: () => void,
    opts?: { disabled?: boolean; ariaLabel?: string; icon?: ReactNode },
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={s.action}
      data-testid={testId}
      aria-label={opts?.ariaLabel}
      disabled={busy || opts?.disabled}
      onClick={onClick}
    >
      {opts?.icon}
      {label}
    </Button>
  );

  return (
    <li data-testid={`nivel-${tier.id}`} data-tier-name={tier.name} className={s.item}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-text">
            <span>{tier.name}</span>
            {tier.isFree ? <Badge variant="info">{t('badgeFree')}</Badge> : null}
            {!tier.active ? <Badge variant="muted">{t('badgeOff')}</Badge> : null}
          </p>
          {tier.description ? (
            <p className="mt-0.5 max-w-[65ch] text-sm text-text-muted">{tier.description}</p>
          ) : null}
          <p className="mt-1 text-sm text-text" data-testid={`nivel-incluye-${tier.id}`}>
            {includesText(t, tier, courses, locale)}
          </p>
          <p className="text-[13px] text-text-subtle">{t('members', { n: tier.members })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {action(`nivel-editar-${tier.id}`, t('edit'), () =>
            onOpen({ kind: 'tier-edit', tierId: tier.id }),
          )}
          {action(`nivel-subir-${tier.id}`, t('moveUp'), () => onMove(-1), {
            disabled: first,
            ariaLabel: t('moveUpLabel', { name: tier.name }),
            icon: <Icon name="chevron-down" size={14} className="rotate-180" />,
          })}
          {action(`nivel-bajar-${tier.id}`, t('moveDown'), () => onMove(1), {
            disabled: last,
            ariaLabel: t('moveDownLabel', { name: tier.name }),
            icon: <Icon name="chevron-down" size={14} />,
          })}
          {action(`nivel-activo-${tier.id}`, tier.active ? t('turnOff') : t('turnOn'), onToggle)}
          {action(`nivel-borrar-${tier.id}`, t('delete'), onDelete)}
        </div>
      </div>

      {!tier.active ? <p className="text-[13px] text-text-subtle">{t('offNote')}</p> : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700"
          data-testid={`nivel-error-${tier.id}`}
        >
          <span className="min-w-0 flex-1">{error.text}</span>
          {error.inUse && tier.active ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={s.action}
              disabled={busy}
              onClick={onToggle}
            >
              {t('turnOffInstead')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {tier.isFree ? (
        <>
          <FreeSignupStatus t={t} open={freeSignupOpen} tierActive={tier.active} />
          <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2">
            <Switch
              id={`nivel-gratis-revision-${tier.id}`}
              data-testid="nivel-gratis-revision-manual"
              checked={manualReview}
              disabled={busy}
              onCheckedChange={() => onToggleManualReview()}
              aria-describedby={`nivel-gratis-revision-ayuda-${tier.id}`}
            />
            <div className="min-w-0">
              <label
                htmlFor={`nivel-gratis-revision-${tier.id}`}
                className="block cursor-pointer text-sm font-semibold text-text"
              >
                {t('manualReviewLabel')}
              </label>
              <p
                id={`nivel-gratis-revision-ayuda-${tier.id}`}
                className="text-[13px] text-text-muted"
              >
                {manualReview ? t('manualReviewOnHelp') : t('manualReviewOffHelp')}
              </p>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-sm font-semibold text-text">{t('pricesTitle')}</p>
          {tier.plans.length === 0 ? (
            <p className="text-sm text-warning-700">{t('noPrices')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tier.plans.map((plan) =>
                planForm?.planId === plan.id ? (
                  <li key={plan.id} data-testid={`nivel-plan-${plan.id}`}>
                    <PlanForm
                      variant={variant}
                      tier={tier}
                      tiers={tiers}
                      plan={plan}
                      policy={policy}
                      busy={busy}
                      onSubmit={(input) => onSubmitPlan(plan, input)}
                      onCancel={onCloseForm}
                    />
                  </li>
                ) : (
                  <PlanRow
                    key={plan.id}
                    variant={variant}
                    plan={plan}
                    busy={busy}
                    onEdit={() => onOpen({ kind: 'plan', tierId: tier.id, planId: plan.id })}
                    onToggle={() => onTogglePlan(plan)}
                    onDelete={() => onDeletePlan(plan)}
                  />
                ),
              )}
            </ul>
          )}
          {planForm && planForm.planId === null ? (
            <PlanForm
              variant={variant}
              tier={tier}
              tiers={tiers}
              plan={null}
              policy={policy}
              busy={busy}
              onSubmit={(input) => onSubmitPlan(null, input)}
              onCancel={onCloseForm}
            />
          ) : (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={s.action}
                disabled={busy}
                data-testid={`nivel-plan-nuevo-${tier.id}`}
                onClick={() => onOpen({ kind: 'plan', tierId: tier.id, planId: null })}
              >
                <Icon name="plus" size={14} />
                {t('addPrice')}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** «Incluye todos los cursos», «Incluye: A, B y C» o «Todavía no incluye ningún curso». */
function includesText(
  t: TierTexts,
  tier: MembershipAdminTier,
  courses: readonly Course[],
  locale: string,
): string {
  const inc = tierCourses(tier, courses);
  if (inc.all) return t('includesAll');
  const parts =
    inc.hidden > 0 ? [...inc.titles, t('includesHidden', { n: inc.hidden })] : inc.titles;
  if (parts.length === 0) return t('includesNone');
  return t('includesCourses', {
    courses: formatList(parts, { locale }),
  });
}

/** Estado de la puerta del nivel gratis: el registro gratis abierto o cerrado. */
function FreeSignupStatus({
  t,
  open,
  tierActive,
}: {
  t: TierTexts;
  open: boolean;
  tierActive: boolean;
}) {
  const works = open && tierActive;
  return (
    <p
      data-testid="nivel-gratis-registro"
      data-open={open ? 'true' : 'false'}
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-sm',
        works ? 'bg-success-50 text-success-700' : 'bg-warning-50 text-warning-700',
      )}
    >
      <span className="min-w-0">
        {!tierActive ? t('freeSignupTierOff') : open ? t('freeSignupOpen') : t('freeSignupClosed')}
      </span>
      <Link href={FREE_SIGNUP_SETTINGS} className="font-semibold underline">
        {t('freeSignupLink')}
      </Link>
    </p>
  );
}

// ── Un precio de un nivel ───────────────────────────────────────────────────

function PlanRow({
  variant,
  plan,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  variant: TiersVariant;
  plan: MembershipAdminPlan;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useTierTexts(variant);
  const locale = useLocale();
  const intervalLabel = useIntervalLabel();
  const s = TIER_STYLES[variant];
  const currency = plan.currency.toUpperCase();
  return (
    <li data-testid={`nivel-plan-${plan.id}`} className={s.planItem}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
          <span>{plan.name}</span>
          {plan.isFeatured ? <Badge variant="success">{t('priceFeatured')}</Badge> : null}
          {!plan.active ? <Badge variant="muted">{t('priceOff')}</Badge> : null}
        </p>
        <p className="text-sm text-text-muted tabular-nums">
          {intervalLabel(plan.intervalMonths)} ·{' '}
          {plan.compareAtCents ? (
            <>
              <span className="line-through">
                {formatCents(plan.compareAtCents, currency, { locale })}
              </span>{' '}
            </>
          ) : null}
          <strong className="text-text">
            {formatCents(plan.amountCents, currency, { locale })}
          </strong>
          {plan.trialDays > 0 ? ` · ${t('priceTrial', { days: plan.trialDays })}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={s.action}
          disabled={busy}
          data-testid={`nivel-plan-editar-${plan.id}`}
          onClick={onEdit}
        >
          {t('edit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={s.action}
          disabled={busy}
          data-testid={`nivel-plan-activo-${plan.id}`}
          onClick={onToggle}
        >
          {plan.active ? t('turnOff') : t('turnOn')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={s.action}
          disabled={busy}
          data-testid={`nivel-plan-borrar-${plan.id}`}
          onClick={onDelete}
        >
          {t('delete')}
        </Button>
      </div>
    </li>
  );
}
