'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · SSO con SAML 2.0 (9º piloto License SDK).
 *
 * Convención de gating EE:
 *   - Header h1 + descripción FUERA de <EeGate>.
 *   - Panel real DENTRO de <EeGate> con SamlUpsellCard fallback.
 *   - El backend gatea TODOS los endpoints admin con @RequiresCapability — esta
 *     página sólo es UX.
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
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import type { TranslatorLike } from '@/lib/i18n/labels';
import {
  samlAdminApi,
  buildSamlLoginUrl,
  type SamlConfigPutBody,
  type SamlConnectionProbe,
  type SamlSafeConfig,
  type SamlSpInfo,
} from '@/lib/sso-saml';

const DEFAULT_EMAIL_ATTR = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const DEFAULT_FIRST_NAME_ATTR = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname';
const DEFAULT_LAST_NAME_ATTR = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname';

/** Pestaña "SAML" de /admin/sso. Antes era la página `/admin/sso-saml`. */
export function SamlTab() {
  const t = useTranslations('adminSso');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold tracking-tight">{t('saml.title')}</h2>
        <p className="text-text-muted">{t('saml.subtitle')}</p>
      </header>

      <EeGate capability={LICENSE_CAPABILITIES.SSO_SAML} fallback={<SamlUpsellCard />}>
        <SamlPanel />
      </EeGate>
    </div>
  );
}

function SamlPanel() {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<{
    enabled: boolean;
    idpEntityId: string;
    idpSsoUrl: string;
    idpCertificate: string;
    emailAttr: string;
    firstNameAttr: string;
    lastNameAttr: string;
    allowedEmailDomainsCsv: string;
    autoProvisionUsers: boolean;
  }>({
    enabled: false,
    idpEntityId: '',
    idpSsoUrl: '',
    idpCertificate: '',
    emailAttr: DEFAULT_EMAIL_ATTR,
    firstNameAttr: DEFAULT_FIRST_NAME_ATTR,
    lastNameAttr: DEFAULT_LAST_NAME_ATTR,
    allowedEmailDomainsCsv: '',
    autoProvisionUsers: false,
  });

  const [serverConfig, setServerConfig] = useState<SamlSafeConfig | null>(null);
  const [spInfo, setSpInfo] = useState<SamlSpInfo | null>(null);
  const [tenantSlug, setTenantSlug] = useState<string>('');

  const [probe, setProbe] = useState<SamlConnectionProbe | null>(null);
  const [probing, setProbing] = useState<boolean>(false);

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
        const res = await samlAdminApi.getConfig(token);
        if (res.exists) {
          setServerConfig(res.config);
          setSpInfo({
            entityId: res.config.spEntityId,
            acsUrl: res.config.spAcsUrl,
            metadataUrl: res.config.spMetadataUrl,
          });
          setForm({
            enabled: res.config.enabled,
            idpEntityId: res.config.idpEntityId,
            idpSsoUrl: res.config.idpSsoUrl,
            idpCertificate: res.config.idpCertificate,
            emailAttr: res.config.attributeMapping.email,
            firstNameAttr: res.config.attributeMapping.firstName ?? '',
            lastNameAttr: res.config.attributeMapping.lastName ?? '',
            allowedEmailDomainsCsv: res.config.allowedEmailDomains.join(', '),
            autoProvisionUsers: res.config.autoProvisionUsers,
          });
        } else {
          setSpInfo(res.sp);
        }
      } catch (e) {
        setLoadError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('saml.loadError'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const startUrl = useMemo(() => {
    if (!tenantSlug) return null;
    if (typeof window === 'undefined') return buildSamlLoginUrl(tenantSlug);
    return `${window.location.origin}${buildSamlLoginUrl(tenantSlug)}`;
  }, [tenantSlug]);

  async function handleProbe() {
    setActionError(null);
    setActionSuccess(null);
    setProbe(null);
    if (!form.idpSsoUrl.trim() || !form.idpCertificate.trim()) {
      setActionError(t('saml.probeMissing'));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setProbing(true);
    try {
      const result = await samlAdminApi.testConnection(
        token,
        form.idpSsoUrl.trim(),
        form.idpCertificate.trim(),
      );
      setProbe(result);
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('saml.probeError'),
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

    const body: SamlConfigPutBody = {
      enabled: form.enabled,
      idpEntityId: form.idpEntityId.trim(),
      idpSsoUrl: form.idpSsoUrl.trim(),
      idpCertificate: form.idpCertificate.trim(),
      attributeMapping: {
        email: form.emailAttr.trim(),
        ...(form.firstNameAttr.trim() ? { firstName: form.firstNameAttr.trim() } : {}),
        ...(form.lastNameAttr.trim() ? { lastName: form.lastNameAttr.trim() } : {}),
      },
      allowedEmailDomains,
      autoProvisionUsers: form.autoProvisionUsers,
    };

    setSaving(true);
    try {
      const res = await samlAdminApi.saveConfig(token, body);
      setServerConfig(res.config);
      setSpInfo({
        entityId: res.config.spEntityId,
        acsUrl: res.config.spAcsUrl,
        metadataUrl: res.config.spMetadataUrl,
      });
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
    if (!window.confirm(t('saml.deleteConfirm'))) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    const token = authStorage.getAccessToken();
    if (!token) return;
    setDeleting(true);
    try {
      await samlAdminApi.deleteConfig(token);
      setServerConfig(null);
      setForm({
        enabled: false,
        idpEntityId: '',
        idpSsoUrl: '',
        idpCertificate: '',
        emailAttr: DEFAULT_EMAIL_ATTR,
        firstNameAttr: DEFAULT_FIRST_NAME_ATTR,
        lastNameAttr: DEFAULT_LAST_NAME_ATTR,
        allowedEmailDomainsCsv: '',
        autoProvisionUsers: false,
      });
      setProbe(null);
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="lock" size={18} />
            {t('saml.statusTitle')}
            <SamlStatusBadge enabled={serverConfig?.enabled ?? false} hasConfig={!!serverConfig} />
          </CardTitle>
          <CardDescription>
            {serverConfig?.enabled
              ? t('saml.statusEnabledDesc')
              : serverConfig
                ? t('sso.statusDisabledDesc')
                : t('saml.statusEmptyDesc')}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* SP info — el admin la copia al panel del IdP */}
      {spInfo ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('saml.spTitle')}</CardTitle>
            <CardDescription>{t('saml.spDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('saml.spEntityIdLabel')}</Label>
              <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                {spInfo.entityId}
              </code>
            </div>
            <div className="space-y-1.5">
              <Label>{t('saml.spAcsLabel')}</Label>
              <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                {spInfo.acsUrl}
              </code>
            </div>
            <div className="space-y-1.5">
              <Label>{t('saml.spMetadataLabel')}</Label>
              <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                {spInfo.metadataUrl}
              </code>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Form de la config IdP */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sso.idpConfigTitle')}</CardTitle>
          <CardDescription>
            {t.rich('saml.idpConfigDesc', {
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">{t('saml.enableLabel')}</p>
              <p className="text-xs text-text-muted">{t('saml.enableHelp')}</p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
              label={t('saml.enableLabel')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-entity-id">
              {t('saml.entityIdLabel')} <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="saml-entity-id"
              placeholder={t('saml.entityIdPlaceholder')}
              value={form.idpEntityId}
              onChange={(e) => setForm((prev) => ({ ...prev, idpEntityId: e.target.value }))}
            />
            <p className="text-xs text-text-subtle">
              {t.rich('saml.entityIdHelp', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-sso-url">
              {t('saml.ssoUrlLabel')} <span className="text-danger-700">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="saml-sso-url"
                type="url"
                inputMode="url"
                placeholder={t('saml.ssoUrlPlaceholder')}
                value={form.idpSsoUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, idpSsoUrl: e.target.value }))}
              />
              <Button type="button" variant="ghost" onClick={handleProbe} disabled={probing}>
                {probing ? t('sso.probing') : t('saml.probeButton')}
              </Button>
            </div>
            <p className="text-xs text-text-subtle">{t('saml.ssoUrlHelp')}</p>
            {probe ? <ProbeFeedback probe={probe} /> : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-cert">
              {t('saml.certLabel')} <span className="text-danger-700">*</span>
            </Label>
            <Textarea
              id="saml-cert"
              rows={8}
              placeholder={t('saml.certPlaceholder')}
              value={form.idpCertificate}
              onChange={(e) => setForm((prev) => ({ ...prev, idpCertificate: e.target.value }))}
              className="font-mono text-xs"
            />
            <p className="text-xs text-text-subtle">{t('saml.certHelp')}</p>
          </div>

          {/* Attribute mapping */}
          <div className="space-y-3 rounded-lg border border-border-soft bg-surface-2 p-4">
            <p className="text-sm font-semibold">{t('saml.attrTitle')}</p>
            <p className="text-xs text-text-muted">{t('saml.attrDesc')}</p>
            <div className="space-y-1.5">
              <Label htmlFor="saml-attr-email">
                {t('saml.attrEmailLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="saml-attr-email"
                value={form.emailAttr}
                onChange={(e) => setForm((prev) => ({ ...prev, emailAttr: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="saml-attr-first">{t('saml.attrFirstLabel')}</Label>
              <Input
                id="saml-attr-first"
                value={form.firstNameAttr}
                onChange={(e) => setForm((prev) => ({ ...prev, firstNameAttr: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="saml-attr-last">{t('saml.attrLastLabel')}</Label>
              <Input
                id="saml-attr-last"
                value={form.lastNameAttr}
                onChange={(e) => setForm((prev) => ({ ...prev, lastNameAttr: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-allowed-domains">
              {t('sso.allowedDomainsLabel')}{' '}
              <span className="text-text-subtle text-xs">{t('sso.optionalHint')}</span>
            </Label>
            <Input
              id="saml-allowed-domains"
              placeholder={t('sso.allowedDomainsPlaceholder')}
              value={form.allowedEmailDomainsCsv}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, allowedEmailDomainsCsv: e.target.value }))
              }
            />
            <p className="text-xs text-text-subtle">{t('saml.allowedDomainsHelp')}</p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">{t('sso.autoProvisionLabel')}</p>
              <p className="text-xs text-text-muted">
                {t.rich('saml.autoProvisionHelp', {
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
    </div>
  );
}

function SamlStatusBadge({ enabled, hasConfig }: { enabled: boolean; hasConfig: boolean }) {
  const t = useTranslations('adminSso');
  if (enabled) return <Badge className="bg-success-600 text-white">{t('sso.statusActive')}</Badge>;
  if (hasConfig) return <Badge variant="outline">{t('sso.statusDisabled')}</Badge>;
  return <Badge variant="outline">{t('sso.statusNotConfigured')}</Badge>;
}

function ProbeFeedback({ probe }: { probe: SamlConnectionProbe }) {
  const t = useTranslations('adminSso');
  if (probe.ok) {
    return (
      <div className="rounded-lg border border-success-200 bg-success-50 p-3 text-xs text-success-800">
        <p className="font-semibold">{t('saml.probeOk')}</p>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {probe.certSubject ? (
            <li>{t('saml.probeSubject', { value: probe.certSubject })}</li>
          ) : null}
          {probe.certNotAfter ? (
            <li>{t('saml.probeExpires', { value: probe.certNotAfter })}</li>
          ) : null}
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-xs text-danger-700">
      <p className="font-semibold">{t('saml.probeFailed')}</p>
      <p className="mt-1 font-mono text-[11px]">{probe.error}</p>
    </div>
  );
}

export function SamlUpsellCard() {
  const t = useTranslations('adminSso');
  return (
    <Card role="region" aria-label={t('saml.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('upsell.title')}
        </CardTitle>
        <CardDescription>{t('saml.upsellDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('saml.upsellCapability', {
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
    return t('saml.error402');
  }
  if (e.issues && e.issues.length > 0) {
    const list = e.issues.map((iss) => `${iss.path}: ${iss.message}`).join('; ');
    return `${e.message} — ${list}`;
  }
  return apiErrorMessage(e, tErrors);
}
