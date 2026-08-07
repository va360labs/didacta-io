'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · SSO desde WordPress (mod.wp-sso) — Community (sin gate EE).
 *
 * Toda la config vive cifrada en BD por tenant (NO env). El admin:
 *   1. Pega el secreto compartido (mismo que en wp-config.php), el home_url de
 *      WordPress y elige auto-redirect / auto-create.
 *   2. Copia la URL de callback (incluye el slug del tenant) en wp-config.php.
 *   3. Activa el toggle "Habilitado".
 * El secreto se cifra at-rest (AES-256-GCM) y nunca se devuelve en claro.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { wpSsoAdminApi, type WpSsoConfigPutBody, type WpSsoSafeConfig } from '@/lib/sso';

/** Pestaña "WordPress" de /admin/sso. Antes era la página `/admin/sso-wordpress`. */
export function WordpressTab() {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  const [serverConfig, setServerConfig] = useState<WpSsoSafeConfig | null>(null);
  const [callbackUrl, setCallbackUrl] = useState<string>('');

  const [form, setForm] = useState({
    enabled: false,
    sharedSecret: '', // SOLO local; se envía si no está vacío.
    issuer: '',
    audience: '',
    autoCreate: true,
    autoRedirect: false,
  });

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    const session = authStorage.getSession();
    const isAdmin = Boolean(
      session?.user.roles.some((r) => r === 'super_admin' || r === 'tenant_admin'),
    );
    setAllowed(isAdmin);
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) {
      setLoadError(t('sso.noToken'));
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const res = await wpSsoAdminApi.getConfig(token);
        if (res.exists) {
          setServerConfig(res.config);
          setCallbackUrl(res.config.callbackUrl);
          setForm({
            enabled: res.config.enabled,
            sharedSecret: '',
            issuer: res.config.issuer,
            audience: res.config.audience,
            autoCreate: res.config.autoCreate,
            autoRedirect: res.config.autoRedirect,
          });
        } else {
          setCallbackUrl(res.callbackUrl);
        }
      } catch (e) {
        setLoadError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('wordpress.loadError'),
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const tryUrl = useMemo(() => {
    const wp = form.issuer.trim().replace(/\/+$/, '');
    return wp ? `${wp}/?didacta_sso=try` : null;
  }, [form.issuer]);

  async function handleSave() {
    setActionError(null);
    setActionSuccess(null);
    const token = authStorage.getAccessToken();
    if (!token) return;

    const body: WpSsoConfigPutBody = {
      enabled: form.enabled,
      ...(form.sharedSecret.trim().length > 0 ? { sharedSecret: form.sharedSecret.trim() } : {}),
      issuer: form.issuer.trim(),
      audience: form.audience.trim(),
      autoCreate: form.autoCreate,
      autoRedirect: form.autoRedirect,
    };

    setSaving(true);
    try {
      const res = await wpSsoAdminApi.saveConfig(token, body);
      setServerConfig(res.config);
      setCallbackUrl(res.config.callbackUrl);
      setForm((prev) => ({ ...prev, sharedSecret: '' }));
      setActionSuccess(serverConfig ? t('wordpress.savedUpdated') : t('sso.savedCreated'));
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? formatApiError(e, tErrors) : t('sso.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(t('wordpress.deleteConfirm'))) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    const token = authStorage.getAccessToken();
    if (!token) return;
    setDeleting(true);
    try {
      await wpSsoAdminApi.deleteConfig(token);
      setServerConfig(null);
      setForm({
        enabled: false,
        sharedSecret: '',
        issuer: '',
        audience: '',
        autoCreate: true,
        autoRedirect: false,
      });
      setActionSuccess(t('sso.deleted'));
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('sso.deleteError'),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          {t('wordpress.title')}
        </h2>
        <p className="text-text-muted">{t('wordpress.subtitle')}</p>
      </header>

      {allowed === false ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm">
              {t.rich('wordpress.notAllowed', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-64 w-full" />
        </div>
      ) : loadError ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-danger-700">{loadError}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Estado */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon name="lock" size={18} />
                {t('wordpress.statusTitle')}
                <StatusBadge enabled={serverConfig?.enabled ?? false} hasConfig={!!serverConfig} />
              </CardTitle>
              <CardDescription>
                {serverConfig?.enabled
                  ? t('wordpress.statusEnabledDesc')
                  : serverConfig
                    ? t('wordpress.statusDisabledDesc')
                    : t('wordpress.statusEmptyDesc')}
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Formulario */}
          <Card>
            <CardHeader>
              <CardTitle>{t('wordpress.formTitle')}</CardTitle>
              <CardDescription>
                {t.rich('wordpress.formDesc', {
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* enabled */}
              <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold">{t('wordpress.enableLabel')}</p>
                  <p className="text-xs text-text-muted">{t('wordpress.enableHelp')}</p>
                </div>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(next) => setForm((p) => ({ ...p, enabled: next }))}
                  label={t('wordpress.enableLabel')}
                />
              </div>

              {/* sharedSecret */}
              <div className="space-y-1.5">
                <Label htmlFor="wp-secret">
                  {t('wordpress.secretLabel')}{' '}
                  {serverConfig?.hasSecret ? (
                    <span className="text-text-subtle text-xs">
                      {t('wordpress.secretKeepHint')}
                    </span>
                  ) : (
                    <span className="text-danger-700">*</span>
                  )}
                </Label>
                <Input
                  id="wp-secret"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    serverConfig?.hasSecret
                      ? t('sso.secretUnchangedPlaceholder')
                      : t('wordpress.secretPlaceholder')
                  }
                  value={form.sharedSecret}
                  onChange={(e) => setForm((p) => ({ ...p, sharedSecret: e.target.value }))}
                />
                <p className="text-xs text-text-subtle">
                  {t.rich('wordpress.secretHelp', {
                    code: (chunks) => <code className="font-mono">{chunks}</code>,
                  })}
                </p>
              </div>

              {/* issuer */}
              <div className="space-y-1.5">
                <Label htmlFor="wp-issuer">
                  {t('wordpress.issuerLabel')} <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="wp-issuer"
                  type="url"
                  inputMode="url"
                  placeholder={t('wordpress.issuerPlaceholder')}
                  value={form.issuer}
                  onChange={(e) => setForm((p) => ({ ...p, issuer: e.target.value }))}
                />
                <p className="text-xs text-text-subtle">
                  {t.rich('wordpress.issuerHelp', {
                    code: (chunks) => <code className="font-mono">{chunks}</code>,
                  })}
                </p>
              </div>

              {/* audience (avanzado) */}
              <div className="space-y-1.5">
                <Label htmlFor="wp-audience">
                  {t('wordpress.audienceLabel')}{' '}
                  <span className="text-text-subtle text-xs">{t('wordpress.audienceHint')}</span>
                </Label>
                <Input
                  id="wp-audience"
                  placeholder={t('wordpress.audiencePlaceholder')}
                  value={form.audience}
                  onChange={(e) => setForm((p) => ({ ...p, audience: e.target.value }))}
                />
                <p className="text-xs text-text-subtle">
                  {t.rich('wordpress.audienceHelp', {
                    code: (chunks) => <code className="font-mono">{chunks}</code>,
                  })}
                </p>
              </div>

              {/* autoRedirect */}
              <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold">{t('wordpress.autoRedirectLabel')}</p>
                  <p className="text-xs text-text-muted">{t('wordpress.autoRedirectHelp')}</p>
                </div>
                <Switch
                  checked={form.autoRedirect}
                  onCheckedChange={(next) => setForm((p) => ({ ...p, autoRedirect: next }))}
                  label={t('wordpress.autoRedirectLabel')}
                />
              </div>

              {/* autoCreate */}
              <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold">{t('sso.autoProvisionLabel')}</p>
                  <p className="text-xs text-text-muted">{t('wordpress.autoCreateHelp')}</p>
                </div>
                <Switch
                  checked={form.autoCreate}
                  onCheckedChange={(next) => setForm((p) => ({ ...p, autoCreate: next }))}
                  label={t('sso.autoProvisionLabel')}
                />
              </div>

              {/* callbackUrl (readonly) */}
              <div className="space-y-1.5">
                <Label>{t('wordpress.callbackLabel')}</Label>
                <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                  {callbackUrl || '—'}
                </code>
                <p className="text-xs text-text-subtle">
                  {t.rich('wordpress.callbackHelp', {
                    code: (chunks) => <code className="font-mono">{chunks}</code>,
                  })}
                </p>
              </div>

              {actionError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
                >
                  {actionError}
                </div>
              ) : null}
              {actionSuccess ? (
                <div
                  role="status"
                  className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-800"
                >
                  {actionSuccess}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2 pt-2">
                <Button type="button" onClick={handleSave} disabled={saving}>
                  {saving
                    ? t('sso.saving')
                    : serverConfig
                      ? t('sso.saveExisting')
                      : t('sso.saveNew')}
                </Button>
                {serverConfig ? (
                  <Button type="button" variant="ghost" onClick={handleDelete} disabled={deleting}>
                    {deleting ? t('sso.deleting') : t('sso.deleteButton')}
                  </Button>
                ) : null}
                {serverConfig?.enabled && tryUrl ? (
                  <a
                    href={tryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50"
                  >
                    {t('wordpress.tryBounce')}
                  </a>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatusBadge({ enabled, hasConfig }: { enabled: boolean; hasConfig: boolean }) {
  const t = useTranslations('adminSso');
  if (enabled) return <Badge className="bg-success-600 text-white">{t('sso.statusActive')}</Badge>;
  if (hasConfig) return <Badge variant="outline">{t('sso.statusDisabled')}</Badge>;
  return <Badge variant="outline">{t('sso.statusNotConfigured')}</Badge>;
}

function formatApiError(e: ApiHttpError, tErrors: TranslatorLike): string {
  if (e.issues && e.issues.length > 0) {
    const list = e.issues.map((iss) => `${iss.path}: ${iss.message}`).join('; ');
    return `${e.message} — ${list}`;
  }
  return apiErrorMessage(e, tErrors);
}
