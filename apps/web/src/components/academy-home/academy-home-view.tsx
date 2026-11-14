/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icon';
import { SocialIcon } from '@/components/social-icon';
import {
  brandStyle,
  FREE_ACCESS_PATH,
  initialsOf,
  primaryAccess,
  withRef,
  type AcademyHome,
  type AcademyHomeCourse,
} from '@/lib/academy-home';
import { formatNumber } from '@/lib/i18n/format';
import { formatCents } from '@/lib/membership';
import { socialLinkName } from '@/lib/social-links';
import { AcademyHomeSession, EARLY_SESSION_REDIRECT, LiveDate } from './academy-home-client';

/**
 * PÁGINA PÚBLICA DE LA ACADEMIA: lo que ve en la raíz del aula quien todavía no
 * es miembro, como la página «About» de un grupo de Skool o la portada de una
 * comunidad de Circle (sin copiar su marca).
 *
 *  - Cabecera: logo y nombre del aula; a la derecha «Entrar» y el botón
 *    principal de acceso.
 *  - Portada grande (o la banda con su color), nombre, descripción, enlaces,
 *    nº de miembros (solo el número), quién la lleva y el próximo directo.
 *  - Tarjeta «Cómo entrar» con lo que el aula tiene a la venta de verdad
 *    (membresía, cursos sueltos, acceso gratuito) y «¿Ya eres miembro?».
 *  - Los cursos a la venta, cada uno a su ficha de venta.
 *
 * Piel del modo sencillo (Figtree, tarjetas blancas de borde suave, botones
 * redondeados) con el color y el logo del aula. Todo sale de
 * `GET /public/academy-home`; un bloque sin datos no se pinta. Todos los
 * botones conservan el `?ref=` del visitante.
 */

interface Props {
  home: AcademyHome;
  refCode: string | null;
  preview: boolean;
}

type T = Awaited<ReturnType<typeof getTranslations<'publicSite'>>>;

const FONT = { fontFamily: 'var(--font-figtree), var(--font-sans)' } as const;

function intervalSuffix(t: T, months: number): string {
  if (months === 12) return t('unete.intervalSuffixYear');
  if (months === 6) return t('unete.intervalSuffixSemester');
  if (months === 3) return t('unete.intervalSuffixQuarter');
  if (months === 1) return t('unete.intervalSuffixMonth');
  return t('unete.intervalSuffixMonths', { months });
}

export async function AcademyHomeView({ home, refCode, preview }: Props) {
  const t = await getTranslations('publicSite');
  const locale = await getLocale();
  const { academy, offers } = home;
  const primary = primaryAccess(home, refCode);
  const brand = brandStyle(academy.brandHue, academy.brandSaturation);
  const signinHref = withRef('/signin', refCode);
  const money = (cents: number, currency: string) => formatCents(cents, currency, { locale });
  const cheapestCourse = offers.courses.reduce<AcademyHomeCourse | null>(
    (min, c) => (min === null || c.price.amountCents < min.price.amountCents ? c : min),
    null,
  );

  const primaryLabel = primary
    ? {
        membership: t('portada.ctaJoin'),
        course: t('portada.ctaCourse'),
        courses: t('portada.ctaCourses'),
        free: t('portada.ctaFree'),
      }[primary.kind]
    : null;

  return (
    <div className="min-h-dvh bg-bg-subtle text-text" style={FONT} data-testid="portada-aula">
      {brand ? <style dangerouslySetInnerHTML={{ __html: brand }} /> : null}
      {preview ? null : <script dangerouslySetInnerHTML={{ __html: EARLY_SESSION_REDIRECT }} />}
      <AcademyHomeSession preview={preview} />

      {/* ── Cabecera ── */}
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1140px] items-center gap-3 px-4 sm:px-6">
          <Brand academy={academy} />
          <nav
            className="ml-auto flex shrink-0 items-center gap-2"
            aria-label={t('portada.navAria')}
          >
            <a
              href={signinHref}
              data-testid="portada-entrar"
              className="inline-flex h-10 items-center rounded-xl px-3 text-[15px] font-semibold text-text transition-colors hover:bg-bg-subtle sm:px-4"
            >
              {t('portada.signIn')}
            </a>
            {primary && primaryLabel ? (
              <a
                href={primary.href}
                data-testid="portada-cta"
                className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
              >
                {primaryLabel}
              </a>
            ) : null}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1140px] px-4 pb-16 pt-6 sm:px-6 lg:pt-10">
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_368px] lg:gap-10">
          {/* ── Quién es el aula ── */}
          <section className="min-w-0" aria-labelledby="portada-nombre">
            <Cover academy={academy} />
            <h1
              id="portada-nombre"
              className="mt-6 text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-text sm:text-[40px]"
            >
              {academy.name}
            </h1>
            {academy.host ? <p className="mt-1 text-sm text-text-subtle">{academy.host}</p> : null}

            <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 text-[15px] text-text-muted">
              {home.members !== null ? (
                <li className="inline-flex items-center gap-2" data-testid="portada-miembros">
                  <Icon name="users" size={18} className="text-text-subtle" />
                  <span>
                    <strong className="font-bold text-text">
                      {formatNumber(home.members, { locale })}
                    </strong>{' '}
                    {t('portada.members', { count: home.members })}
                  </span>
                </li>
              ) : null}
              {home.creator ? (
                <li className="inline-flex items-center gap-2" data-testid="portada-creadora">
                  <Avatar name={home.creator.name} url={home.creator.avatarUrl} />
                  <span>
                    {t.rich('portada.createdBy', {
                      name: home.creator.name,
                      strong: (chunks: ReactNode) => (
                        <strong className="font-semibold text-text">{chunks}</strong>
                      ),
                    })}
                  </span>
                </li>
              ) : null}
            </ul>

            {academy.description ? (
              <p
                className="mt-5 max-w-[65ch] whitespace-pre-line break-words text-[17px] leading-relaxed text-text-muted"
                data-testid="portada-descripcion"
              >
                {academy.description}
              </p>
            ) : null}

            {academy.links.length > 0 ? (
              <ul className="mt-5 flex flex-wrap gap-2" aria-label={t('portada.linksAria')}>
                {academy.links.map((link) => {
                  const name = socialLinkName(link.kind, link.url, t('portada.website'));
                  return (
                    <li key={`${link.kind}-${link.url}`}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={name}
                        title={name}
                        className="grid h-10 w-10 place-items-center rounded-full border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text"
                      >
                        <SocialIcon kind={link.kind} size={18} />
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {home.nextLive ? (
              <div
                className="mt-6 flex items-start gap-3 rounded-2xl border border-border bg-surface p-4"
                data-testid="portada-directo"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
                  <Icon name="video" size={20} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.06em] text-brand-700">
                    {t('portada.nextLive')}
                  </p>
                  <p className="mt-0.5 font-semibold text-text">{home.nextLive.title}</p>
                  <p className="text-sm text-text-muted">
                    <LiveDate iso={home.nextLive.startTime} />
                  </p>
                </div>
              </div>
            ) : null}
          </section>

          {/* ── Cómo entrar ── */}
          <aside className="lg:sticky lg:top-24" aria-labelledby="portada-acceso">
            <AccessCard
              home={home}
              t={t}
              refCode={refCode}
              signinHref={signinHref}
              money={money}
              cheapestCourse={cheapestCourse}
            />
          </aside>
        </div>

        {/* ── Cursos a la venta ── */}
        {offers.courses.length > 0 ? (
          <section id="courses" className="mt-14 scroll-mt-24" aria-labelledby="portada-cursos">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2
                  id="portada-cursos"
                  className="text-[24px] font-extrabold tracking-[-0.015em] text-text"
                >
                  {t('portada.coursesTitle')}
                </h2>
                <p className="mt-1 text-text-muted">{t('portada.coursesSubtitle')}</p>
              </div>
              {offers.coursesTotal > offers.courses.length ? (
                <a
                  href={withRef('/catalog', refCode)}
                  className="inline-flex items-center gap-1 text-[15px] font-semibold text-brand-700 hover:underline"
                >
                  {t('portada.allCourses', { count: offers.coursesTotal })}
                  <Icon name="arrow-right" size={16} />
                </a>
              ) : null}
            </div>
            <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {offers.courses.map((course) => (
                <li key={course.slug}>
                  <CourseCard course={course} t={t} refCode={refCode} money={money} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-16 border-t border-border pt-6 text-center text-xs text-text-subtle">
          <a
            href={`https://didacta.io/${locale.toLowerCase().startsWith('es') ? 'es' : 'en'}`}
            target="_blank"
            rel="noopener"
            className="hover:text-text-muted hover:underline"
          >
            {t('portada.poweredBy')}
          </a>
        </footer>
      </main>
    </div>
  );
}

function Brand({ academy }: { academy: AcademyHome['academy'] }) {
  const wordmark = academy.logoUrl && academy.logoDisplayMode === 'logo_only';
  return (
    <a href="/" className="flex min-w-0 items-center gap-2.5" data-testid="portada-marca">
      {academy.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={academy.logoUrl}
          alt={wordmark ? academy.name : ''}
          className={
            wordmark ? 'h-9 max-w-[180px] object-contain' : 'h-9 w-9 rounded-lg object-contain'
          }
        />
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-600 text-sm font-extrabold text-white">
          {initialsOf(academy.name)}
        </span>
      )}
      {wordmark ? null : (
        <span className="hidden truncate text-[17px] font-bold text-text min-[420px]:inline">
          {academy.name}
        </span>
      )}
    </a>
  );
}

/** Portada propia o, sin ella, la banda con el color y el logo del aula. */
function Cover({ academy }: { academy: AcademyHome['academy'] }) {
  if (academy.coverUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={academy.coverUrl}
        alt=""
        className="block aspect-[16/9] w-full rounded-2xl border border-border bg-surface object-cover"
        data-testid="portada-imagen"
      />
    );
  }
  return (
    <div
      className="grid aspect-[16/9] w-full place-items-center rounded-2xl border border-border"
      style={{
        background:
          'linear-gradient(135deg, var(--color-brand-100) 0%, var(--color-brand-50) 60%, var(--color-surface) 100%)',
      }}
      data-testid="portada-banda"
    >
      {academy.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={academy.logoUrl} alt="" className="max-h-[38%] max-w-[60%] object-contain" />
      ) : (
        <span className="text-[clamp(40px,8vw,72px)] font-extrabold tracking-tight text-brand-700">
          {initialsOf(academy.name)}
        </span>
      )}
    </div>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-8 w-8 rounded-full object-cover" />;
  }
  return (
    <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">
      {initialsOf(name)}
    </span>
  );
}

function AccessCard({
  home,
  t,
  refCode,
  signinHref,
  money,
  cheapestCourse,
}: {
  home: AcademyHome;
  t: T;
  refCode: string | null;
  signinHref: string;
  money: (cents: number, currency: string) => string;
  cheapestCourse: AcademyHomeCourse | null;
}) {
  const { membership, courses, coursesTotal, free } = home.offers;
  const nothing = !membership && coursesTotal === 0 && !free;
  const singleCourse = coursesTotal === 1 ? courses[0] : null;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
      data-testid="portada-acceso"
    >
      <div className="border-b border-border-soft px-5 py-4">
        <h2 id="portada-acceso" className="text-[18px] font-extrabold tracking-[-0.01em] text-text">
          {nothing ? t('portada.accessTitleNone') : t('portada.accessTitle')}
        </h2>
      </div>

      <div className="flex flex-col gap-3 p-5">
        {nothing ? (
          <p
            className="text-[15px] leading-relaxed text-text-muted"
            data-testid="portada-sin-venta"
          >
            {t('portada.nothingForSale', { name: home.academy.name })}
          </p>
        ) : null}

        {membership ? (
          <div className="rounded-xl border-2 border-brand-600 p-4" data-testid="portada-membresia">
            <p className="text-xs font-bold uppercase tracking-[0.06em] text-brand-700">
              {t('portada.membershipLabel')}
            </p>
            <p className="mt-1 font-semibold text-text">
              {membership.headline ?? membership.plan.name}
            </p>
            {membership.subheadline ? (
              <p className="mt-1 text-sm text-text-muted">{membership.subheadline}</p>
            ) : null}
            <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
              {membership.planCount > 1 ? (
                <span className="text-sm text-text-muted">{t('portada.from')}</span>
              ) : null}
              <span className="text-[28px] font-extrabold leading-none text-text">
                {money(membership.plan.amountCents, membership.plan.currency)}
              </span>
              <span className="text-text-muted">
                {intervalSuffix(t, membership.plan.intervalMonths)}
              </span>
              {membership.plan.compareAtCents ? (
                <span className="text-sm text-text-subtle line-through">
                  {money(membership.plan.compareAtCents, membership.plan.currency)}
                </span>
              ) : null}
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-text-muted">
              {membership.courseCount ? (
                <Perk>{t('portada.membershipCourses', { count: membership.courseCount })}</Perk>
              ) : null}
              <Perk>{t('portada.membershipCommunity')}</Perk>
              {membership.plan.trialDays > 0 ? (
                <Perk>{t('unete.planTrialSuffix', { days: membership.plan.trialDays })}</Perk>
              ) : null}
            </ul>
            <a
              href={withRef('/join', refCode)}
              data-testid="portada-membresia-cta"
              className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 text-[16px] font-bold text-white shadow-sm transition-colors hover:bg-brand-700"
            >
              {membership.plan.trialDays > 0
                ? t('portada.membershipTrialCta')
                : t('portada.membershipCta')}
            </a>
          </div>
        ) : null}

        {coursesTotal > 0 && cheapestCourse ? (
          <div className="rounded-xl border border-border p-4" data-testid="portada-cursos-sueltos">
            <p className="text-xs font-bold uppercase tracking-[0.06em] text-text-subtle">
              {singleCourse ? t('portada.singleCourseLabel') : t('portada.coursesLabel')}
            </p>
            <p className="mt-1 font-semibold text-text">
              {singleCourse
                ? singleCourse.title
                : t('portada.coursesCount', { count: coursesTotal })}
            </p>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
              {singleCourse ? null : (
                <span className="text-sm text-text-muted">{t('portada.from')}</span>
              )}
              <span className="text-[22px] font-extrabold leading-none text-text">
                {money(cheapestCourse.price.amountCents, cheapestCourse.price.currency)}
              </span>
              <span className="text-sm text-text-muted">{t('portada.oneTimePayment')}</span>
            </p>
            <a
              href={
                singleCourse
                  ? withRef(`/catalog/${encodeURIComponent(singleCourse.slug)}`, refCode)
                  : '#courses'
              }
              data-testid="portada-cursos-cta"
              className={
                membership
                  ? 'mt-3 flex h-11 w-full items-center justify-center rounded-xl border border-border bg-surface text-[15px] font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle'
                  : 'mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 text-[16px] font-bold text-white shadow-sm transition-colors hover:bg-brand-700'
              }
            >
              {singleCourse ? t('portada.viewCourse') : t('portada.viewCourses')}
            </a>
          </div>
        ) : null}

        {free ? (
          <div className="rounded-xl border border-border p-4" data-testid="portada-gratis">
            <p className="text-xs font-bold uppercase tracking-[0.06em] text-text-subtle">
              {t('portada.freeLabel')}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {free.courses.length > 0
                ? t('portada.freeWithCourses', {
                    courses: free.courses.map((c) => c.title).join(' · '),
                  })
                : t('portada.freeCommunity')}
            </p>
            <a
              href={withRef(FREE_ACCESS_PATH, refCode)}
              data-testid="portada-gratis-cta"
              className={
                membership || coursesTotal > 0
                  ? 'mt-3 flex h-11 w-full items-center justify-center rounded-xl border border-border bg-surface text-[15px] font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle'
                  : 'mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 text-[16px] font-bold text-white shadow-sm transition-colors hover:bg-brand-700'
              }
            >
              {t('portada.ctaFree')}
            </a>
          </div>
        ) : null}

        {nothing ? (
          <a
            href={signinHref}
            data-testid="portada-acceso-entrar"
            className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 text-[16px] font-bold text-white shadow-sm transition-colors hover:bg-brand-700"
          >
            {t('portada.signIn')}
          </a>
        ) : (
          <p className="pt-1 text-center text-sm text-text-muted">
            {t('portada.alreadyMember')}{' '}
            <a href={signinHref} className="font-semibold text-brand-700 hover:underline">
              {t('portada.signIn')}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function Perk({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon name="check" size={16} className="mt-0.5 shrink-0 text-brand-600" />
      <span>{children}</span>
    </li>
  );
}

function CourseCard({
  course,
  t,
  refCode,
  money,
}: {
  course: AcademyHomeCourse;
  t: T;
  refCode: string | null;
  money: (cents: number, currency: string) => string;
}) {
  return (
    <a
      href={withRef(`/catalog/${encodeURIComponent(course.slug)}`, refCode)}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface transition-shadow hover:shadow-md"
      data-testid="portada-curso"
    >
      {course.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={course.thumbnailUrl} alt="" className="aspect-video w-full object-cover" />
      ) : (
        <div className="grid aspect-video w-full place-items-center bg-brand-50 text-brand-600">
          <Icon name="book" size={32} />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h3 className="text-[17px] font-bold leading-snug text-text group-hover:text-brand-700">
          {course.title}
        </h3>
        {course.excerpt ? (
          <p className="line-clamp-2 text-sm text-text-muted">{course.excerpt}</p>
        ) : null}
        <div className="mt-auto flex items-end justify-between gap-3 pt-3">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-extrabold text-text">
              {money(course.price.amountCents, course.price.currency)}
            </span>
            {course.price.compareAtCents ? (
              <span className="text-sm text-text-subtle line-through">
                {money(course.price.compareAtCents, course.price.currency)}
              </span>
            ) : null}
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700">
            {t('portada.viewCourse')}
            <Icon name="arrow-right" size={15} />
          </span>
        </div>
      </div>
    </a>
  );
}
