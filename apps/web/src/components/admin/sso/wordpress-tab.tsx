'use client';

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
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { wpSsoAdminApi, type WpSsoConfigPutBody, type WpSsoSafeConfig } from '@/lib/sso';

export default function AdminWpSsoPage() {
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
      setLoadError('Sesión sin token. Vuelve a iniciar sesión.');
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
          e instanceof ApiHttpError ? e.message : 'No se pudo cargar la configuración WP-SSO.',
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
      setActionSuccess(
        serverConfig ? 'Configuración actualizada.' : 'Configuración creada correctamente.',
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
        '¿Eliminar la configuración WP-SSO? Los usuarios dejarán de poder entrar con WordPress.',
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
      setActionSuccess('Configuración eliminada.');
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo eliminar la configuración.',
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">SSO desde WordPress</h1>
        <p className="text-text-muted">
          Permite que tus usuarios ya logueados en tu WordPress entren a Didacta sin volver a
          iniciar sesión. Tu WordPress firma un token corto (HMAC) y Didacta lo verifica con el
          secreto compartido. Toda la config se guarda cifrada — nada en variables de entorno.
        </p>
      </header>

      {allowed === false ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm">
              Solo administradores (<strong>super_admin</strong> / <strong>tenant_admin</strong>)
              pueden configurar el SSO de WordPress.
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
                Estado WP-SSO
                <StatusBadge enabled={serverConfig?.enabled ?? false} hasConfig={!!serverConfig} />
              </CardTitle>
              <CardDescription>
                {serverConfig?.enabled
                  ? 'Activo: los usuarios con sesión en tu WordPress pueden entrar sin login.'
                  : serverConfig
                    ? 'Hay configuración guardada pero está deshabilitada.'
                    : 'Aún no has configurado WP-SSO. Rellena el formulario de abajo.'}
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Formulario */}
          <Card>
            <CardHeader>
              <CardTitle>Configuración</CardTitle>
              <CardDescription>
                Instala el plugin <code className="font-mono">didacta-sso</code> en tu WordPress y
                define en <code className="font-mono">wp-config.php</code> el secreto y la URL de
                callback de abajo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* enabled */}
              <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold">Habilitar WP-SSO</p>
                  <p className="text-xs text-text-muted">Activa el SSO para este tenant.</p>
                </div>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(next) => setForm((p) => ({ ...p, enabled: next }))}
                  label="Habilitar WP-SSO"
                />
              </div>

              {/* sharedSecret */}
              <div className="space-y-1.5">
                <Label htmlFor="wp-secret">
                  Secreto compartido{' '}
                  {serverConfig?.hasSecret ? (
                    <span className="text-text-subtle text-xs">(deja vacío para mantenerlo)</span>
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
                      ? '••••••••• (sin cambios)'
                      : 'el mismo que en wp-config.php'
                  }
                  value={form.sharedSecret}
                  onChange={(e) => setForm((p) => ({ ...p, sharedSecret: e.target.value }))}
                />
                <p className="text-xs text-text-subtle">
                  Mismo valor que <code className="font-mono">DIDACTA_SSO_SECRET</code> en
                  WordPress. Se cifra at-rest (AES-256-GCM). Mín 16 caracteres. Genera uno con{' '}
                  <code className="font-mono">openssl rand -hex 32</code>.
                </p>
              </div>

              {/* issuer */}
              <div className="space-y-1.5">
                <Label htmlFor="wp-issuer">
                  URL de tu WordPress (home_url) <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="wp-issuer"
                  type="url"
                  inputMode="url"
                  placeholder="https://tu-wordpress.com"
                  value={form.issuer}
                  onChange={(e) => setForm((p) => ({ ...p, issuer: e.target.value }))}
                />
                <p className="text-xs text-text-subtle">
                  Debe coincidir EXACTO con el <code className="font-mono">home_url</code> de tu
                  WordPress (es el destino del auto-bounce y el issuer esperado del token).
                </p>
              </div>

              {/* audience (avanzado) */}
              <div className="space-y-1.5">
                <Label htmlFor="wp-audience">
                  Audiencia <span className="text-text-subtle text-xs">(opcional, avanzado)</span>
                </Label>
                <Input
                  id="wp-audience"
                  placeholder="didacta-wp-sso"
                  value={form.audience}
                  onChange={(e) => setForm((p) => ({ ...p, audience: e.target.value }))}
                />
                <p className="text-xs text-text-subtle">
                  Vacío = <code className="font-mono">didacta-wp-sso</code> (el default del plugin).
                </p>
              </div>

              {/* autoRedirect */}
              <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold">Auto-redirect transparente</p>
                  <p className="text-xs text-text-muted">
                    El login de Didacta rebota a tu WordPress; si hay sesión, el usuario vuelve
                    autenticado sin tocar nada. Si no, vuelve en silencio al login normal.
                  </p>
                </div>
                <Switch
                  checked={form.autoRedirect}
                  onCheckedChange={(next) => setForm((p) => ({ ...p, autoRedirect: next }))}
                  label="Auto-redirect transparente"
                />
              </div>

              {/* autoCreate */}
              <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold">Auto-provisionar usuarios</p>
                  <p className="text-xs text-text-muted">
                    Si está activo, el primer SSO crea la cuenta (rol alumno). Si está apagado, solo
                    entran usuarios que ya existen en el tenant.
                  </p>
                </div>
                <Switch
                  checked={form.autoCreate}
                  onCheckedChange={(next) => setForm((p) => ({ ...p, autoCreate: next }))}
                  label="Auto-provisionar usuarios"
                />
              </div>

              {/* callbackUrl (readonly) */}
              <div className="space-y-1.5">
                <Label>URL de callback (pegar en wp-config.php)</Label>
                <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
                  {callbackUrl || '—'}
                </code>
                <p className="text-xs text-text-subtle">
                  En WordPress:{' '}
                  <code className="font-mono">
                    define(&apos;DIDACTA_SSO_CALLBACK&apos;, &apos;…&apos;)
                  </code>{' '}
                  con esta URL (incluye el identificador de tu tenant).
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
                {serverConfig?.enabled && tryUrl ? (
                  <a
                    href={tryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50"
                  >
                    Probar bounce ↗
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
  if (enabled) return <Badge className="bg-success-600 text-white">Activo</Badge>;
  if (hasConfig) return <Badge variant="outline">Deshabilitado</Badge>;
  return <Badge variant="outline">Sin configurar</Badge>;
}

function formatApiError(e: ApiHttpError): string {
  if (e.issues && e.issues.length > 0) {
    const list = e.issues.map((iss) => `${iss.path}: ${iss.message}`).join('; ');
    return `${e.message} — ${list}`;
  }
  return e.message;
}
