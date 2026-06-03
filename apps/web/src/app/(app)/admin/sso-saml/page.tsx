'use client';

/**
 * Panel admin · SSO con SAML 2.0 (9º piloto License SDK).
 *
 * Sigue al pie de la letra `docs/UI-EE-GATING.md`:
 *   - Header h1 + descripción FUERA de <EeGate>.
 *   - Panel real DENTRO de <EeGate> con SamlUpsellCard fallback.
 *   - El backend gatea TODOS los endpoints admin con @RequiresCapability — esta
 *     página sólo es UX.
 */

import { useEffect, useMemo, useState } from 'react';
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

export default function AdminSamlSsoPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">SSO con SAML 2.0</h1>
        <p className="text-text-muted">
          Permite a tus usuarios iniciar sesión con su identidad corporativa usando SAML 2.0 (Okta,
          Azure AD, Auth0, OneLogin, ADFS, Keycloak…). Una vez configurado, aparece un botón
          &ldquo;Iniciar sesión con SSO&rdquo; en la pantalla de login del tenant.
        </p>
      </header>

      <EeGate capability={LICENSE_CAPABILITIES.SSO_SAML} fallback={<SamlUpsellCard />}>
        <SamlPanel />
      </EeGate>
    </div>
  );
}

function SamlPanel() {
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
      setLoadError('Sesión sin token. Vuelve a iniciar sesión.');
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
        setLoadError(
          e instanceof ApiHttpError ? e.message : 'No se pudo cargar la configuración SAML.',
        );
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
      setActionError('Completa la URL SSO y el certificado del IdP antes de probar.');
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
        e instanceof ApiHttpError ? e.message : 'No se pudo validar la conexión SAML.',
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
      setActionSuccess(
        serverConfig
          ? 'Configuración actualizada correctamente.'
          : 'Configuración creada correctamente.',
      );
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? formatApiError(e) : 'No se pudo guardar la configuración.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        '¿Eliminar la configuración SSO SAML? Los usuarios dejarán de poder loguearse con SSO inmediatamente.',
      )
    ) {
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
      setActionSuccess('Configuración eliminada.');
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo eliminar la configuración.',
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
            Estado SSO SAML
            <SamlStatusBadge enabled={serverConfig?.enabled ?? false} hasConfig={!!serverConfig} />
          </CardTitle>
          <CardDescription>
            {serverConfig?.enabled
              ? 'El botón de SSO SAML aparecerá en /signin y los usuarios podrán entrar con su IdP corporativo.'
              : serverConfig
                ? 'Hay configuración guardada pero está deshabilitada — el flow no se ofrece.'
                : 'Aún no has configurado un IdP. Empieza pegando los datos abajo.'}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* SP info — el admin la copia al panel del IdP */}
      {spInfo ? (
        <Card>
          <CardHeader>
            <CardTitle>Datos del SP (Didacta) para configurar en el IdP</CardTitle>
            <CardDescription>
              Pega estos valores en el panel del IdP cuando crees la aplicación SAML.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>SP Entity ID (Audience)</Label>
              <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                {spInfo.entityId}
              </code>
            </div>
            <div className="space-y-1.5">
              <Label>ACS URL (Reply / Single Sign-On URL)</Label>
              <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                {spInfo.acsUrl}
              </code>
            </div>
            <div className="space-y-1.5">
              <Label>Metadata URL (opcional, para IdPs que importan metadata)</Label>
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
          <CardTitle>Configuración del IdP</CardTitle>
          <CardDescription>
            Pega el Entity ID, la URL del SSO endpoint y el certificado X.509 (PEM) del IdP. Si tu
            IdP soporta &ldquo;descargar metadata&rdquo;, abre ese XML y copia los valores de{' '}
            <code className="font-mono">entityID</code>,{' '}
            <code className="font-mono">SingleSignOnService Location</code> y{' '}
            <code className="font-mono">X509Certificate</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">Habilitar SSO SAML</p>
              <p className="text-xs text-text-muted">
                Activa el botón &ldquo;Iniciar sesión con SSO&rdquo; en /signin.
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
              label="Habilitar SSO SAML"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-entity-id">
              IdP Entity ID <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="saml-entity-id"
              placeholder="https://idp.example.com/saml o urn:idp:example"
              value={form.idpEntityId}
              onChange={(e) => setForm((prev) => ({ ...prev, idpEntityId: e.target.value }))}
            />
            <p className="text-xs text-text-subtle">
              Identificador único del IdP. Lo encuentras como{' '}
              <code className="font-mono">entityID</code> en el metadata.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-sso-url">
              SSO URL (HTTP-Redirect binding) <span className="text-danger-700">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="saml-sso-url"
                type="url"
                inputMode="url"
                placeholder="https://idp.example.com/sso"
                value={form.idpSsoUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, idpSsoUrl: e.target.value }))}
              />
              <Button type="button" variant="ghost" onClick={handleProbe} disabled={probing}>
                {probing ? 'Probando…' : 'Probar conexión'}
              </Button>
            </div>
            <p className="text-xs text-text-subtle">
              URL a la que Didacta redirige para iniciar el login SAML. Debe ser HTTPS (acepta
              http://localhost para dev).
            </p>
            {probe ? <ProbeFeedback probe={probe} /> : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="saml-cert">
              Certificado IdP (X.509 PEM) <span className="text-danger-700">*</span>
            </Label>
            <Textarea
              id="saml-cert"
              rows={8}
              placeholder={'-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----'}
              value={form.idpCertificate}
              onChange={(e) => setForm((prev) => ({ ...prev, idpCertificate: e.target.value }))}
              className="font-mono text-xs"
            />
            <p className="text-xs text-text-subtle">
              Certificado público del IdP. Se usa para validar la firma de las SAMLResponse — sin
              este cert, ningún login se acepta.
            </p>
          </div>

          {/* Attribute mapping */}
          <div className="space-y-3 rounded-lg border border-border-soft bg-surface-2 p-4">
            <p className="text-sm font-semibold">Mapeo de atributos del Assertion</p>
            <p className="text-xs text-text-muted">
              Cada IdP nombra los attributes diferente. Los defaults cubren Okta / Azure AD / ADFS.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="saml-attr-email">
                Email <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="saml-attr-email"
                value={form.emailAttr}
                onChange={(e) => setForm((prev) => ({ ...prev, emailAttr: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="saml-attr-first">First name (opcional)</Label>
              <Input
                id="saml-attr-first"
                value={form.firstNameAttr}
                onChange={(e) => setForm((prev) => ({ ...prev, firstNameAttr: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="saml-attr-last">Last name (opcional)</Label>
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
              Dominios de email permitidos{' '}
              <span className="text-text-subtle text-xs">(opcional)</span>
            </Label>
            <Input
              id="saml-allowed-domains"
              placeholder="acme.com, partner.com"
              value={form.allowedEmailDomainsCsv}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, allowedEmailDomainsCsv: e.target.value }))
              }
            />
            <p className="text-xs text-text-subtle">
              Vacío = cualquier email del IdP es aceptado. Si listas, el ACS rechaza emails fuera de
              esos dominios incluso si el IdP los autenticó.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">Auto-provisionar usuarios</p>
              <p className="text-xs text-text-muted">
                Si está activo, el primer login crea automáticamente la cuenta con role{' '}
                <code className="font-mono">student</code>. Si está apagado, sólo dejan entrar
                usuarios que ya existen en el tenant.
              </p>
            </div>
            <Switch
              checked={form.autoProvisionUsers}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, autoProvisionUsers: next }))}
              label="Auto-provisionar usuarios"
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
              {saving ? 'Guardando…' : serverConfig ? 'Guardar cambios' : 'Crear configuración'}
            </Button>
            {serverConfig ? (
              <Button type="button" variant="ghost" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Eliminando…' : 'Eliminar configuración'}
              </Button>
            ) : null}
            {serverConfig?.enabled && startUrl ? (
              <a
                href={startUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50"
              >
                Probar flow ↗
              </a>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SamlStatusBadge({ enabled, hasConfig }: { enabled: boolean; hasConfig: boolean }) {
  if (enabled) return <Badge className="bg-success-600 text-white">Activo</Badge>;
  if (hasConfig) return <Badge variant="outline">Deshabilitado</Badge>;
  return <Badge variant="outline">Sin configurar</Badge>;
}

function ProbeFeedback({ probe }: { probe: SamlConnectionProbe }) {
  if (probe.ok) {
    return (
      <div className="rounded-lg border border-success-200 bg-success-50 p-3 text-xs text-success-800">
        <p className="font-semibold">✓ Cert + URL válidos</p>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {probe.certSubject ? <li>Subject: {probe.certSubject}</li> : null}
          {probe.certNotAfter ? <li>Expira: {probe.certNotAfter}</li> : null}
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-xs text-danger-700">
      <p className="font-semibold">✗ Validación falló</p>
      <p className="mt-1 font-mono text-[11px]">{probe.error}</p>
    </div>
  );
}

export function SamlUpsellCard() {
  return (
    <Card role="region" aria-label="SSO con SAML 2.0 (Enterprise)" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Función Enterprise — actualiza tu plan
        </CardTitle>
        <CardDescription>
          Single Sign-On con SAML 2.0 es parte del paquete Didacta Enterprise. Permite a tus
          usuarios entrar a Didacta con su identidad corporativa de Okta, Azure AD, Auth0, OneLogin,
          ADFS, Keycloak o cualquier IdP SAML-compatible.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            feat:sso.saml
          </code>
          . Sin Enterprise, los endpoints <code className="font-mono">/admin/sso/saml/*</code>{' '}
          devuelven <code className="font-mono">402 Payment Required</code> y los flows de login
          federado no se inician.
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Ver planes Enterprise
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}

function formatApiError(e: ApiHttpError): string {
  if (e.status === 402) {
    return 'Esta función requiere un plan Enterprise con la capability `feat:sso.saml`.';
  }
  if (e.issues && e.issues.length > 0) {
    const list = e.issues.map((iss) => `${iss.path}: ${iss.message}`).join('; ');
    return `${e.message} — ${list}`;
  }
  return e.message;
}
