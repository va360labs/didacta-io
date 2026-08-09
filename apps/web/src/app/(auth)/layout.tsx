'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { formatNumber } from '@/lib/i18n/format';
import { useTenantContext } from '@/lib/tenant-context';

/**
 * Layout del route group `(auth)`: pantalla partida — panel de marca oscuro a
 * la izquierda, formulario a la derecha.
 *
 * El panel de marca NO inventa nada:
 *  - Logo y nombre salen del tenant resuelto por dominio (`/auth/tenant-context`).
 *  - El titular es el copy que el admin escribe en /admin/branding; si no hay,
 *    se usa la frase genérica de Didacta (`layout.defaultHeadline` del catálogo
 *    i18n), que no afirma nada concreto de ningún tenant.
 *  - Las dos cifras son COUNT reales del tenant (miembros activos, cursos
 *    publicados). Si un contador viene a 0, ese tile no se pinta.
 *
 * Sin tenant resuelto (dominio no mapeado, API caída) el panel sigue en pie con
 * la marca Didacta y sin cifras — el formulario nunca depende de esto.
 */

/** Mismo azul noche + tinte del sidebar: el panel es la misma superficie de marca. */
const BRAND_PANEL_STYLE: CSSProperties = {
  backgroundColor: 'var(--sidebar-bg, #0D1B2A)',
  backgroundImage:
    'linear-gradient(180deg, rgba(46,125,206,0.18) 0%, rgba(13,27,42,0) 38%, rgba(24,181,168,0.12) 100%)',
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('auth');
  const { tenant } = useTenantContext();
  const stats = tenant?.stats;
  // Copy por defecto cuando el tenant no configuró el suyo. Deliberadamente
  // neutro: no promete módulos que ese tenant puede no tener contratados.
  const headline = tenant?.headline?.trim() || t('layout.defaultHeadline');
  const subheadline = tenant?.subheadline?.trim() || null;
  const hasStats = !!stats && (stats.activeMembers > 0 || stats.publishedCourses > 0);

  return (
    <main className="min-h-dvh bg-bg-subtle lg:p-6">
      {/* Color de marca del tenant en una pantalla SIN sesión: el
          TenantThemeProvider del root solo puede pedir el theme con token, así
          que hasta ahora el login de cualquier tenant salía con el azul de
          Didacta. Los valores vienen de la API (enteros validados por
          mod.theming), y se inyectan tras el fetch — no en el primer render —
          para no romper la hidratación. */}
      {typeof tenant?.brandHue === 'number' ? (
        <style
          dangerouslySetInnerHTML={{
            __html: `:root{--brand-h:${Math.round(tenant.brandHue)};--brand-s:${Math.round(
              tenant.brandSaturation ?? 70,
            )}%;}`,
          }}
        />
      ) : null}
      <div className="mx-auto flex min-h-dvh w-full max-w-[1400px] flex-col overflow-hidden bg-surface lg:min-h-[calc(100dvh-3rem)] lg:flex-row lg:rounded-2xl lg:border lg:border-border-soft lg:shadow-xl">
        {/* ---------------- Panel de marca ---------------- */}
        <aside
          className="relative flex flex-col gap-8 px-6 py-8 text-white sm:px-10 lg:w-1/2 lg:justify-between lg:px-14 lg:py-14"
          style={BRAND_PANEL_STYLE}
        >
          <div className="flex items-center">
            {tenant?.logoUrl ? (
              // Marca del tenant (mod.theming). El src puede ser absoluto o
              // relativo al API same-origin; <img> lo resuelve sin next/image.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tenant.logoUrl}
                alt={tenant.name}
                className="h-10 w-auto max-w-[220px] object-contain object-left lg:h-14"
              />
            ) : (
              <span className="font-display text-2xl font-extrabold tracking-tight lg:text-3xl">
                {tenant?.name ?? 'Didacta'}
              </span>
            )}
          </div>

          <div className="lg:pb-2">
            {/* `text-white` va en el propio h2: la regla base de globals.css
                pinta los headings con --color-text y le gana al color heredado
                del contenedor (título negro sobre panel oscuro). */}
            <h2 className="font-display max-w-[16ch] text-[1.75rem] font-extrabold leading-[1.12] tracking-tight text-white sm:text-4xl lg:text-[3.25rem] lg:leading-[1.08]">
              {headline}
            </h2>
            {subheadline ? (
              <p className="mt-4 max-w-[42ch] text-sm text-white/70 lg:text-base">{subheadline}</p>
            ) : null}

            {/* Regla de acento, tintada al brand del tenant. */}
            <div
              aria-hidden="true"
              className="mt-6 h-1 w-24 rounded-full lg:mt-9"
              style={{ backgroundColor: 'hsl(var(--brand-h) 65% 62%)' }}
            />

            {hasStats ? (
              <dl className="mt-6 flex flex-wrap gap-x-12 gap-y-5 lg:mt-9">
                {stats.activeMembers > 0 ? (
                  <div>
                    <dt className="sr-only">{t('layout.activeMembersSr')}</dt>
                    <dd className="font-display text-3xl font-extrabold leading-none lg:text-4xl">
                      {formatNumber(stats.activeMembers)}
                    </dd>
                    <p className="mt-1.5 text-sm text-white/65">
                      {t('layout.activeMembersCount', { count: stats.activeMembers })}
                    </p>
                  </div>
                ) : null}
                {stats.publishedCourses > 0 ? (
                  <div>
                    <dt className="sr-only">{t('layout.publishedCoursesSr')}</dt>
                    <dd className="font-display text-3xl font-extrabold leading-none lg:text-4xl">
                      {formatNumber(stats.publishedCourses)}
                    </dd>
                    <p className="mt-1.5 text-sm text-white/65">
                      {t('layout.publishedCoursesCount', { count: stats.publishedCourses })}
                    </p>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </div>

          <p className="hidden text-sm text-white/45 lg:block">
            {t('layout.privateAccess', { name: tenant?.name ?? 'Didacta' })}
          </p>
        </aside>

        {/* ---------------- Formulario ---------------- */}
        <section className="flex flex-1 items-center justify-center px-6 py-10 sm:px-10 lg:w-1/2 lg:px-14 lg:py-14">
          <div className="w-full max-w-[26rem]">{children}</div>
        </section>
      </div>
    </main>
  );
}
