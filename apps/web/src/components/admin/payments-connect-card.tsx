'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta de cobros del aula. Elige qué enseñar según
 * `GET /modules/payouts/status`:
 *
 *  - Sin modo plataforma (la ruta no existe, Community): `whenPlatformOff`,
 *    que por defecto es la tarjeta de claves de Stripe de siempre.
 *  - Modo plataforma: «Conectar cobros» (país + tipo de titular → alta
 *    alojada de Stripe), «Falta algo» (→ «Completar») o «Todo listo» (→ panel
 *    de pagos en Stripe). Con claves propias heredadas (`mode: own`) se ve
 *    además la tarjeta de claves: conviven hasta que el alta llega a lista.
 *
 * El estado nunca se calcula aquí: lo da la API, que lo lee de Stripe. Al
 * volver del alta (`?return=1`) se pide con `sync=1`; si Stripe manda de vuelta
 * porque el enlace caducó (`?refresh=1`) se pide uno nuevo y se reenvía.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { StripeSettingsCard } from '@/components/admin/stripe-settings-card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { regionNameFormatter } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import {
  OTHER_COUNTRY,
  countryOptions,
  defaultCountry,
  derivePayoutsCardView,
  payoutsApi,
  type PayoutScheduleDto,
  type PayoutsEntityType,
  type PayoutsStatusDto,
} from '@/lib/payouts';

export interface PaymentsConnectCardProps {
  /** Inyectable para tests. */
  api?: typeof payoutsApi;
  /**
   * Qué pintar sin modo plataforma. Por defecto (`undefined`), la tarjeta de
   * claves de siempre; `null` = nada (la página de Cobros redirige).
   */
  whenPlatformOff?: ReactNode;
  /** Se llama una vez si la instalación NO está en modo plataforma. */
  onPlatformUnavailable?: () => void;
  /** Acción tras volver del alta (`?return=1`) o con el enlace caducado (`?refresh=1`). */
  returnAction?: 'sync' | 'renew' | null;
  /** Para limpiar la query de la URL tras procesarla. */
  onReturnHandled?: () => void;
  /**
   * Pantalla propia (Administración → Cobros): el título va como cabecera de
   * la página (h1) y la tarjeta no lo repite.
   */
  asPage?: boolean;
  /**
   * Estado ya pedido por quien la monta (el asistente de bienvenida lo
   * necesita antes para decidir sus pasos): se pinta tal cual, sin una segunda
   * petición ni el «Cargando…» intermedio. Sin `returnAction`, nada más.
   */
  initialStatus?: PayoutsStatusDto | null;
}

type Busy = 'connect' | 'finish' | 'dashboard' | 'sync' | null;

function useCountryName(locale: string) {
  return useMemo(() => regionNameFormatter(locale), [locale]);
}

export function PaymentsConnectCard({
  api = payoutsApi,
  whenPlatformOff,
  onPlatformUnavailable,
  returnAction = null,
  onReturnHandled,
  asPage = false,
  initialStatus,
}: PaymentsConnectCardProps): React.JSX.Element {
  const t = useTranslations('adminPagos.payouts');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const countryName = useCountryName(locale);

  const [status, setStatus] = useState<PayoutsStatusDto | null | undefined>(initialStatus);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [country, setCountry] = useState<string>('');
  const [entityType, setEntityType] = useState<PayoutsEntityType>('individual');
  const [rejectedCountry, setRejectedCountry] = useState<string | null>(null);

  const load = useCallback(
    async (sync: boolean) => {
      try {
        const next = await api.status({ sync });
        setStatus(next);
        setLoadError(null);
        if (next === null) onPlatformUnavailable?.();
        return next;
      } catch (err) {
        setLoadError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('loadError'));
        return undefined;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, onPlatformUnavailable],
  );

  useEffect(() => {
    let cancelled = false;
    if (initialStatus !== undefined && !returnAction) return;
    void (async () => {
      if (returnAction === 'renew') {
        // El enlace del alta caducó: uno nuevo y de vuelta a Stripe.
        setBusy('finish');
        try {
          const { url } = await api.onboardingLink();
          if (!cancelled) window.location.assign(url);
          return;
        } catch {
          setBusy(null);
          // Si no hay cuenta aún, se cae al estado normal.
        }
      }
      if (returnAction === 'sync') setBusy('sync');
      await load(returnAction === 'sync');
      if (!cancelled) {
        setBusy(null);
        if (returnAction) onReturnHandled?.();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, returnAction]);

  // Preselección: su cuenta > lo que declaró en el alta de Cloud > el navegador.
  useEffect(() => {
    if (status && !country) {
      const browser = typeof navigator !== 'undefined' ? navigator.language : locale;
      setCountry(
        defaultCountry(status.supportedCountries, browser, {
          account: status.account?.country,
          declared: status.declaredCountry,
        }),
      );
    }
  }, [status, country, locale]);

  const otherLabel = t('countryOther');
  const options = useMemo(
    () =>
      status
        ? countryOptions(status.supportedCountries, locale, {
            // Lo declarado y lo de la cuenta tienen que poder verse en el
            // selector aunque no se admitan («Otro país» incluido).
            extra: [status.declaredCountry, status.account?.country],
            otherLabel,
          })
        : [],
    [status, locale, otherLabel],
  );
  const selectedSupported = options.find((o) => o.code === country)?.supported ?? true;

  async function handleConnect(e: FormEvent): Promise<void> {
    e.preventDefault();
    setActionError(null);
    setRejectedCountry(null);
    if (!selectedSupported) {
      setRejectedCountry(country);
      return;
    }
    setBusy('connect');
    try {
      const { onboardingUrl } = await api.connect(country, entityType);
      if (onboardingUrl) {
        window.location.assign(onboardingUrl);
        return;
      }
      await load(false);
    } catch (err) {
      if (err instanceof ApiHttpError && err.code === 'PAYOUTS_COUNTRY_UNSUPPORTED') {
        setRejectedCountry(err.detail ?? country);
      } else if (err instanceof ApiHttpError && err.code === 'PAYOUTS_ACCOUNT_ALREADY_STARTED') {
        setActionError(t('alreadyStarted', { country: countryName(err.detail ?? country) }));
        await load(false);
      } else {
        setActionError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : String(err));
      }
    }
    setBusy(null);
  }

  async function handleFinish(): Promise<void> {
    setActionError(null);
    setBusy('finish');
    try {
      const { url } = await api.onboardingLink();
      window.location.assign(url);
      return;
    } catch (err) {
      setActionError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : String(err));
    }
    setBusy(null);
  }

  async function handleDashboard(): Promise<void> {
    setActionError(null);
    setBusy('dashboard');
    // La ventana se abre ANTES de la petición: abierta después de un await, el
    // navegador la trata como popup y la bloquea.
    const popup = window.open('', '_blank');
    try {
      const { url } = await api.dashboardLink();
      if (popup) {
        popup.opener = null;
        popup.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch (err) {
      popup?.close();
      setActionError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : String(err));
    }
    setBusy(null);
  }

  const view = derivePayoutsCardView(status ?? null);

  // Sin modo plataforma: lo de siempre.
  if (status === null) {
    return <>{whenPlatformOff === undefined ? <StripeSettingsCard /> : whenPlatformOff}</>;
  }

  const operator = status?.operatorName ?? '';

  return (
    <div className="space-y-6">
      {asPage ? (
        <header>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('title')}</h1>
          {status ? (
            <p className="mt-1 max-w-2xl text-text-muted">{t('subtitle', { operator })}</p>
          ) : null}
        </header>
      ) : null}
      <Card data-testid="payouts-card" data-state={status ? view.kind : 'loading'}>
        {asPage ? null : (
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
            {status ? <CardDescription>{t('subtitle', { operator })}</CardDescription> : null}
          </CardHeader>
        )}
        <CardContent className={asPage ? 'space-y-5 pt-6' : 'space-y-5'}>
          {loadError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {loadError}
            </div>
          ) : null}

          {status === undefined && !loadError ? (
            <p className="text-sm text-text-muted" aria-live="polite">
              {busy === 'sync' ? t('returnSyncing') : t('loading')}
            </p>
          ) : null}

          {status && view.kind === 'not-connected' ? (
            <form onSubmit={handleConnect} className="space-y-5" aria-busy={busy === 'connect'}>
              <StatusLine tone="neutral">{t('notConnected')}</StatusLine>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="payouts-country">{t('countryLabel')}</Label>
                  <NativeSelect
                    id="payouts-country"
                    value={country}
                    onChange={(e) => {
                      setCountry(e.target.value);
                      setRejectedCountry(null);
                    }}
                  >
                    {options.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <fieldset className="space-y-1.5">
                  <legend className="mb-1.5 text-sm font-medium text-text">
                    {t('entityLabel')}
                  </legend>
                  <div className="flex flex-col gap-2">
                    {(['individual', 'company'] as const).map((value) => (
                      <label
                        key={value}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border-strong px-3 py-2 text-[0.9375rem] has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50"
                      >
                        <input
                          type="radio"
                          name="payouts-entity"
                          value={value}
                          checked={entityType === value}
                          onChange={() => setEntityType(value)}
                          className="accent-brand-600"
                        />
                        {value === 'individual' ? t('entityIndividual') : t('entityCompany')}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              {rejectedCountry || !selectedSupported ? (
                <StatusLine tone="warning" testId="payouts-country-unsupported">
                  {(rejectedCountry ?? country) === OTHER_COUNTRY
                    ? t('countryUnsupportedOther')
                    : t('countryUnsupported', { country: countryName(rejectedCountry ?? country) })}
                </StatusLine>
              ) : null}
              <div className="border-t border-border-soft pt-4">
                <Button type="submit" disabled={busy !== null || !country || !selectedSupported}>
                  {busy === 'connect' ? t('connectingCta') : t('connectCta')}
                </Button>
              </div>
            </form>
          ) : null}

          {status && view.kind === 'missing' ? (
            <div className="space-y-4">
              <StatusLine tone="info">
                {t('missing', { requirement: t(`requirements.${view.requirement}`) })}
              </StatusLine>
              <Button type="button" onClick={() => void handleFinish()} disabled={busy !== null}>
                {busy === 'finish' ? t('connectingCta') : t('finishCta')}
              </Button>
            </div>
          ) : null}

          {status && view.kind === 'review' ? (
            <StatusLine tone="info">{t('review')}</StatusLine>
          ) : null}

          {status && view.kind === 'rejected' ? (
            <StatusLine tone="danger">{t('rejected')}</StatusLine>
          ) : null}

          {status && view.kind === 'country-unsupported' ? (
            <StatusLine tone="warning">
              {t('countryUnsupported', { country: countryName(view.country) })}
            </StatusLine>
          ) : null}

          {status && view.kind === 'ready' ? (
            <div className="space-y-4">
              <StatusLine tone="success">
                <ReadyText currency={view.currency} schedule={view.schedule} />
              </StatusLine>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleDashboard()}
                disabled={busy !== null}
              >
                {busy === 'dashboard' ? t('openingCta') : t('dashboardCta')}
              </Button>
            </div>
          ) : null}

          {actionError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {actionError}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {status && status.mode === 'own' ? (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">{t('ownKeysNote', { operator })}</p>
          <StripeSettingsCard />
        </div>
      ) : null}
    </div>
  );
}

function ReadyText({
  currency,
  schedule,
}: {
  currency: string | null;
  schedule: PayoutScheduleDto | null;
}): React.JSX.Element {
  const t = useTranslations('adminPagos.payouts');
  const code = (currency ?? 'eur').toLowerCase();
  // Claves dinámicas: `labelOr` con el código como respaldo (una divisa o un
  // día que el catálogo no conoce no rompe la frase).
  const currencyLabel = labelOr(t, `currencies.${code}`, code.toUpperCase());
  const dayKey =
    schedule?.interval === 'weekly'
      ? schedule.weeklyDay
      : schedule?.interval === 'daily' || schedule?.interval === 'monthly'
        ? schedule.interval
        : null;
  const day = dayKey ? labelOr(t, `days.${dayKey}`, '') : '';
  if (!day) return <>{t('readyNoSchedule', { currency: currencyLabel })}</>;
  return <>{t('ready', { currency: currencyLabel, day })}</>;
}

function StatusLine({
  tone,
  children,
  testId,
}: {
  /** `info`: algo que hacer o esperar (no es un error); `warning`: un «no» que no se arregla aquí. */
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger';
  children: ReactNode;
  testId?: string;
}): React.JSX.Element {
  const styles = {
    neutral: 'border-border-soft bg-surface-2 text-text',
    info: 'border-brand-100 bg-brand-50 text-brand-800',
    warning: 'border-warning-200 bg-warning-50 text-warning-700',
    success: 'border-success-200 bg-success-50 text-success-700',
    danger: 'border-danger-100 bg-danger-50 text-danger-700',
  }[tone];
  return (
    <p
      role="status"
      data-testid={testId}
      className={`rounded-lg border p-3.5 text-[0.9375rem] leading-relaxed ${styles}`}
    >
      {children}
    </p>
  );
}
