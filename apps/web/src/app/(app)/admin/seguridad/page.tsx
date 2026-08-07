'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Seguridad → Política MFA tenant-wide (tercer piloto License SDK).
 *
 * Reglas:
 *   - El toggle "Requerir MFA a todos los usuarios" se gatea con `<EeGate>`
 *     usando `LICENSE_CAPABILITIES.MFA_ENFORCEMENT`. Sin licencia EE se
 *     muestra una upsell card (mismo patrón que `WhiteLabelUpsellCard`).
 *   - El backend GATEA además el PUT — la UI es solo UX. Cualquier intento de
 *     persistir sin la capability vuelve con 402 vía LicenseExceptionFilter.
 *   - El grace period es siempre editable desde la UI siempre que la
 *     capability esté activa; en plan community el card entero se reemplaza
 *     por la upsell.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { MFA_GRACE_PERIOD_OPTIONS_DAYS, mfaPolicyApi, type MfaPolicyState } from '@/lib/mfa-policy';

export default function AdminSeguridadPage() {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [state, setState] = useState<MfaPolicyState | null>(null);
  const [requiredForAll, setRequiredForAll] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState<number>(7);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await mfaPolicyApi.get(token);
        setState(fresh);
        setRequiredForAll(fresh.policy.requiredForAll);
        setGracePeriodDays(fresh.policy.gracePeriodDays);
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('seguridad.loadError'),
        );
      }
    })();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    setStatus('saving');
    setError(null);
    try {
      const updated = await mfaPolicyApi.update(token, {
        requiredForAll,
        gracePeriodDays,
      });
      setState(updated);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setStatus('error');
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('seguridad.updateError'),
      );
    }
  }

  if (!state && !error) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-bold">{t('seguridad.title')}</h1>
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-48 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('seguridad.title')}</h1>
        <p className="text-text-muted">{t('seguridad.subtitle')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="shield" size={18} />
            {t('seguridad.currentStatus')}
          </CardTitle>
          <CardDescription>
            {t.rich('seguridad.currentStatusDesc', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-text-muted">{t('seguridad.planLabel')}</span>
          {state?.licensed ? (
            <Badge variant="outline" className="border-success-200 bg-success-50 text-success-700">
              {t('seguridad.planEnterprise')}
            </Badge>
          ) : (
            <Badge variant="outline">{t('seguridad.planCommunity')}</Badge>
          )}
          <span className="text-text-muted">·</span>
          <span className="text-text-muted">{t('seguridad.enforcementLabel')}</span>
          {state?.enforcementActive ? (
            <Badge className="bg-success-600 text-white">{t('seguridad.enforcementActive')}</Badge>
          ) : (
            <Badge variant="outline">{t('seguridad.enforcementInactive')}</Badge>
          )}
        </CardContent>
      </Card>

      {/*
       * Política MFA — toggle + grace period. La capability EE
       * `feat:mfa.enforcement` desbloquea la sección entera. Si no hay
       * licencia, mostramos `MfaEnforcementUpsellCard`.
       */}
      <EeGate
        capability={LICENSE_CAPABILITIES.MFA_ENFORCEMENT}
        fallback={<MfaEnforcementUpsellCard />}
      >
        <Card>
          <CardHeader>
            <CardTitle>{t('seguridad.policyTitle')}</CardTitle>
            <CardDescription>{t('seguridad.policyDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={requiredForAll}
                  onChange={(e) => setRequiredForAll(e.target.checked)}
                  className="mt-1 h-4 w-4 cursor-pointer rounded border-border text-brand-600 focus:ring-brand-300"
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-text">
                    {t('seguridad.requireAllLabel')}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {t('seguridad.requireAllHelp')}
                  </span>
                </span>
              </label>

              <div className="flex max-w-sm flex-col gap-1.5">
                <Label htmlFor="gracePeriodDays">{t('seguridad.gracePeriodLabel')}</Label>
                <Select
                  id="gracePeriodDays"
                  value={String(gracePeriodDays)}
                  onChange={(e) => setGracePeriodDays(Number(e.target.value))}
                >
                  {MFA_GRACE_PERIOD_OPTIONS_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {t('seguridad.graceDays', { days: d })}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-text-subtle">{t('seguridad.gracePeriodHelp')}</p>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={status === 'saving'}>
                  {status === 'saving' ? t('seguridad.saving') : t('seguridad.saveButton')}
                </Button>
                {status === 'saved' ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-700">
                    <Icon name="check" size={16} />
                    {t('seguridad.saved')}
                  </span>
                ) : null}
                {status === 'error' && error ? (
                  <span className="text-sm font-semibold text-danger-700">{error}</span>
                ) : null}
              </div>
            </form>

            {state?.policy.updatedAt ? (
              <p className="mt-6 text-xs text-text-subtle">
                {state.policy.updatedBy
                  ? t('seguridad.lastUpdatedBy', {
                      date: formatDateTime(state.policy.updatedAt),
                      name: state.policy.updatedBy,
                    })
                  : t('seguridad.lastUpdated', {
                      date: formatDateTime(state.policy.updatedAt),
                    })}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </EeGate>

      {error && !state ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE). Mismo patrón que
 * `WhiteLabelUpsellCard`. Recordatorio: el backend gatea la mutación con
 * @RequiresCapability — esto solo es UX.
 */
function MfaEnforcementUpsellCard() {
  const t = useTranslations('adminSso');
  return (
    <Card role="region" aria-label={t('seguridad.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('upsell.title')}
        </CardTitle>
        <CardDescription>{t('seguridad.upsellDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('seguridad.upsellCapability', {
            chip: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
            ),
          })}
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('upsell.cta')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
