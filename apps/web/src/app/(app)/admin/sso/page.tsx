'use client';

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
 *      dejá el campo vacío y se preserva el ya guardado.
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
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  oidcAdminApi,
  buildOidcStartUrl,
  type OidcConfigPutBody,
  type OidcDiscoveryProbe,
  type OidcSafeConfig,
} from '@/lib/sso';

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

export default function AdminSsoPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">SSO con OpenID Connect</h1>
        <p className="text-text-muted">
          Permite a tus usuarios iniciar sesión con su identidad corporativa (Okta, Azure AD, Auth0,
          Google Workspace, Keycloak…). Una vez configurado, aparece un botón &ldquo;Iniciar sesión
          con SSO&rdquo; en la pantalla de login del tenant.
        </p>
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
      setLoadError('Sesión sin token. Volvé a iniciar sesión.');
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
        setLoadError(
          e instanceof ApiHttpError ? e.message : 'No se pudo cargar la configuración OIDC.',
        );
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
      setActionError('Pegá el issuer URL antes de probar.');
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
        e instanceof ApiHttpError ? e.message : 'No se pudo probar el discovery del IdP.',
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
        '¿Eliminar la configuración SSO? Los usuarios dejarán de poder loguearse con SSO inmediatamente.',
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
      {/* Estado actual */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="lock" size={18} />
            Estado SSO
            <SsoStatusBadge enabled={serverConfig?.enabled ?? false} hasConfig={!!serverConfig} />
          </CardTitle>
          <CardDescription>
            {serverConfig?.enabled
              ? 'El botón de SSO aparecerá en /signin y los usuarios podrán entrar con su IdP corporativo.'
              : serverConfig
                ? 'Hay configuración guardada pero está deshabilitada — el flow no se ofrece.'
                : 'Aún no has configurado un IdP. Empezá pegando el issuer URL abajo.'}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Formulario */}
      <Card>
        <CardHeader>
          <CardTitle>Configuración del IdP</CardTitle>
          <CardDescription>
            Necesitás haber dado de alta una aplicación &ldquo;OpenID Connect / Web&rdquo; en tu
            IdP. Pegá la URL de callback de abajo en su configuración como URI de redirección
            autorizada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* enabled */}
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">Habilitar SSO</p>
              <p className="text-xs text-text-muted">
                Activa el botón &ldquo;Iniciar sesión con SSO&rdquo; en /signin para este tenant.
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
              label="Habilitar SSO"
            />
          </div>

          {/* issuer */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-issuer">
              Issuer URL <span className="text-danger-700">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="oidc-issuer"
                type="url"
                inputMode="url"
                placeholder="https://tu-idp.example.com"
                value={form.issuer}
                onChange={(e) => setForm((prev) => ({ ...prev, issuer: e.target.value }))}
              />
              <Button type="button" variant="ghost" onClick={handleProbe} disabled={probing}>
                {probing ? 'Probando…' : 'Probar discovery'}
              </Button>
            </div>
            <p className="text-xs text-text-subtle">
              Debe ser HTTPS (acepta http://localhost para dev). Lo concatenamos con{' '}
              <code className="font-mono">/.well-known/openid-configuration</code> para descubrir
              endpoints.
            </p>
            {discovery ? <DiscoveryFeedback probe={discovery} /> : null}
          </div>

          {/* clientId */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-client-id">
              Client ID <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="oidc-client-id"
              placeholder="abc123-client-id"
              value={form.clientId}
              onChange={(e) => setForm((prev) => ({ ...prev, clientId: e.target.value }))}
            />
          </div>

          {/* clientSecret */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-client-secret">
              Client Secret{' '}
              {serverConfig?.hasSecret ? (
                <span className="text-text-subtle text-xs">
                  (dejá vacío para mantener el actual)
                </span>
              ) : (
                <span className="text-danger-700">*</span>
              )}
            </Label>
            <Input
              id="oidc-client-secret"
              type="password"
              autoComplete="off"
              placeholder={
                serverConfig?.hasSecret ? '••••••••• (sin cambios)' : 'pegá el secret del IdP'
              }
              value={form.clientSecret}
              onChange={(e) => setForm((prev) => ({ ...prev, clientSecret: e.target.value }))}
            />
            <p className="text-xs text-text-subtle">
              Se cifra at-rest con AES-256-GCM. Mín 16 caracteres cuando se escribe.
            </p>
          </div>

          {/* scopes */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-scopes">Scopes</Label>
            <Input
              id="oidc-scopes"
              placeholder="openid email profile"
              value={form.scopes.join(' ')}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  scopes: e.target.value.split(/\s+/).filter((s) => s.length > 0),
                }))
              }
            />
            <p className="text-xs text-text-subtle">
              <code className="font-mono">openid</code> es obligatorio. Otros comunes:{' '}
              <code className="font-mono">email</code>, <code className="font-mono">profile</code>,{' '}
              <code className="font-mono">offline_access</code>.
            </p>
          </div>

          {/* allowedEmailDomains */}
          <div className="space-y-1.5">
            <Label htmlFor="oidc-allowed-domains">
              Dominios de email permitidos{' '}
              <span className="text-text-subtle text-xs">(opcional)</span>
            </Label>
            <Input
              id="oidc-allowed-domains"
              placeholder="acme.com, partner.com"
              value={form.allowedEmailDomainsCsv}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, allowedEmailDomainsCsv: e.target.value }))
              }
            />
            <p className="text-xs text-text-subtle">
              Vacío = cualquier email del IdP es aceptado. Si listás, el callback rechaza emails
              fuera de esos dominios incluso si el IdP los autenticó.
            </p>
          </div>

          {/* autoProvisionUsers */}
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
            <div>
              <p className="text-sm font-semibold">Auto-provisionar usuarios</p>
              <p className="text-xs text-text-muted">
                Si está activo, el primer login crea automáticamente la cuenta con role{' '}
                <code className="font-mono">student</code>. Si está apagado, sólo dejan entrar
                usuarios que ya existen en el tenant (provisionados por SCIM o manualmente).
              </p>
            </div>
            <Switch
              checked={form.autoProvisionUsers}
              onCheckedChange={(next) => setForm((prev) => ({ ...prev, autoProvisionUsers: next }))}
              label="Auto-provisionar usuarios"
            />
          </div>

          {/* redirectUri (readonly) */}
          <div className="space-y-1.5">
            <Label>URL de callback (pegar en el IdP)</Label>
            <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
              {redirectUri || '—'}
            </code>
            <p className="text-xs text-text-subtle">
              Configurala en el IdP como &ldquo;Redirect URI&rdquo; / &ldquo;Authorized redirect
              URI&rdquo;. Si tu API está detrás de un proxy con dominio público distinto, override
              con la env var <code className="font-mono">OIDC_REDIRECT_URI</code>.
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

      {/* Instrucciones */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="help" size={18} />
            Configurar tu IdP
          </CardTitle>
          <CardDescription>
            Pasos genéricos que aplican a la mayoría de IdPs (Okta, Azure AD, Auth0, Google
            Workspace, Keycloak). Los nombres de campos pueden variar levemente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-semibold">1. Crear app OIDC en el IdP</p>
            <p className="text-text-muted">
              Tipo de aplicación: <strong>Web</strong> o <strong>OIDC Web Application</strong>.
              Authorization Code Flow con PKCE.
            </p>
          </div>
          <div>
            <p className="font-semibold">2. Configurar el redirect URI</p>
            <p className="text-text-muted">
              Pegá la URL de callback (la de arriba) en el campo{' '}
              <code className="font-mono">Sign-in redirect URIs</code> /{' '}
              <code className="font-mono">Authorized redirect URIs</code>.
            </p>
          </div>
          <div>
            <p className="font-semibold">3. Copiar issuer + clientId + clientSecret</p>
            <p className="text-text-muted">
              Pegá el issuer URL del IdP arriba (sin <code className="font-mono">/.well-known</code>
              ), y el clientId / clientSecret que el IdP genere. Para Okta el issuer es{' '}
              <code className="font-mono">https://&#123;tu-org&#125;.okta.com/oauth2/default</code>.
              Para Azure AD:{' '}
              <code className="font-mono">
                https://login.microsoftonline.com/&#123;tenant&#125;/v2.0
              </code>
              .
            </p>
          </div>
          <div>
            <p className="font-semibold">4. Probar discovery</p>
            <p className="text-text-muted">
              Click &ldquo;Probar discovery&rdquo; — debería responder con los endpoints. Si falla,
              revisá que el issuer sea HTTPS y accesible desde el server.
            </p>
          </div>
          <div>
            <p className="font-semibold">5. Habilitar y probar el flow</p>
            <p className="text-text-muted">
              Toggle &ldquo;Habilitar SSO&rdquo; → guardar → click &ldquo;Probar flow&rdquo;. Te
              redirige al IdP y vuelve loguead@.
            </p>
          </div>
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-warning-800">
            <p className="font-semibold">Nota: scope acotado en este piloto</p>
            <p className="text-xs">
              1 IdP por tenant, sólo Authorization Code + PKCE, sin role mapping desde el IdP. Los
              usuarios provisionados automáticamente reciben role{' '}
              <code className="font-mono">student</code>; los admins lo cambian luego en{' '}
              <a href="/admin/usuarios">Usuarios</a>.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SsoStatusBadge({ enabled, hasConfig }: { enabled: boolean; hasConfig: boolean }) {
  if (enabled) return <Badge className="bg-success-600 text-white">Activo</Badge>;
  if (hasConfig) return <Badge variant="outline">Deshabilitado</Badge>;
  return <Badge variant="outline">Sin configurar</Badge>;
}

function DiscoveryFeedback({ probe }: { probe: OidcDiscoveryProbe }) {
  if (probe.ok) {
    return (
      <div className="rounded-lg border border-success-200 bg-success-50 p-3 text-xs text-success-800">
        <p className="font-semibold">✓ Discovery OK</p>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          <li>authorization_endpoint: {probe.authorizationEndpoint}</li>
          <li>token_endpoint: {probe.tokenEndpoint}</li>
          <li>jwks_uri: {probe.jwksUri}</li>
          <li>issuer (echo): {probe.issuer}</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-xs text-danger-700">
      <p className="font-semibold">✗ Discovery falló</p>
      <p className="mt-1 font-mono text-[11px]">{probe.error}</p>
    </div>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE).
 */
export function SsoUpsellCard() {
  return (
    <Card role="region" aria-label="SSO con OIDC (Enterprise)" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Función Enterprise — actualiza tu plan
        </CardTitle>
        <CardDescription>
          Single Sign-On con OpenID Connect es parte del paquete Didacta Enterprise. Permite a tus
          usuarios entrar a Didacta con su identidad corporativa de Okta, Azure AD, Auth0, Google
          Workspace, Keycloak o cualquier IdP OIDC-compatible.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            feat:sso.oidc
          </code>
          . Sin Enterprise, los endpoints <code className="font-mono">/admin/sso/oidc/*</code>{' '}
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
    return 'Esta función requiere un plan Enterprise con la capability `feat:sso.oidc`.';
  }
  if (e.issues && e.issues.length > 0) {
    const list = e.issues.map((iss) => `${iss.path}: ${iss.message}`).join('; ');
    return `${e.message} — ${list}`;
  }
  return e.message;
}
