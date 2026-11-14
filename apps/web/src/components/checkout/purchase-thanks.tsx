'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * LA PANTALLA DE GRACIAS (la vuelta del pago), con la piel y la marca del aula.
 *
 * Antes enseñaba «Referencia de pago: cs_live_…» y poco más. Ahora resume lo
 * que de verdad le importa a quien acaba de pagar: QUÉ compró (con su
 * portada), CUÁNTO pagó, CUÁNDO, y el siguiente paso («Entrar al curso»). El
 * id de la sesión de Stripe no se enseña.
 *
 * Y solo dice «gracias» si el pago consta: con el pago embebido se vuelve aquí
 * también cuando un medio con redirección falla, así que primero se pregunta
 * (`GET …/checkout-session/:id`). Si no se cobró, lo dice y deja reintentar; si
 * no se puede saber, no afirma ni niega. El acceso no lo da esta pantalla: lo
 * da el webhook.
 */

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/i18n/format';
import { formatCents } from '@/lib/membership';
import { rememberIntendedPath } from '@/lib/post-login-redirect';
import { initialsOf } from '@/lib/academy-home';
import { useTenantContext } from '@/lib/tenant-context';
import type { CheckoutOutcome } from '@/lib/checkout';

const FONT = { fontFamily: 'var(--font-figtree), var(--font-sans)' } as const;

export interface ThanksSummary {
  kind: 'course' | 'membership';
  title: string | null;
  imageUrl: string | null;
  amount: number | null;
  currency: string | null;
  at: string | null;
}

interface Props {
  outcome: CheckoutOutcome | 'checking';
  summary: ThanksSummary | null;
  /** ¿Hay sesión en este navegador? Cambia el siguiente paso. */
  signedIn: boolean;
  /** Adónde lleva «Entrar» (el curso comprado o los cursos de la membresía). */
  nextPath: string;
  /** Adónde se vuelve para reintentar un pago que no se completó. */
  retryHref: string;
}

export function PurchaseThanks({ outcome, summary, signedIn, nextPath, retryHref }: Props) {
  const t = useTranslations('publicSite.gracias');
  const locale = useLocale();

  if (outcome === 'checking') {
    return (
      <Shell testId="gracias-comprobando">
        <div className="flex items-center gap-3 text-text-muted" aria-live="polite">
          <span
            aria-hidden="true"
            className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600"
          />
          {t('checking')}
        </div>
      </Shell>
    );
  }

  if (outcome === 'unpaid') {
    return (
      <Shell testId="gracias-no-pagado">
        <StatusIcon tone="muted" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-[-0.01em]">{t('unpaidTitle')}</h1>
        <p className="mt-2 text-text-muted">{t('unpaidBody')}</p>
        <Button asChild className="mt-6">
          <Link href={retryHref as never}>{t('retry')}</Link>
        </Button>
      </Shell>
    );
  }

  if (outcome === 'unknown') {
    return (
      <Shell testId="gracias-sin-saber">
        <StatusIcon tone="muted" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-[-0.01em]">{t('unknownTitle')}</h1>
        <p className="mt-2 text-text-muted">{t('unknownBody')}</p>
      </Shell>
    );
  }

  const paid = outcome === 'paid';
  const amount =
    summary?.amount !== null && summary?.amount !== undefined && summary.currency
      ? formatCents(summary.amount, summary.currency, { locale })
      : null;
  const date = summary?.at
    ? formatDate(summary.at, { locale, day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const enterLabel = summary?.kind === 'membership' ? t('enterAcademy') : t('enterCourse');

  return (
    <Shell testId={paid ? 'gracias-pagado' : 'gracias-procesando'}>
      <StatusIcon tone={paid ? 'success' : 'muted'} />
      <h1 className="mt-4 text-2xl font-extrabold tracking-[-0.01em]" data-testid="gracias-titulo">
        {paid ? t('paidTitle') : t('pendingTitle')}
      </h1>
      {paid ? null : <p className="mt-2 text-text-muted">{t('pendingBody')}</p>}

      {summary?.title ? (
        <div
          className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface-2"
          data-testid="gracias-resumen"
        >
          <div className="flex gap-4 p-4">
            {summary.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={summary.imageUrl}
                alt=""
                className="h-20 w-32 shrink-0 rounded-xl object-cover"
                data-testid="gracias-portada"
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-text-subtle">
                {summary.kind === 'course' ? t('kindCourse') : t('kindMembership')}
              </p>
              <p className="font-bold leading-snug text-text" data-testid="gracias-producto">
                {summary.title}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px border-t border-border bg-border text-sm">
            <div className="bg-surface px-4 py-3">
              <dt className="text-text-subtle">{paid ? t('amountPaid') : t('amount')}</dt>
              <dd
                className="mt-0.5 text-lg font-extrabold tabular-nums"
                data-testid="gracias-importe"
              >
                {amount ?? '—'}
              </dd>
            </div>
            <div className="bg-surface px-4 py-3">
              <dt className="text-text-subtle">{t('date')}</dt>
              <dd className="mt-0.5 font-semibold" data-testid="gracias-fecha">
                {date ?? '—'}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      {paid ? (
        <div className="mt-6">
          <h2 className="text-[15px] font-bold">{t('nextStep')}</h2>
          {signedIn ? (
            <p className="mt-1 text-sm text-text-muted">{t('nextSignedIn')}</p>
          ) : (
            <p className="mt-1 text-sm text-text-muted">
              {t.rich('nextAnonymous', { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
          )}
          <Button asChild size="lg" className="mt-4 w-full sm:w-auto" data-testid="gracias-entrar">
            {signedIn ? (
              <Link href={nextPath as never}>
                {enterLabel}
                <Icon name="arrow-right" size={16} className="ml-1.5" />
              </Link>
            ) : (
              <Link href="/signin" onClick={() => rememberIntendedPath(nextPath)}>
                {enterLabel}
                <Icon name="arrow-right" size={16} className="ml-1.5" />
              </Link>
            )}
          </Button>
        </div>
      ) : null}
    </Shell>
  );
}

function Shell({ children, testId }: { children: React.ReactNode; testId: string }) {
  const { tenant } = useTenantContext();
  return (
    <div
      className="mx-auto w-full max-w-xl overflow-hidden rounded-3xl border border-border bg-surface shadow-sm"
      style={FONT}
      data-testid={testId}
    >
      {tenant ? (
        <div className="flex items-center gap-2.5 border-b border-border px-6 py-3.5 sm:px-8">
          {tenant.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={tenant.logoUrl}
              alt={tenant.logoDisplayMode === 'logo_only' ? tenant.name : ''}
              className={
                tenant.logoDisplayMode === 'logo_only'
                  ? 'h-8 max-w-[160px] object-contain'
                  : 'h-8 w-8 rounded-lg object-contain'
              }
            />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-xs font-extrabold text-white">
              {initialsOf(tenant.name)}
            </span>
          )}
          {tenant.logoUrl && tenant.logoDisplayMode === 'logo_only' ? null : (
            <span className="truncate font-bold text-text">{tenant.name}</span>
          )}
        </div>
      ) : null}
      <div className="p-6 sm:p-8">{children}</div>
    </div>
  );
}

function StatusIcon({ tone }: { tone: 'success' | 'muted' }) {
  return (
    <span
      className={
        tone === 'success'
          ? 'grid h-12 w-12 place-items-center rounded-full bg-success-100 text-success-700'
          : 'grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted'
      }
    >
      <Icon name={tone === 'success' ? 'check' : 'alert'} className="h-6 w-6" />
    </span>
  );
}
