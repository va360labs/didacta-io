'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Puerta de suscripción del aula: con el aula en pausa, la pantalla de pausa
/// sustituye al contenido en TODAS las rutas — con sesión o sin ella, en el
/// aula y en sus páginas públicas — salvo las de entrar (`isGateFreePath`), para
/// que el administrador pueda iniciar sesión y pagar.
///
/// Esto es la cara; el bloqueo de verdad es el 402 de la API. Por eso la
/// pantalla se cierra también en cuanto cualquier petición recibe ese 402,
/// aunque `/auth/tenant-context` dijera «abierta» hace un rato (la prueba que
/// vence con la pestaña abierta).
///
/// La pantalla es el MISMO marco que el inicio de sesión —panel de marca en el
/// azul noche del aula, teñido con el color del tenant, y la hoja clara al
/// lado—: es la puerta de esta academia, no una página de Didacta. Calma, sin
/// rojo ni iconos de alarma: es una pausa, y lo primero que se lee es que todo
/// sigue ahí.

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { authStorage, type StoredSession } from '@/lib/auth-storage';
import { clearIntendedPath } from '@/lib/post-login-redirect';
import {
  administraAcademia,
  fetchMyGate,
  forgetMyGate,
  isGateFreePath,
  lockedHint,
  safeActionUrl,
  SUBSCRIPTION_LOCKED_EVENT,
} from '@/lib/subscription-gate';
import {
  fetchTenantContext,
  invalidateTenantContext,
  useTenantContext,
  type TenantPublicInfo,
} from '@/lib/tenant-context';
import { requestThemeRefresh, themeCache } from '@/lib/theming';

export function SubscriptionGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { loading, tenant } = useTenantContext();
  const [lockedByApi, setLockedByApi] = useState(false);
  // La pista se lee DESPUÉS de montar: en el servidor no existe, y leerla en el
  // primer render rompería la hidratación.
  const [hint, setHint] = useState(false);

  useEffect(() => {
    setHint(lockedHint.read());
    const onLocked = () => setLockedByApi(true);
    window.addEventListener(SUBSCRIPTION_LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(SUBSCRIPTION_LOCKED_EVENT, onLocked);
  }, []);

  const lockedByContext = tenant?.subscriptionGate?.state === 'LOCKED';
  const locked = lockedByContext || lockedByApi || (loading && hint);

  useEffect(() => {
    if (!loading) lockedHint.write(lockedByContext || lockedByApi);
  }, [loading, lockedByContext, lockedByApi]);

  if (!locked || isGateFreePath(pathname)) return <>{children}</>;
  return <SubscriptionLockScreen tenant={tenant} tenantLoading={loading} />;
}

/** Cada cuánto se vuelve a preguntar, con la pestaña a la vista, si el aula ya abrió. */
const RECHECK_MS = 30_000;

/** Mismo azul noche + tinte que el panel del inicio de sesión: la misma superficie de marca. */
const BRAND_PANEL_STYLE: CSSProperties = {
  backgroundColor: 'var(--sidebar-bg, #0D1B2A)',
  backgroundImage:
    'linear-gradient(180deg, hsl(var(--brand-h) 62% 49% / 0.20) 0%, rgba(13,27,42,0) 42%, hsl(calc(var(--brand-h) - 40) 70% 40% / 0.12) 100%)',
};

const KEPT: Array<{ icon: IconName; key: 'keptCourses' | 'keptStudents' | 'keptBrand' }> = [
  { icon: 'book', key: 'keptCourses' },
  { icon: 'users', key: 'keptStudents' },
  { icon: 'palette', key: 'keptBrand' },
];

export function SubscriptionLockScreen({
  tenant,
  tenantLoading = false,
}: {
  tenant: TenantPublicInfo | null;
  /** El contexto del tenant aún no ha llegado: no se pinta ningún nombre todavía. */
  tenantLoading?: boolean;
}) {
  const t = useTranslations('shell.subscriptionGate.lock');
  const [session, setSession] = useState<StoredSession | null>(null);
  const [actionUrl, setActionUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const isAdmin = administraAcademia(session?.user.roles);
  const name = tenant?.name?.trim() || t('fallbackName');

  // Quién mira: la sesión vive en el navegador, así que se lee al montar.
  useEffect(() => {
    const current = authStorage.getSession();
    setSession(current);
    if (!administraAcademia(current?.user.roles)) {
      setReady(true);
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) {
      setReady(true);
      return;
    }
    let cancelado = false;
    void fetchMyGate(token).then((gate) => {
      if (cancelado) return;
      setActionUrl(safeActionUrl(gate?.actionUrl));
      setReady(true);
    });
    return () => {
      cancelado = true;
    };
  }, []);

  // ¿Ya se reabrió? Al volver a la pestaña (después de pagar en la otra) y cada
  // medio minuto mientras se mira. Al reabrirse se recarga entera: así no queda
  // ninguna caché del aula cerrada.
  const comprobar = useCallback(async () => {
    invalidateTenantContext();
    forgetMyGate();
    const res = await fetchTenantContext();
    if (res.tenant && res.tenant.subscriptionGate?.state !== 'LOCKED') {
      lockedHint.write(false);
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void comprobar();
    };
    document.addEventListener('visibilitychange', onVisible);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void comprobar();
    }, RECHECK_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(id);
    };
  }, [comprobar]);

  /**
   * Salir y llevar al inicio de sesión. Recarga completa a propósito: limpia
   * de golpe las cachés en memoria del usuario que se va (espacios, tema).
   */
  function salirHaciaLogin() {
    const tenantId = session?.user.tenantId;
    authStorage.clear();
    clearIntendedPath();
    if (tenantId) themeCache.clear(tenantId);
    requestThemeRefresh();
    window.location.assign('/signin');
  }

  const brandHue = typeof tenant?.brandHue === 'number' ? Math.round(tenant.brandHue) : null;

  return (
    <main
      data-testid="subscription-lock"
      data-variant={ready && !tenantLoading ? (isAdmin ? 'admin' : 'other') : 'loading'}
      className="min-h-dvh bg-bg-subtle lg:p-6 dark:bg-[var(--sidebar-rail-bg,#0a1421)]"
    >
      {/* Color de marca sin sesión, igual que el inicio de sesión: el
          TenantThemeProvider solo puede pedir el tema con token. */}
      {brandHue !== null ? (
        <style
          dangerouslySetInnerHTML={{
            __html: `:root{--brand-h:${brandHue};--brand-s:${Math.round(
              tenant?.brandSaturation ?? 70,
            )}%;}`,
          }}
        />
      ) : null}
      <div className="mx-auto flex min-h-dvh w-full max-w-[1400px] flex-col overflow-hidden bg-surface lg:min-h-[calc(100dvh-3rem)] lg:flex-row lg:rounded-2xl lg:border lg:border-border-soft lg:shadow-xl dark:bg-[hsl(var(--brand-h)_45%_9%)] dark:lg:border-white/10">
        {/* ---------------- Panel de marca ---------------- */}
        <aside
          className="relative flex flex-col gap-6 px-6 pt-8 pb-7 text-white sm:px-10 lg:w-[46%] lg:justify-between lg:gap-8 lg:px-14 lg:py-14"
          style={BRAND_PANEL_STYLE}
        >
          <div className="flex items-center gap-3">
            {tenant?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tenant.logoUrl}
                alt={tenant.name}
                className={
                  tenant.logoDisplayMode === 'logo_and_name'
                    ? 'h-10 w-auto max-w-[96px] object-contain object-left lg:h-12'
                    : 'h-10 w-auto max-w-[220px] object-contain object-left lg:h-14'
                }
              />
            ) : null}
            {/* Sin el contexto todavía, un hueco del mismo tamaño: aquí nunca
                se enseña «Didacta» en lugar del nombre de la academia. */}
            {tenantLoading ? (
              <span aria-hidden="true" className="block h-7 w-40 rounded bg-white/10 lg:h-9" />
            ) : tenant && (!tenant.logoUrl || tenant.logoDisplayMode === 'logo_and_name') ? (
              <span className="font-display text-xl font-extrabold tracking-tight lg:text-3xl">
                {tenant.name}
              </span>
            ) : null}
          </div>

          <div className="lg:pb-2">
            <p
              className="font-display max-w-[14ch] text-[1.375rem] leading-[1.1] font-extrabold tracking-tight text-balance text-white sm:text-4xl lg:text-[3.25rem] lg:leading-[1.06]"
              data-testid="subscription-lock-brandline"
            >
              {t('brandLine')}
            </p>
            {/* Regla de acento, tintada al color del tenant (la misma del inicio de sesión). */}
            <div
              aria-hidden="true"
              className="mt-4 h-1 w-20 rounded-full lg:mt-9 lg:w-24"
              style={{ backgroundColor: 'hsl(var(--brand-h) 65% 62%)' }}
            />
          </div>
        </aside>

        {/* ---------------- Mensaje ---------------- */}
        {/* En móvil el mensaje empieza arriba, pegado a la banda de marca: centrado
            en vertical dejaba media pantalla vacía encima del texto. */}
        <section className="flex flex-1 items-start justify-center px-6 pt-9 pb-12 sm:px-10 lg:items-center lg:px-16 lg:py-14">
          <div className="w-full max-w-[28rem]">
            {!ready || tenantLoading ? (
              <div aria-hidden="true" className="space-y-4">
                <div className="h-8 w-3/4 animate-pulse rounded-md bg-surface-3 dark:bg-white/10" />
                <div className="h-4 w-full animate-pulse rounded bg-surface-3 dark:bg-white/10" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-surface-3 dark:bg-white/10" />
              </div>
            ) : isAdmin ? (
              <AdminMessage
                actionUrl={actionUrl}
                onSignOut={salirHaciaLogin}
                labels={{
                  title: t('adminTitle'),
                  body: t('adminBody'),
                  keptTitle: t('keptTitle'),
                  kept: KEPT.map((k) => ({ icon: k.icon, label: t(k.key) })),
                  choosePlan: t('choosePlan'),
                  reopenNote: t('reopenNote'),
                  signOut: t('signOut'),
                }}
              />
            ) : (
              <div>
                <h1 className="text-[1.625rem] leading-[1.2] font-bold tracking-tight text-balance text-text sm:text-[2rem] dark:text-white">
                  {t('otherTitle', { name })}
                </h1>
                <p className="mt-4 text-base leading-relaxed text-pretty text-text-muted dark:text-white/70">
                  {t('otherBody')}
                </p>
                <button
                  type="button"
                  onClick={salirHaciaLogin}
                  data-testid="subscription-lock-admin-signin"
                  className="mt-10 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-text-muted underline decoration-border-strong underline-offset-4 transition-colors hover:text-text hover:decoration-text-muted dark:text-white/60 dark:decoration-white/25 dark:hover:text-white"
                >
                  {t('adminSignIn')}
                  <Icon name="arrow-right" size={14} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function AdminMessage({
  actionUrl,
  onSignOut,
  labels,
}: {
  actionUrl: string | null;
  onSignOut: () => void;
  labels: {
    title: string;
    body: string;
    keptTitle: string;
    kept: Array<{ icon: IconName; label: string }>;
    choosePlan: string;
    reopenNote: string;
    signOut: string;
  };
}) {
  const t = useTranslations('shell.subscriptionGate.trialBanner');
  return (
    <div>
      <h1 className="text-[1.625rem] leading-[1.2] font-bold tracking-tight text-balance text-text sm:text-[2rem] dark:text-white">
        {labels.title}
      </h1>
      <p className="mt-4 text-base leading-relaxed text-pretty text-text-muted dark:text-white/70">
        {labels.body}
      </p>

      <h2 className="mt-8 font-sans text-sm leading-5 font-semibold tracking-normal text-text dark:text-white/90">
        {labels.keptTitle}
      </h2>
      <ul className="mt-3 divide-y divide-border-soft border-y border-border-soft dark:divide-white/10 dark:border-white/10">
        {labels.kept.map((item) => (
          <li
            key={item.label}
            className="flex items-center gap-3 py-3 text-[0.9375rem] text-text dark:text-white/85"
          >
            <span
              aria-hidden="true"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-white/[0.07] dark:text-brand-200"
            >
              <Icon name={item.icon} size={16} />
            </span>
            {item.label}
          </li>
        ))}
      </ul>

      {actionUrl ? (
        <>
          <a
            href={actionUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="subscription-lock-choose-plan"
            className="mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-6 text-base font-semibold text-text-on-brand shadow-sm transition-[background-color,transform] duration-150 ease-out hover:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:translate-y-px active:bg-brand-700 sm:w-auto dark:bg-brand-400 dark:text-[var(--sidebar-bg,#0d1b2a)] dark:hover:bg-brand-300 dark:focus-visible:ring-offset-transparent"
          >
            {labels.choosePlan}
            <Icon name="arrow-right" size={16} aria-hidden="true" className="-rotate-45" />
            <span className="sr-only">{t('newTab')}</span>
          </a>
          <p className="mt-3 text-sm text-text-muted dark:text-white/60">{labels.reopenNote}</p>
        </>
      ) : null}

      <button
        type="button"
        onClick={onSignOut}
        className="mt-8 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-text-muted transition-colors hover:text-text dark:text-white/55 dark:hover:text-white"
      >
        <Icon name="logout" size={15} aria-hidden="true" />
        {labels.signOut}
      </button>
    </div>
  );
}
