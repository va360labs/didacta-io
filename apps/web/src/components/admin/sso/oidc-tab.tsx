'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · SSO con OpenID Connect (8º piloto License SDK).
 *
 * Reglas:
 *   - El panel completo va envuelto en `<EeGate>` con `LICENSE_CAPABILITIES.SSO_OIDC`.
 *     Sin licencia EE → upsell card (mismo patrón que white-label, custom-domains,
 *     mfa-enforcement, scim).
 *   - El backend gatea TODOS los endpoints admin con @RequiresCapability — esta
 *     página sólo es UX. Sin la capability cualquier llamada vuelve con 402 vía
 *     LicenseExceptionFilter.
 *
 * Flujo end-to-end del admin:
 *   1. Pega el issuer URL del IdP → click "Probar discovery" → ✓ con endpoints
 *      o ✗ con motivo (sin guardar nada todavía).
 *   2. Pega clientId + clientSecret + scopes + dominios permitidos.
 *   3. Activa el toggle "Habilitado" → guarda.
 *   4. Comparte la URL `https://{tenant}/api/v1/auth/oidc/{slug}/start` con sus
 *      usuarios o el botón aparece directamente en /signin (cuando enabled=true).
 *   5. Para rotar el secret: pega el nuevo en el campo y guarda. Para no rotar:
 *      deja el campo vacío y se preserva el ya guardado.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
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
import {
  oidcAdminApi,
  buildOidcStartUrl,
  type OidcConfigPutBody,
  type OidcDiscoveryProbe,
  type OidcSafeConfig,
} from '@/lib/sso';

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

/** Pestaña "OIDC" de /admin/sso. Antes era la página `/admin/sso`. */
export function OidcTab() {
  const t = useTranslations('adminSso');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold tracking-tight">{t('oidc.title')}</h2>
        <p className="text-text-muted">{t('oidc.subtitle')}</p>
      </header>

      <EeGate capability={LICENSE_CAPABILITIES.SSO_OIDC} fallback={<SsoUpsellCard />}>
        <SsoPanel />
      </EeGate>
    </div>
  );
}

/**
 * Panel principal — sólo se renderiza cuando la capability está activa.
 */
function SsoPanel() {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Estado del form. Empieza vacío y se rellena con la config existente si la hay.
  const [form, setForm] = useState<{
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string; // SOLO local; se envía si no está vacío.
    allowedEmailDomainsCsv: string;
    autoProvisionUsers: boolean;
    scopes: string[];
  }>({
    enabled: false,
    issuer: '',
    clientId: '',
    clientSecret: '',
    allowedEmailDomainsCsv: '',
    autoProvisionUsers: false,
    scopes: DEFAULT_SCOPES,
  });

  // Vista safe del backend (incluye redirectUri y hasSecret).
  const [serverConfig, setServerConfig] = useState<OidcSafeConfig | null>(null);
  const [redirectUri, setRedirectUri] = useState<string>('');
  const [tenantSlug, setTenantSlug] = useState<string>('');

  // Estado del probe discovery (no persistido).
  const [discovery, setDiscovery] = useState<OidcDiscoveryProbe | null>(null);
  const [probing, setProbing] = useState<boolean>(false);

  // Acciones.
  const [saving, setSaving] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    const session = authStorage.getSession();
    if (session?.user.tenantSlug) setTenantSlug(session.user.tenantSlug);
    const token = authStorage.getAccessToken();
    if (!token) {
      setLoadError(t('sso.noToken'));
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const res = await oidcAdminApi.getConfig(token);
        if (res.exists) {
          setServerConfig(res.config);
          setRedirectUri(res.config.redirectUri);
          setForm({
            enabled: res.config.enabled,
            issuer: res.config.issuer,
            clientId: res.config.clientId,
            clientSecret: '',
            allowedEmailDomainsCsv: res.config.allowedEmailDomains.join(', '),
            autoProvisionUsers: res.config.autoProvisionUsers,
            scopes: res.config.scopes,
          });
        } else {
          setRedirectUri(res.redirectUri);
        }
      } catch (e) {
        setLoadError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('oidc.loadError'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const startUrl = useMemo(() => {
    if (!tenantSlug) return null;
    if (typeof window === 'undefined') return buildOidcStartUrl(tenantSlug);
    return `${window.location.origin}${buildOidcStartUrl(tenantSlug)}`;
  }, [tenantSlug]);

  async function handleProbe() {
    setActionError(null);
    setActionSuccess(null);
    setDiscovery(null);
    if (!form.issuer.trim()) {
      setActionError(t('oidc.probeMissingIssuer'));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setProbing(true);
    try {
      const probe = await oidcAdminApi.testDiscovery(token, form.issuer.trim());
      setDiscovery(probe);
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('oidc.probeError'),
      );
    } finally {
      setProbing(false);
    }
  }

  async function handleSave() {
    setActionError(null);
    setActionSuccess(null);
    const token = authStorage.getAccessToken();
    if (!token) return;

    const allowedEmailDomains = form.allowedEmailDomainsCsv
      .split(/[,\n]/)
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    const body: OidcConfigPutBody = {
      enabled: form.enabled,
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      ...(form.clientSecret.trim().length > 0 ? { clientSecret: form.clientSecret.trim() } : {}),
      allowedEmailDomains,
      autoProvisionUsers: form.autoProvisionUsers,
      scopes: form.scopes.filter((s) => s.trim().length > 0),
    };

    setSaving(true);
    try {
      const res = await oidcAdminApi.saveConfig(token, body);
      setServerConfig(res.config);
      setForm((prev) => ({ ...prev, clientSecret: '' }));
      setActionSuccess(serverConfig ? t('sso.savedUpdated') : t('sso.savedCreated'));
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? formatApiError(e, t, tErrors) : t('sso.saveError'),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(t('oidc.deleteConfirm'))) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    const token = authStorage.getAccessToken();
    if (!token) return;
    setDeleting(true);
    try {
      await oidcAdminApi.deleteConfig(token);
      setServerConfig(null);
      setForm({
        enabled: false,
        issuer: '',
        clientId: '',
        clientSecret: '',
        allowedEmailDomainsCsv: '',
        autoProvisionUsers: false,
        scopes: DEFAULT_SCOPES,
      });
      setDiscovery(null);
      setActionSuccess(t('sso.deleted'));
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('sso.deleteError'),
      );
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{loadError}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Estado actual */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="lock" size={18} />
            {t('oidc.statusTitle')}
            <SsoStatusBadge enabled={serverConfig?.enabled ?? false} hasConfig={!!serverConfig} />
          </CardTitle>
          <CardDescription>
            {serverConfig?.enabled
              ? t('oidc.statusEnabledDesc')
              : serverConfig
                ? t('sso.statusDisabledDesc')
                : t('oidc.statusEmptyDesc')}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Formulario */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sso.idpConfigTitle')}</CardTitle>
          <CardDescription>{t('oidc.idpConfigDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* enabled */}
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">{t('oidc.enableLabel')}</p>
              <p className="text-xs text-text-muted">{t('oidc.enableHelp')}</p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
              label={t('oidc.enableLabel')}
            />
          </div>

          {/* issuer */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-issuer">
              {t('oidc.issuerLabel')} <span className="text-danger-700">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="oidc-issuer"
                type="url"
                inputMode="url"
                placeholder={t('oidc.issuerPlaceholder')}
                value={form.issuer}
                onChange={(e) => setForm((prev) => ({ ...prev, issuer: e.target.value }))}
              />
              <Button type="button" variant="ghost" onClick={handleProbe} disabled={probing}>
                {probing ? t('sso.probing') : t('oidc.probeButton')}
              </Button>
            </div>
            <p className="text-xs text-text-subtle">
              {t.rich('oidc.issuerHelp', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
            {discovery ? <DiscoveryFeedback probe={discovery} /> : null}
          </div>

          {/* clientId */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-client-id">
              {t('oidc.clientIdLabel')} <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="oidc-client-id"
              placeholder={t('oidc.clientIdPlaceholder')}
              value={form.clientId}
              onChange={(e) => setForm((prev) => ({ ...prev, clientId: e.target.value }))}
            />
          </div>

          {/* clientSecret */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-client-secret">
              {t('oidc.clientSecretLabel')}{' '}
              {serverConfig?.hasSecret ? (
                <span className="text-text-subtle text-xs">{t('sso.secretKeepHint')}</span>
              ) : (
                <span className="text-danger-700">*</span>
              )}
            </Label>
            <Input
              id="oidc-client-secret"
              type="password"
              autoComplete="off"
              placeholder={
                serverConfig?.hasSecret
                  ? t('sso.secretUnchangedPlaceholder')
                  : t('oidc.clientSecretPlaceholder')
              }
              value={form.clientSecret}
              onChange={(e) => setForm((prev) => ({ ...prev, clientSecret: e.target.value }))}
            />
            <p className="text-xs text-text-subtle">{t('oidc.clientSecretHelp')}</p>
          </div>

          {/* scopes */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-scopes">{t('oidc.scopesLabel')}</Label>
            <Input
              id="oidc-scopes"
              placeholder={t('oidc.scopesPlaceholder')}
              value={form.scopes.join(' ')}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  scopes: e.target.value.split(/\s+/).filter((s) => s.length > 0),
                }))
              }
            />
            <p className="text-xs text-text-subtle">
              {t.rich('oidc.scopesHelp', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>

          {/* allowedEmailDomains */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-allowed-domains">
              {t('sso.allowedDomainsLabel')}{' '}
              <span className="text-text-subtle text-xs">{t('sso.optionalHint')}</span>
            </Label>
            <Input
              id="oidc-allowed-domains"
              placeholder={t('sso.allowedDomainsPlaceholder')}
              value={form.allowedEmailDomainsCsv}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, allowedEmailDomainsCsv: e.target.value }))
              }
            />
            <p className="text-xs text-text-subtle">{t('oidc.allowedDomainsHelp')}</p>
          </div>

          {/* autoProvisionUsers */}
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">{t('sso.autoProvisionLabel')}</p>
              <p className="text-xs text-text-muted">
                {t.rich('oidc.autoProvisionHelp', {
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
              </p>
            </div>
            <Switch
              checked={form.autoProvisionUsers}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, autoProvisionUsers: next }))}
              label={t('sso.autoProvisionLabel')}
            />
          </div>

          {/* redirectUri (readonly) */}
          <div className="space-y-1.5">
            <Label>{t('oidc.callbackLabel')}</Label>
            <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
              {redirectUri || '—'}
            </code>
            <p className="text-xs text-text-subtle">
              {t.rich('oidc.callbackHelp', {
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
              {saving ? t('sso.saving') : serverConfig ? t('sso.saveExisting') : t('sso.saveNew')}
            </Button>
            {serverConfig ? (
              <Button type="button" variant="ghost" onClick={handleDelete} disabled={deleting}>
                {deleting ? t('sso.deleting') : t('sso.deleteButton')}
              </Button>
            ) : null}
            {serverConfig?.enabled && startUrl ? (
              <a
                href={startUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50"
              >
                {t('sso.tryFlow')}
              </a>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Instrucciones */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="help" size={18} />
            {t('oidc.guideTitle')}
          </CardTitle>
          <CardDescription>{t('oidc.guideDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-semibold">{t('oidc.guideStep1Title')}</p>
            <p className="text-text-muted">
              {t.rich('oidc.guideStep1Desc', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('oidc.guideStep2Title')}</p>
            <p className="text-text-muted">
              {t.rich('oidc.guideStep2Desc', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('oidc.guideStep3Title')}</p>
            <p className="text-text-muted">
              {t.rich('oidc.guideStep3Desc', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('oidc.guideStep4Title')}</p>
            <p className="text-text-muted">{t('oidc.guideStep4Desc')}</p>
          </div>
          <div>
            <p className="font-semibold">{t('oidc.guideStep5Title')}</p>
            <p className="text-text-muted">{t('oidc.guideStep5Desc')}</p>
          </div>
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-warning-800">
            <p className="font-semibold">{t('oidc.guideNoteTitle')}</p>
            <p className="text-xs">
              {t.rich('oidc.guideNoteDesc', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
                link: (chunks) => <a href="/admin/usuarios">{chunks}</a>,
              })}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SsoStatusBadge({ enabled, hasConfig }: { enabled: boolean; hasConfig: boolean }) {
  const t = useTranslations('adminSso');
  if (enabled) return <Badge className="bg-success-600 text-white">{t('sso.statusActive')}</Badge>;
  if (hasConfig) return <Badge variant="outline">{t('sso.statusDisabled')}</Badge>;
  return <Badge variant="outline">{t('sso.statusNotConfigured')}</Badge>;
}

function DiscoveryFeedback({ probe }: { probe: OidcDiscoveryProbe }) {
  const t = useTranslations('adminSso');
  if (probe.ok) {
    return (
      <div className="rounded-lg border border-success-200 bg-success-50 p-3 text-xs text-success-800">
        <p className="font-semibold">{t('oidc.discoveryOk')}</p>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          <li>
            {t('oidc.discoveryAuthorizationEndpoint', { value: probe.authorizationEndpoint })}
          </li>
          <li>{t('oidc.discoveryTokenEndpoint', { value: probe.tokenEndpoint })}</li>
          <li>{t('oidc.discoveryJwksUri', { value: probe.jwksUri })}</li>
          <li>{t('oidc.discoveryIssuerEcho', { value: probe.issuer })}</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-xs text-danger-700">
      <p className="font-semibold">{t('oidc.discoveryFailed')}</p>
      <p className="mt-1 font-mono text-[11px]">{probe.error}</p>
    </div>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE).
 */
export function SsoUpsellCard() {
  const t = useTranslations('adminSso');
  return (
    <Card role="region" aria-label={t('oidc.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('upsell.title')}
        </CardTitle>
        <CardDescription>{t('oidc.upsellDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('oidc.upsellCapability', {
            chip: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
            ),
            code: (chunks) => <code className="font-mono">{chunks}</code>,
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

function formatApiError(e: ApiHttpError, t: TranslatorLike, tErrors: TranslatorLike): string {
  if (e.status === 402) {
    return t('oidc.error402');
  }
  if (e.issues && e.issues.length > 0) {
    const list = e.issues.map((iss) => `${iss.path}: ${iss.message}`).join('; ');
    return `${e.message} — ${list}`;
  }
  return apiErrorMessage(e, tErrors);
}
