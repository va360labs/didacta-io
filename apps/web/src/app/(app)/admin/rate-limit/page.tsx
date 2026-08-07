'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Límites API (sexto piloto License SDK).
 *
 * Reglas:
 *   - El panel informativo es SIEMPRE visible (a diferencia del panel de
 *     dominios/branding/etc., que se ocultaba completo en community). La
 *     idea es que el admin community pueda ver "estás en X req/min" y
 *     comparar con "podrías estar en Y req/min" sin tener que hablar con
 *     ventas para pedir un demo. El endpoint backend tampoco está gateado.
 *   - El botón "Upgrade a Enterprise" SÍ va envuelto en `<EeGate>` con
 *     `negate` (se muestra solo cuando la capability NO está activa) —
 *     el patrón es inverso al resto de pilotos.
 *   - Sin licencia EE, además del badge "community" mostramos un comparativo
 *     con las cifras enterprise para hacer el upsell claro.
 *
 * Endpoint backend: `GET /api/v1/admin/rate-limit/info`. El backend impone
 * el rate limit real vía `RateLimitInterceptor` (global) — esta página solo
 * lee la configuración, no la modifica.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LICENSE_CAPABILITIES, useLicense } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { rateLimitApi, type RateLimitInfo } from '@/lib/rate-limit';

export default function AdminRateLimitPage() {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [info, setInfo] = useState<RateLimitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await rateLimitApi.info(token);
        setInfo(fresh);
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('rateLimit.loadError'),
        );
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('rateLimit.title')}</h1>
        <p className="text-text-muted">
          {t.rich('rateLimit.subtitle', {
            code: (chunks) => <code>{chunks}</code>,
            codeMono: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-danger-700">{error}</CardContent>
        </Card>
      ) : info === null ? (
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-32 w-full" />
        </div>
      ) : (
        <RateLimitPanel info={info} />
      )}
    </div>
  );
}

/**
 * Panel con badge del tier activo + tabla de límites por bucket. Si el tier
 * efectivo es `community`, además muestra una tarjeta de upsell con la
 * comparativa enterprise.
 */
function RateLimitPanel({ info }: { info: RateLimitInfo }) {
  const t = useTranslations('adminApi');
  const isEnterprise = info.tier === 'enterprise';

  return (
    <div className="flex flex-col gap-6">
      {/* Tier activo */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="trending" size={18} />
            {t('rateLimit.activePlan')}
            <TierBadge tier={info.tier} />
          </CardTitle>
          <CardDescription>
            {t('rateLimit.capabilityLabel')}{' '}
            <code className="font-mono text-xs">{info.capability}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">{t('rateLimit.colBucket')}</th>
                  <th className="px-4 py-2 text-left font-semibold">
                    {t('rateLimit.colEffectiveLimit')}
                  </th>
                  <th className="px-4 py-2 text-left font-semibold">{t('rateLimit.colWindow')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('rateLimit.rowAuthenticated')}</td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.reqCount', { limit: String(info.authenticated.limit) })}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.windowSeconds', {
                      seconds: String(info.authenticated.windowSeconds),
                    })}
                  </td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('rateLimit.rowPublic')}</td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.reqCount', { limit: String(info.public.limit) })}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.windowSeconds', { seconds: String(info.public.windowSeconds) })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Comparativa community vs enterprise */}
      <Card>
        <CardHeader>
          <CardTitle>{t('rateLimit.planComparison')}</CardTitle>
          <CardDescription>{t('rateLimit.planComparisonDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">{t('rateLimit.colBucket')}</th>
                  <th className="px-4 py-2 text-left font-semibold">{t('tier.community')}</th>
                  <th className="px-4 py-2 text-left font-semibold">{t('tier.enterprise')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('rateLimit.rowAuth')}</td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.reqPerMin', { count: String(info.community.authenticated) })}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.reqPerMin', { count: String(info.enterprise.authenticated) })}
                  </td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('rateLimit.rowPub')}</td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.reqPerMin', { count: String(info.community.public) })}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {t('rateLimit.reqPerMin', { count: String(info.enterprise.public) })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {!isEnterprise ? <UpgradeCta /> : null}
    </div>
  );
}

/**
 * Badge visual del tier — verde para enterprise, gris discreto para community.
 */
function TierBadge({ tier }: { tier: RateLimitInfo['tier'] }) {
  const t = useTranslations('adminApi');
  if (tier === 'enterprise') {
    return <Badge className="bg-success-600 text-white">{t('tier.enterprise')}</Badge>;
  }
  return <Badge variant="outline">{t('tier.community')}</Badge>;
}

/**
 * Llamada a la acción de upgrade. Va envuelta en `<EeGate>` invertido — el
 * `fallback` es lo que se muestra cuando la capability NO está activa, es
 * decir, exactamente el botón de upsell. Cuando la capability SÍ está, no
 * renderiza nada (no tiene sentido mostrar "actualiza" a alguien que ya
 * tiene EE).
 */
function UpgradeCta() {
  const t = useTranslations('adminApi');
  // Hook puro — usamos useLicense() en lugar de <EeGate> aquí porque
  // necesitamos el comportamiento "renderizar SI NO tiene la capability"
  // (negative gate). El componente <EeGate> está pensado para el caso
  // positivo y en este piloto el patrón se invierte para el botón.
  const { isCapabilityEnabled } = useLicense();
  if (isCapabilityEnabled(LICENSE_CAPABILITIES.API_RATE_LIMIT_ELEVATED)) {
    return null;
  }
  return (
    <Card role="region" aria-label={t('rateLimit.upgradeAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('rateLimit.upgradeTitle')}
        </CardTitle>
        <CardDescription>{t('rateLimit.upgradeDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('rateLimit.seePlans')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
