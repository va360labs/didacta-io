'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Ajustes de avisos de suscripción (mod.payment-connections).
 *
 * Configuración del barrido diario de avisos: cada día a las 9:00 se envía a los
 * admins un resumen de suscripciones y a los miembros un aviso 7 días antes de
 * cada cobro con un enlace para cancelar. Como las claves de Stripe conectadas
 * son de solo lectura, el enlace del Customer Portal se pega aquí a mano.
 *
 * Solo super_admin. Todo el dato viene en vivo de la API (BD real). Cero datos
 * de cartón.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { subscriptionsDashboardApi } from '@/lib/payment-connections';

export function SubscriptionAlertsSettings() {
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
  const [portalUrl, setPortalUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const tk = authStorage.getAccessToken();
    if (!tk) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const { url } = await subscriptionsDashboardApi.getCancelPortalUrl(tk);
        setPortalUrl(url ?? '');
      } catch (e) {
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('alerts.loadError'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    const tk = authStorage.getAccessToken();
    if (!tk) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { url } = await subscriptionsDashboardApi.setCancelPortalUrl(tk, portalUrl.trim());
      setPortalUrl(url ?? '');
      setNotice(t('alerts.savedInfo'));
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('alerts.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    const tk = authStorage.getAccessToken();
    if (!tk) return;
    if (!window.confirm(t('alerts.runConfirm'))) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      await subscriptionsDashboardApi.runDailyNow(tk);
      setNotice(t('alerts.runLaunched'));
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('alerts.runError'));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('alerts.title')}</CardTitle>
        <p className="mt-1 text-sm text-text-muted">{t('alerts.subtitle')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-brand-500/30 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {notice}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cancel-portal-url">{t('alerts.portalUrlLabel')}</Label>
          <Input
            id="cancel-portal-url"
            value={portalUrl}
            onChange={(e) => setPortalUrl(e.target.value)}
            placeholder={t('alerts.portalUrlPh')}
            autoComplete="off"
            spellCheck={false}
            disabled={loading || saving}
          />
          <p className="text-xs text-text-muted">{t('alerts.portalUrlHint')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} disabled={loading || saving}>
            {saving ? t('alerts.savingCta') : t('alerts.saveCta')}
          </Button>
          <Button variant="secondary" onClick={() => void runNow()} disabled={running}>
            {running ? t('alerts.runningCta') : t('alerts.runCta')}
          </Button>
        </div>
        <p className="text-xs text-text-muted">{t('alerts.runHint')}</p>
      </CardContent>
    </Card>
  );
}
