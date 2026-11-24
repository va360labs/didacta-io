'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * /join en un aula CON NIVELES (Básico, Pro…): una tarjeta por nivel, en el
 * orden que les dio el creador. Cada tarjeta dice qué incluye, deja elegir
 * cada cuánto se paga (los planes del nivel: precio, tachado, prueba gratis y
 * «mejor valor» preseleccionado, como el selector de siempre) y su botón lleva
 * al pago DE SIEMPRE con ese plan: aquí no se arranca ningún cobro. El nivel
 * gratis no tiene precio: «Entrar gratis» lleva al registro gratis.
 *
 * Todo sale de `GET /membership/page` (`tiers` + `plans`): cero datos propios.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import {
  formatCents,
  type MembershipCourse,
  type MembershipPage,
  type MembershipPlan,
  type MembershipPublicTier,
} from '@/lib/membership';
import { formatDateTime } from '@/lib/i18n/format';
import { intervalDescriptionLabel, intervalSuffixLabel } from './interval-labels';

/** Títulos de curso que se ven de entrada en una tarjeta (el resto, a un clic). */
const VISIBLE_COURSES = 6;

/** ¿La página es de un aula con niveles? Sin ellos, /join se pinta como siempre. */
export function hasTiers(page: MembershipPage): boolean {
  return (page.tiers?.length ?? 0) > 0;
}

/**
 * Planes en venta de un nivel, en el orden del creador. Si los cobros no están
 * conectados la API manda `plans` vacío: el nivel se queda sin planes y su
 * tarjeta no ofrece compra.
 */
export function plansOfTier(page: MembershipPage, tier: MembershipPublicTier): MembershipPlan[] {
  const byId = new Map(page.plans.map((p) => [p.id, p]));
  return tier.planIds.map((id) => byId.get(id)).filter((p): p is MembershipPlan => !!p);
}

/** El plan marcado de entrada: el «mejor valor», o el último (la regla de siempre). */
export function defaultPlanId(plans: MembershipPlan[]): string | null {
  return (plans.find((p) => p.isFeatured) ?? plans[plans.length - 1])?.id ?? null;
}

/**
 * El catálogo de un nivel para la columna de cursos: sus cursos (de los que la
 * página enseña) con las mismas cuentas que hace la API para la página entera
 * (horas = suma de duraciones; precio suelto = suma de los que lo tienen).
 */
export function tierCatalog(
  page: MembershipPage,
  tier: MembershipPublicTier,
): { courses: MembershipCourse[]; totalMinutes: number; standaloneTotalCents: number | null } {
  if (tier.includes.allCourses) {
    return {
      courses: page.courses,
      totalMinutes: page.stats.totalMinutes,
      standaloneTotalCents: page.standaloneTotalCents,
    };
  }
  const ids = new Set(tier.includes.courses.map((c) => c.id));
  const courses = page.courses.filter((c) => ids.has(c.id));
  const priced = courses.filter((c) => c.amountCents !== null);
  return {
    courses,
    totalMinutes: courses.reduce((sum, c) => sum + (c.estimatedMinutes ?? 0), 0),
    standaloneTotalCents: priced.length
      ? priced.reduce((sum, c) => sum + (c.amountCents ?? 0), 0)
      : null,
  };
}

/** Columnas de la rejilla según cuántos niveles hay (sin huecos con 2 o 4). */
function gridColumns(count: number): string {
  if (count >= 4) return 'md:grid-cols-2 xl:grid-cols-4';
  if (count === 3) return 'md:grid-cols-2 lg:grid-cols-3';
  if (count === 2) return 'md:grid-cols-2 mx-auto w-full max-w-4xl';
  return 'mx-auto w-full max-w-md';
}

export interface TierCardsProps {
  page: MembershipPage;
  tiers: MembershipPublicTier[];
  /** Periodicidad elegida en cada nivel (`tierId` → `planId`). */
  periodByTier: Record<string, string>;
  onPeriodChange: (tierId: string, planId: string) => void;
  /** El botón del nivel: abre el pago de siempre con ese plan. */
  onChoose: (tierId: string, planId: string) => void;
  /** «Entrar gratis» (registro gratis), o null si el registro está cerrado. */
  freeSignupPath: string | null;
}

export function TierCards({
  page,
  tiers,
  periodByTier,
  onPeriodChange,
  onChoose,
  freeSignupPath,
}: TierCardsProps) {
  const t = useTranslations('publicSite');
  return (
    <section aria-labelledby="niveles-titulo">
      <div className="text-center">
        <h2 id="niveles-titulo" className="text-[28px] font-bold tracking-tight">
          {t('unete.tiersTitle')}
        </h2>
        <p className="mt-2 text-[15px] text-text-muted">{t('unete.tiersSubtitle')}</p>
      </div>
      <div
        data-testid="niveles-join"
        className={`mt-6 grid items-stretch gap-5 ${gridColumns(tiers.length)}`}
      >
        {tiers.map((tier) =>
          tier.isFree ? (
            <FreeTierCard key={tier.id} tier={tier} freeSignupPath={freeSignupPath} />
          ) : (
            <PaidTierCard
              key={tier.id}
              tier={tier}
              plans={plansOfTier(page, tier)}
              selectedPlanId={periodByTier[tier.id] ?? null}
              onPeriodChange={(planId) => onPeriodChange(tier.id, planId)}
              onChoose={(planId) => onChoose(tier.id, planId)}
            />
          ),
        )}
      </div>
    </section>
  );
}

function PaidTierCard({
  tier,
  plans,
  selectedPlanId,
  onPeriodChange,
  onChoose,
}: {
  tier: MembershipPublicTier;
  plans: MembershipPlan[];
  selectedPlanId: string | null;
  onPeriodChange: (planId: string) => void;
  onChoose: (planId: string) => void;
}) {
  const t = useTranslations('publicSite');
  const locale = useLocale();
  const selected = plans.find((p) => p.id === selectedPlanId) ?? null;
  return (
    <article
      data-testid={`nivel-card-${tier.id}`}
      className="flex flex-col rounded-2xl border border-border bg-surface p-6 shadow-sm"
    >
      <TierHeading tier={tier} />

      {plans.length === 0 ? (
        <p className="mt-5 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-muted">
          {t('unete.tierNotForSale')}
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label={t('unete.tierPeriodAria', { name: tier.name })}
          className="mt-5 flex flex-col gap-2.5"
        >
          {plans.map((plan) => {
            const isSelected = plan.id === selectedPlanId;
            return (
              <button
                key={plan.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-testid={`nivel-periodo-${plan.id}`}
                onClick={() => onPeriodChange(plan.id)}
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
                  {isSelected ? <span className="h-2.5 w-2.5 rounded-full bg-brand-600" /> : null}
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

      <Button
        size="lg"
        className="mt-5 w-full"
        disabled={!selected}
        onClick={() => {
          if (selected) onChoose(selected.id);
        }}
        data-testid={`nivel-comprar-${tier.id}`}
      >
        {t('unete.tierChoose', { name: tier.name })}
      </Button>

      <TierIncludes tier={tier} />
    </article>
  );
}

function FreeTierCard({
  tier,
  freeSignupPath,
}: {
  tier: MembershipPublicTier;
  freeSignupPath: string | null;
}) {
  const t = useTranslations('publicSite');
  return (
    <article
      data-testid={`nivel-card-${tier.id}`}
      className="flex flex-col rounded-2xl border border-border bg-surface p-6 shadow-sm"
    >
      <TierHeading tier={tier} />

      <div className="mt-5 rounded-xl border border-border bg-surface-2 px-4 py-3.5">
        <span className="text-xl font-bold">{t('unete.tierFreePrice')}</span>
        <p className="mt-0.5 text-[13px] text-text-muted">{t('unete.tierFreeNote')}</p>
      </div>

      {freeSignupPath ? (
        <Button asChild size="lg" variant="secondary" className="mt-5 w-full">
          <Link href={freeSignupPath} data-testid="nivel-gratis-entrar">
            {t('unete.tierFreeEnter')}
          </Link>
        </Button>
      ) : (
        <p className="mt-5 text-center text-sm text-text-muted">{t('unete.tierFreeClosed')}</p>
      )}

      <TierIncludes tier={tier} />
    </article>
  );
}

function TierHeading({ tier }: { tier: MembershipPublicTier }) {
  return (
    <>
      <h3 className="text-xl font-bold tracking-tight">{tier.name}</h3>
      {tier.description ? (
        <p className="mt-1.5 whitespace-pre-line text-sm leading-[21px] text-text-muted">
          {tier.description}
        </p>
      ) : null}
    </>
  );
}

/** «Qué incluye»: sus cursos por título, o «todos los cursos» si el nivel los da todos. */
function TierIncludes({ tier }: { tier: MembershipPublicTier }) {
  const t = useTranslations('publicSite');
  const [expanded, setExpanded] = useState(false);
  const { allCourses, courses } = tier.includes;
  const visible = expanded ? courses : courses.slice(0, VISIBLE_COURSES);
  const hidden = courses.length - visible.length;
  return (
    <div className="mt-6 border-t border-border-soft pt-5">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-text-subtle">
        {t('unete.tierIncludesHeading')}
      </p>
      <ul data-testid={`nivel-incluye-${tier.id}`} className="mt-3 flex flex-col gap-2 text-sm">
        {allCourses ? (
          <IncludesItem>
            {t('unete.tierAllCourses')}
            {courses.length > 0 ? (
              <span className="block text-[13px] text-text-muted">
                {t('unete.tierCoursesNow', { count: courses.length })}
              </span>
            ) : null}
          </IncludesItem>
        ) : courses.length === 0 ? (
          <li className="text-text-muted">{t('unete.tierNoCourses')}</li>
        ) : (
          visible.map((course) => <IncludesItem key={course.id}>{course.title}</IncludesItem>)
        )}
      </ul>
      {!allCourses && hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-[13px] font-semibold text-brand-700 hover:underline"
        >
          {t('unete.tierMoreCourses', { count: hidden })}
        </button>
      ) : null}
      <TierIncludesExtra tier={tier} />
    </div>
  );
}

function IncludesItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * Lo que da el nivel ADEMÁS de los cursos: los espacios de la comunidad y los
 * próximos directos que son solo para él (`tier.includes.spaces` / `.lives`,
 * que compone la API con los módulos de comunidad y directos). Solo nombres, y
 * la fecha en los directos: nada del contenido ni enlaces. Sin nada, no pinta.
 */
export function TierIncludesExtra({
  tier,
}: {
  tier: MembershipPublicTier;
}): React.JSX.Element | null {
  const t = useTranslations('publicSite');
  const locale = useLocale();
  const spaces = tier.includes.spaces ?? [];
  const lives = tier.includes.lives ?? [];
  if (spaces.length === 0 && lives.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid={`nivel-incluye-extra-${tier.id}`}>
      {spaces.length > 0 ? (
        <div>
          <p className="text-[13px] font-semibold text-text">{t('unete.tierSpacesHeading')}</p>
          <ul
            className="mt-2 flex flex-col gap-2 text-sm"
            data-testid={`nivel-espacios-${tier.id}`}
          >
            {spaces.map((space) => (
              <IncludesItem key={space.name}>{space.name}</IncludesItem>
            ))}
          </ul>
        </div>
      ) : null}
      {lives.length > 0 ? (
        <div>
          <p className="text-[13px] font-semibold text-text">{t('unete.tierLivesHeading')}</p>
          <ul
            className="mt-2 flex flex-col gap-2 text-sm"
            data-testid={`nivel-directos-${tier.id}`}
          >
            {lives.map((live) => (
              <IncludesItem key={`${live.title}-${live.startTime}`}>
                {live.title}
                <span className="block text-[13px] text-text-muted">
                  {formatDateTime(live.startTime, {
                    locale,
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </IncludesItem>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
