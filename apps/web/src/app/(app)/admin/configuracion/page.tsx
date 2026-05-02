'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  adminNotificationsApi,
  type NotificationChannel,
  type NotificationTemplateOverride,
} from '@/lib/admin-notifications';
import { adminModulesApi, type TenantModuleListItem } from '@/lib/admin-modules';
import { meApi } from '@/lib/me';
import { adminTenantsApi, type TenantListItem } from '@/lib/admin-tenants';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { tenantSettingsApi, type TenantSettingMetadata } from '@/lib/tenant-settings';
import { zoomLiveApi } from '@/lib/zoom-live';

type SmtpProvider = 'custom' | 'brevo' | 'ses' | 'gmail' | 'mailgun' | 'sendgrid' | 'postmark';

interface SmtpDraft {
  provider: SmtpProvider;
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
}

const EMPTY_SMTP: SmtpDraft = {
  provider: 'custom',
  host: '',
  port: '587',
  user: '',
  password: '',
  from: '',
};

/**
 * Presets de hosts/puertos por provider para que el admin no tenga que
 * memorizar. Al cambiar el selector, los campos host/port se autorrellenan
 * sólo si el admin no los había tocado todavía. Cada preset usa SMTP
 * estándar — todos los providers listados (Brevo, SES, Gmail, Mailgun,
 * Sendgrid, Postmark) tienen interfaz SMTP relay.
 */
const SMTP_PRESETS: Record<SmtpProvider, { host: string; port: string; hint: string }> = {
  custom: { host: '', port: '587', hint: 'SMTP genérico de tu hosting o servidor propio.' },
  brevo: {
    host: 'smtp-relay.brevo.com',
    port: '587',
    hint: 'Brevo (ex Sendinblue). Usuario = email; password = SMTP key (no la del login).',
  },
  ses: {
    host: 'email-smtp.eu-central-1.amazonaws.com',
    port: '587',
    hint: 'AWS SES via SMTP. Cambiá el host por la región (eu-west-1, us-east-1, etc.). Usuario y password se generan en IAM > SMTP credentials.',
  },
  gmail: {
    host: 'smtp.gmail.com',
    port: '587',
    hint: 'Gmail / Google Workspace. Usuario = email completo; password = App Password (requiere 2FA habilitado).',
  },
  mailgun: {
    host: 'smtp.mailgun.org',
    port: '587',
    hint: 'Mailgun. Usuario = postmaster@dominio; password = SMTP password del dominio.',
  },
  sendgrid: {
    host: 'smtp.sendgrid.net',
    port: '587',
    hint: 'Sendgrid. Usuario fijo = "apikey"; password = la API key con permiso Mail Send.',
  },
  postmark: {
    host: 'smtp.postmarkapp.com',
    port: '587',
    hint: 'Postmark. Usuario y password = el Server API token.',
  },
};

// Branding tiene su propia pantalla en /admin/branding con preview live.
// Se removió la tab acá para no duplicar entry-point y confundir al admin.
type TabKey = 'notifications' | 'modules' | 'aula-virtual' | 'storage' | 'plantillas' | 'raw';

/// Cada tab declara opcionalmente `requiresModule`. Si el módulo está
/// desactivado en este tenant, el tab desaparece. Misma política que
/// el sidebar (`filterByActiveModules`).
///
/// IMPORTANTE: este filtro es UX. La defensa real está en el backend —
/// cualquier endpoint del módulo desactivado responde 403 vía
/// `ModuleAccessInterceptor`. El tab oculto solo evita confusión visual
/// del operador (PR a futuro: mover esta UI dentro del propio módulo
/// en lugar de tenerla en el core, ver ADR-008).
const TABS: Array<{
  key: TabKey;
  label: string;
  description: string;
  requiresModule?: string;
}> = [
  {
    key: 'notifications',
    label: 'Notificaciones',
    description: 'Servidor SMTP saliente para emails transaccionales.',
  },
  {
    key: 'modules',
    label: 'Módulos',
    description: 'Activa o desactiva módulos del producto para tu organización.',
  },
  {
    key: 'aula-virtual',
    label: 'Aula virtual',
    description: 'Credenciales Zoom para sesiones síncronas (mod.zoom-live).',
    requiresModule: 'mod.zoom-live',
  },
  {
    key: 'storage',
    label: 'Storage',
    description: 'Backend de archivos (S3 o disco local) configurado vía variables de entorno.',
  },
  {
    key: 'plantillas',
    label: 'Plantillas',
    description: 'Override del copy de las notificaciones (próximamente).',
    requiresModule: 'mod.notifications',
  },
  {
    key: 'raw',
    label: 'Avanzado',
    description:
      'Vista cruda (debug) de todos los valores guardados en este tenant, agrupados por módulo. Útil para troubleshooting; lo normal es usar las tabs específicas.',
  },
];

export default function ConfiguracionPage() {
  const [items, setItems] = useState<TenantSettingMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('notifications');
  const [activeModules, setActiveModules] = useState<Set<string> | null>(null);

  // Carga la lista de módulos activos del tenant para filtrar tabs cuyo
  // módulo está desactivado (ej. mod.zoom-live → oculta "Aula virtual").
  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    let cancelled = false;
    meApi
      .getMyModules(token)
      .then((res) => {
        if (!cancelled) setActiveModules(new Set(res.activeModules));
      })
      .catch(() => {
        // Si falla (red, módulo registry indisponible), dejamos null —
        // mostramos todas las tabs para no bloquear al admin.
        if (!cancelled) setActiveModules(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /// Filtra tabs cuyo `requiresModule` no está activo. Mientras
  /// `activeModules` es null (loading o error) mostramos todas — fallback
  /// permisivo para no esconder accidentalmente acciones legítimas. El
  /// backend sigue devolviendo 403 si se intenta acceder a un endpoint
  /// del módulo desactivado.
  const visibleTabs = TABS.filter((t) => {
    if (!t.requiresModule) return true;
    if (!activeModules) return true;
    return activeModules.has(t.requiresModule);
  });

  // Si la tab seleccionada queda oculta tras el filtro (ej. el admin
  // desactivó mod.zoom-live mientras estaba en el tab "Aula virtual"),
  // saltamos a la primera visible.
  useEffect(() => {
    if (!visibleTabs.find((t) => t.key === tab) && visibleTabs[0]) {
      setTab(visibleTabs[0].key);
    }
  }, [activeModules, tab, visibleTabs]);
  const [smtp, setSmtp] = useState<SmtpDraft>(EMPTY_SMTP);
  const [smtpStatus, setSmtpStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [smtpError, setSmtpError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);

  async function reload() {
    try {
      setItems(await tenantSettingsApi.listAll());
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar la configuración. Prueba a refrescar la página.',
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleSaveSmtp(e: FormEvent) {
    e.preventDefault();
    setSmtpStatus('saving');
    setSmtpError(null);
    try {
      const port = Number(smtp.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('El puerto debe ser un número entre 1 y 65535.');
      }
      if (!smtp.password) {
        throw new Error(
          'Contraseña requerida. Si ya hay una guardada, re-tipeala para confirmar el cambio.',
        );
      }
      await tenantSettingsApi.upsert('notifications', 'smtp', {
        isSecret: true,
        value: {
          host: smtp.host.trim(),
          port,
          user: smtp.user.trim(),
          password: smtp.password,
          from: smtp.from.trim(),
        },
      });
      setSmtpStatus('saved');
      setSmtp((s) => ({ ...s, password: '' }));
      await reload();
    } catch (e) {
      setSmtpStatus('error');
      setSmtpError(e instanceof Error ? e.message : 'No pudimos guardar la configuración SMTP.');
    }
  }

  function handleProviderChange(provider: SmtpProvider) {
    const preset = SMTP_PRESETS[provider];
    setSmtp((s) => ({
      ...s,
      provider,
      // Sólo sobrescribimos host/port si el admin no los había tocado o
      // si vienen de un preset previo. Heurística simple: si el host
      // actual coincide con algún preset (incluido el vacío), lo
      // reemplazamos.
      host: Object.values(SMTP_PRESETS).some((p) => p.host === s.host) ? preset.host : s.host,
      port: Object.values(SMTP_PRESETS).some((p) => p.port === s.port) ? preset.port : s.port,
    }));
  }

  async function handleDelete(scope: string, key: string) {
    if (
      !confirm(
        `¿Eliminar ${scope}.${key}? Si era una credencial, la integración asociada va a dejar de funcionar.`,
      )
    )
      return;
    try {
      await tenantSettingsApi.remove(scope, key);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el setting.');
    }
  }

  async function handleTestSmtp() {
    setTestStatus('sending');
    setTestMessage(null);
    try {
      const result = await tenantSettingsApi.testSmtp();
      setTestStatus('sent');
      setTestMessage(`Email enviado a ${result.sentTo}. Revisá tu bandeja.`);
    } catch (e) {
      setTestStatus('error');
      setTestMessage(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos enviar el email de prueba. Verificá los datos.',
      );
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Configuración del tenant</h1>
        <p className="mt-1 max-w-3xl text-text-muted">
          Credenciales y preferencias de los módulos para tu organización. Los secretos se almacenan
          cifrados (AES-256-GCM) y nunca se devuelven en claro desde la API.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {visibleTabs.map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.key)}
              className={
                isActive
                  ? 'relative px-4 py-2.5 text-sm font-semibold text-brand-700 transition-colors'
                  : 'relative px-4 py-2.5 text-sm font-medium text-text-muted hover:text-text transition-colors'
              }
            >
              {t.label}
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-px left-3 right-3 h-0.5 rounded-full bg-brand-500"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {tab === 'notifications' ? (
        <Card>
          <CardHeader>
            <CardTitle>Notificaciones · SMTP</CardTitle>
            <CardDescription>
              Servidor saliente para enviar emails. Si no configuras esto, las notificaciones
              quedarán registradas pero no se enviarán. Soporta SMTP genérico, Brevo, AWS SES (via
              SMTP), Gmail, Mailgun, Sendgrid y Postmark.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveSmtp} className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="smtp-provider">Proveedor</Label>
                <Select
                  id="smtp-provider"
                  value={smtp.provider}
                  onChange={(e) => handleProviderChange(e.target.value as SmtpProvider)}
                >
                  <option value="custom">SMTP genérico (hosting / servidor propio)</option>
                  <option value="brevo">Brevo (ex Sendinblue)</option>
                  <option value="ses">AWS SES (vía SMTP)</option>
                  <option value="gmail">Gmail / Google Workspace</option>
                  <option value="mailgun">Mailgun</option>
                  <option value="sendgrid">Sendgrid</option>
                  <option value="postmark">Postmark</option>
                </Select>
                <p className="text-xs text-text-subtle">{SMTP_PRESETS[smtp.provider].hint}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-host">Host</Label>
                <Input
                  id="smtp-host"
                  required
                  value={smtp.host}
                  onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
                  placeholder="smtp-relay.brevo.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">Puerto</Label>
                <Input
                  id="smtp-port"
                  required
                  inputMode="numeric"
                  value={smtp.port}
                  onChange={(e) => setSmtp({ ...smtp, port: e.target.value })}
                  placeholder="587"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">Usuario</Label>
                <Input
                  id="smtp-user"
                  required
                  autoComplete="off"
                  value={smtp.user}
                  onChange={(e) => setSmtp({ ...smtp, user: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-pass">Contraseña</Label>
                <Input
                  id="smtp-pass"
                  required
                  type="password"
                  autoComplete="new-password"
                  value={smtp.password}
                  onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="smtp-from">Remitente (From)</Label>
                <Input
                  id="smtp-from"
                  required
                  type="email"
                  value={smtp.from}
                  onChange={(e) => setSmtp({ ...smtp, from: e.target.value })}
                  placeholder="noreply@tu-dominio.com"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={smtpStatus === 'saving'}>
                  {smtpStatus === 'saving' ? 'Guardando…' : 'Guardar SMTP'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleTestSmtp}
                  disabled={testStatus === 'sending'}
                >
                  {testStatus === 'sending' ? 'Enviando…' : 'Probar envío'}
                </Button>
                {smtpStatus === 'saved' ? (
                  <span className="text-sm text-success-700">
                    ✓ Guardado cifrado · El servidor enviará emails con esta config a partir de la
                    próxima notificación.
                  </span>
                ) : null}
                {smtpStatus === 'error' && smtpError ? (
                  <span className="text-sm text-danger-700">{smtpError}</span>
                ) : null}
                {testStatus === 'sent' && testMessage ? (
                  <span className="text-sm text-success-700">{testMessage}</span>
                ) : null}
                {testStatus === 'error' && testMessage ? (
                  <span className="text-sm text-danger-700">{testMessage}</span>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {tab === 'modules' ? <ModulesTab /> : null}

      {tab === 'aula-virtual' ? <ZoomCredentialsCard /> : null}

      {tab === 'storage' ? <StorageTab /> : null}

      {tab === 'plantillas' ? <NotificationTemplatesTab /> : null}

      {tab === 'raw' ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Avanzado · vista debug</CardTitle>
              <Badge variant="warning">Solo troubleshooting</Badge>
            </div>
            <CardDescription>
              Lista todos los valores guardados en <code>tenant_setting</code> agrupados por módulo.
              Lo normal es configurar cada cosa desde su tab específica (Notificaciones, Storage,
              etc.). Esta vista es útil cuando hay que revisar/limpiar settings huérfanos. Los
              valores marcados como <Badge variant="warning">secreto •••</Badge> están cifrados
              at-rest y no se pueden leer desde la UI por diseño; sólo el servidor los descifra al
              consumirlos. <strong>Eliminar</strong> remueve el setting completo y desactiva la
              integración asociada.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items === null ? (
              <div className="space-y-2">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 p-8 text-center text-sm text-text-muted">
                Aún no configuraste nada en este tenant.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left">
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                      <th className="py-2 pr-4 font-semibold">Módulo</th>
                      <th className="py-2 pr-4 font-semibold">Clave</th>
                      <th className="py-2 pr-4 font-semibold">Tipo</th>
                      <th className="py-2 pr-4 font-semibold">Actualizado</th>
                      <th className="py-2 text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr
                        key={`${it.moduleName}/${it.key}`}
                        className="border-b border-border last:border-0 hover:bg-surface-2"
                      >
                        <td className="py-2 pr-4 font-mono text-xs">{it.moduleName}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{it.key}</td>
                        <td className="py-2 pr-4">
                          {it.isSecret ? (
                            <Badge variant="warning">secreto •••</Badge>
                          ) : (
                            <Badge variant="muted">plano</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-xs text-text-subtle tabular-nums">
                          {new Date(it.updatedAt).toLocaleDateString('es-AR', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDelete(it.moduleName, it.key)}
                            className="text-xs font-semibold text-danger-700 hover:underline"
                          >
                            Eliminar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function ZoomCredentialsCard() {
  const [draft, setDraft] = useState({ accountId: '', clientId: '', clientSecret: '' });
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<
    'idle' | 'testing' | { kind: 'real' | 'stub'; accountId: string } | { error: string }
  >('idle');

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setErrMsg(null);
    try {
      await tenantSettingsApi.upsert('zoom-live', 'credentials', {
        isSecret: true,
        value: {
          accountId: draft.accountId.trim(),
          clientId: draft.clientId.trim(),
          clientSecret: draft.clientSecret,
        },
      });
      setStatus('saved');
      setDraft((s) => ({ ...s, clientSecret: '' }));
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof ApiHttpError ? e.message : 'No pudimos guardar las credenciales.');
    }
  }

  async function handleClear() {
    if (!confirm('¿Borrar las credenciales Zoom S2S? Las sesiones nuevas caerán al stub.')) return;
    setStatus('saving');
    setErrMsg(null);
    try {
      await tenantSettingsApi.remove('zoom-live', 'credentials');
      setStatus('saved');
      setDraft({ accountId: '', clientId: '', clientSecret: '' });
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof ApiHttpError ? e.message : 'No pudimos borrar las credenciales.');
    }
  }

  async function handleTest() {
    setTestStatus('testing');
    try {
      const res = await zoomLiveApi.testCredentials();
      setTestStatus(res);
    } catch (e) {
      setTestStatus({
        error: e instanceof ApiHttpError ? e.message : 'No pudimos validar las credenciales.',
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aula virtual · Zoom Server-to-Server</CardTitle>
        <CardDescription>
          Pegá las credenciales Server-to-Server OAuth de tu cuenta Zoom. Se guardan cifradas
          (AES-256-GCM) y nunca se devuelven en claro. Si las dejás vacías, el módulo cae al stub de
          desarrollo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="zoom-account">Account ID</Label>
            <Input
              id="zoom-account"
              required
              value={draft.accountId}
              onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zoom-client">Client ID</Label>
            <Input
              id="zoom-client"
              required
              value={draft.clientId}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zoom-secret">Client Secret</Label>
            <Input
              id="zoom-secret"
              required
              type="password"
              value={draft.clientSecret}
              onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? 'Guardando…' : 'Guardar credenciales'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleTest}
              disabled={testStatus === 'testing'}
            >
              {testStatus === 'testing' ? 'Probando…' : 'Probar credenciales'}
            </Button>
            <Button type="button" variant="ghost" onClick={handleClear}>
              Borrar credenciales
            </Button>
            {status === 'saved' ? (
              <span className="text-sm text-success-700">✓ Guardado cifrado.</span>
            ) : null}
            {status === 'error' && errMsg ? (
              <span className="text-sm text-danger-700">{errMsg}</span>
            ) : null}
          </div>
          {typeof testStatus === 'object' && 'kind' in testStatus ? (
            <div className="sm:col-span-2 rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
              {testStatus.kind === 'real'
                ? `✓ Credenciales válidas. Vinculado a la cuenta Zoom ${testStatus.accountId}.`
                : '⚠ El módulo está usando el stub local — no hay credenciales reales configuradas todavía.'}
            </div>
          ) : null}
          {typeof testStatus === 'object' && 'error' in testStatus ? (
            <div className="sm:col-span-2 rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700">
              ✗ {testStatus.error}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function ModulesTab() {
  const [items, setItems] = useState<TenantModuleListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCascade, setConfirmCascade] = useState<{
    name: string;
    dependents: string[];
  } | null>(null);
  const [tenants, setTenants] = useState<TenantListItem[] | null>(null);
  const [targetTenantId, setTargetTenantId] = useState<string | undefined>(undefined);

  const isSuperAdmin = (() => {
    const session = authStorage.getSession();
    return session?.user.roles.includes('super_admin') ?? false;
  })();

  async function reload(tenantId = targetTenantId) {
    try {
      setItems(await adminModulesApi.list(tenantId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los módulos.');
    }
  }

  useEffect(() => {
    void reload(targetTenantId);
  }, [targetTenantId]);

  // Carga lista de tenants para el selector de super_admin (lazy, solo si tiene rol).
  useEffect(() => {
    if (!isSuperAdmin || tenants !== null) return;
    const token = authStorage.getAccessToken();
    if (!token) {
      setTenants([]);
      return;
    }
    adminTenantsApi
      .list(token)
      .then(setTenants)
      .catch(() => setTenants([]));
  }, [isSuperAdmin, tenants]);

  async function toggle(item: TenantModuleListItem, force = false) {
    setBusy(item.name);
    setError(null);
    // Optimistic update: el switch refleja el estado destino al instante
    // y, si la API falla, revertimos. La cascade-confirmation también
    // revierte porque el módulo realmente no se desactivó hasta que el
    // user confirme en el alertdialog.
    const previous = items;
    if (previous) {
      setItems(previous.map((m) => (m.name === item.name ? { ...m, enabled: !m.enabled } : m)));
    }
    try {
      if (item.enabled) {
        await adminModulesApi.disable(item.name, { force, tenantId: targetTenantId });
      } else {
        await adminModulesApi.enable(item.name, targetTenantId);
      }
      setConfirmCascade(null);
      await reload(targetTenantId);
      // Notificar al layout para que el sidebar se refresque sin recargar
      // la página. Listener en apps/web/src/app/(app)/layout.tsx.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('didacta:modules-changed'));
      }
    } catch (e) {
      if (previous) setItems(previous);
      if (e instanceof ApiHttpError && e.status === 409) {
        const dependents = extractDependents(e);
        setConfirmCascade({ name: item.name, dependents });
      } else {
        setError(e instanceof ApiHttpError ? e.message : 'No pudimos actualizar el módulo.');
      }
    } finally {
      setBusy(null);
    }
  }

  if (items === null) {
    return (
      <div className="space-y-2">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isSuperAdmin && tenants && tenants.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-200 bg-warning-50/40 p-3 text-sm">
          <span className="font-semibold text-warning-900">Modo super_admin:</span>
          <label className="inline-flex items-center gap-2">
            <span className="text-text-muted">operar sobre tenant</span>
            <select
              className="rounded border border-border-strong bg-surface px-2 py-1 text-sm"
              value={targetTenantId ?? ''}
              onChange={(e) => setTargetTenantId(e.target.value || undefined)}
            >
              <option value="">(el mío)</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.slug}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {items
        .filter((item) => !item.isCore)
        .map((item) => (
        <Card key={item.name}>
          <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">{item.displayName}</h3>
                <Badge variant="muted" className="font-mono text-[11px]">
                  {item.name}@{item.version}
                </Badge>
                {item.enabled ? (
                  <Badge variant="success">Activo</Badge>
                ) : (
                  <Badge variant="muted">Desactivado</Badge>
                )}
              </div>
              {item.description ? (
                <p className="text-sm text-text-muted">{item.description}</p>
              ) : null}
              {item.dependencies.length > 0 ? (
                <p className="text-xs text-text-subtle">
                  Depende de: <span className="font-mono">{item.dependencies.join(', ')}</span>
                </p>
              ) : null}
              {item.dependents.length > 0 ? (
                <p className="text-xs text-text-subtle">
                  Usado por: <span className="font-mono">{item.dependents.join(', ')}</span>
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-subtle tabular-nums">
                {busy === item.name ? 'Guardando…' : item.enabled ? 'Activo' : 'Desactivado'}
              </span>
              <Switch
                checked={item.enabled}
                onCheckedChange={() => toggle(item)}
                disabled={busy !== null}
                label={`${item.enabled ? 'Desactivar' : 'Activar'} ${item.displayName}`}
              />
            </div>
          </CardContent>
        </Card>
      ))}

      {confirmCascade ? (
        <div
          role="alertdialog"
          className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-sm"
        >
          <p className="font-semibold text-warning-900">
            Hay módulos activos que dependen de{' '}
            <span className="font-mono">{confirmCascade.name}</span>:
          </p>
          <p className="mt-1 font-mono text-warning-800">{confirmCascade.dependents.join(', ')}</p>
          <p className="mt-2 text-warning-800">
            Si confirmás, se desactivarán también esos módulos en cascada.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const item = items.find((i) => i.name === confirmCascade.name);
                if (item) void toggle(item, true);
              }}
            >
              Desactivar en cascada
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmCascade(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function extractDependents(err: ApiHttpError): string[] {
  const anyErr = err as unknown as { details?: { dependents?: unknown } };
  const list = anyErr.details?.dependents;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

type StorageDriver = 'local' | 's3';

interface StorageDraft {
  driver: StorageDriver;
  localDir: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

const EMPTY_STORAGE: StorageDraft = {
  driver: 'local',
  localDir: '/data/storage',
  s3Bucket: '',
  s3Region: 'eu-central-1',
  s3Endpoint: '',
  s3AccessKeyId: '',
  s3SecretAccessKey: '',
};

function StorageTab() {
  const [draft, setDraft] = useState<StorageDraft>(EMPTY_STORAGE);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Persistimos en 2 keys: `storage.config` (no-secret, hidratable al
  // releer) con el driver y la metadata; `storage.secret` (cifrada) sólo
  // con la access secret. Así el admin ve los valores guardados al volver
  // a la tab y sólo re-tipea el secret si quiere rotarlo.
  useEffect(() => {
    let aborted = false;
    void (async () => {
      try {
        const detail = await tenantSettingsApi
          .get('storage', 'config')
          .catch(() => null as { value: unknown } | null);
        if (aborted || !detail || detail.value == null || typeof detail.value !== 'object') return;
        const value = detail.value as Record<string, unknown>;
        const driver = value['driver'] === 's3' ? 's3' : 'local';
        setDraft({
          driver,
          localDir: typeof value['localDir'] === 'string' ? value['localDir'] : '/data/storage',
          s3Bucket: typeof value['s3Bucket'] === 'string' ? value['s3Bucket'] : '',
          s3Region: typeof value['s3Region'] === 'string' ? value['s3Region'] : 'eu-central-1',
          s3Endpoint: typeof value['s3Endpoint'] === 'string' ? value['s3Endpoint'] : '',
          s3AccessKeyId: typeof value['s3AccessKeyId'] === 'string' ? value['s3AccessKeyId'] : '',
          s3SecretAccessKey: '',
        });
      } catch {
        // Si la lectura falla dejamos los defaults.
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setError(null);
    try {
      if (draft.driver === 's3' && (!draft.s3Bucket.trim() || !draft.s3AccessKeyId.trim())) {
        throw new Error('Bucket y Access Key ID son requeridos para S3.');
      }
      const config =
        draft.driver === 'local'
          ? { driver: 'local' as const, localDir: draft.localDir.trim() || '/data/storage' }
          : {
              driver: 's3' as const,
              s3Bucket: draft.s3Bucket.trim(),
              s3Region: draft.s3Region.trim(),
              s3Endpoint: draft.s3Endpoint.trim() || undefined,
              s3AccessKeyId: draft.s3AccessKeyId.trim(),
            };
      await tenantSettingsApi.upsert('storage', 'config', { isSecret: false, value: config });
      // Sólo escribimos el secret si el admin lo re-tipeó en este turno.
      // Vacío significa "conservar el actual" para no requerir conocerlo.
      if (draft.driver === 's3' && draft.s3SecretAccessKey) {
        await tenantSettingsApi.upsert('storage', 'secret', {
          isSecret: true,
          value: { s3SecretAccessKey: draft.s3SecretAccessKey },
        });
      }
      setStatus('saved');
      setDraft((d) => ({ ...d, s3SecretAccessKey: '' }));
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'No pudimos guardar la configuración de storage.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          Backend de archivos para uploads (avatares, certificados, lecciones, evidencias). Disco
          local del container o un bucket S3-compatible (AWS, Hetzner, MinIO, Backblaze).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="storage-driver">Provider</Label>
            <Select
              id="storage-driver"
              value={draft.driver}
              onChange={(e) => setDraft({ ...draft, driver: e.target.value as StorageDriver })}
            >
              <option value="local">Disco local del container (volumen Docker)</option>
              <option value="s3">S3-compatible (AWS, Hetzner, MinIO, Backblaze)</option>
            </Select>
          </div>

          {draft.driver === 'local' ? (
            <div className="space-y-1.5">
              <Label htmlFor="storage-localDir">Directorio del volumen</Label>
              <Input
                id="storage-localDir"
                value={draft.localDir}
                onChange={(e) => setDraft({ ...draft, localDir: e.target.value })}
                placeholder="/data/storage"
                className="font-mono"
              />
              <p className="text-xs text-text-subtle">
                Asegurate de montar un volumen Docker apuntando a esta ruta para que los archivos
                sobrevivan a redespliegues.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="s3-bucket">Bucket *</Label>
                <Input
                  id="s3-bucket"
                  value={draft.s3Bucket}
                  onChange={(e) => setDraft({ ...draft, s3Bucket: e.target.value })}
                  placeholder="mi-tenant-uploads"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-region">Region *</Label>
                <Input
                  id="s3-region"
                  value={draft.s3Region}
                  onChange={(e) => setDraft({ ...draft, s3Region: e.target.value })}
                  placeholder="eu-central-1"
                  required
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="s3-endpoint">Endpoint (opcional)</Label>
                <Input
                  id="s3-endpoint"
                  value={draft.s3Endpoint}
                  onChange={(e) => setDraft({ ...draft, s3Endpoint: e.target.value })}
                  placeholder="https://s3.eu-central-1.hetzner.com"
                />
                <p className="text-xs text-text-subtle">
                  Sólo necesario para S3-compatible no-AWS (Hetzner, MinIO, Backblaze).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-accessKey">Access Key ID *</Label>
                <Input
                  id="s3-accessKey"
                  value={draft.s3AccessKeyId}
                  onChange={(e) => setDraft({ ...draft, s3AccessKeyId: e.target.value })}
                  required
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-secret">Secret Access Key</Label>
                <Input
                  id="s3-secret"
                  type="password"
                  value={draft.s3SecretAccessKey}
                  onChange={(e) => setDraft({ ...draft, s3SecretAccessKey: e.target.value })}
                  placeholder="(dejar vacío para conservar el actual)"
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">
                  Se cifra con AES-256-GCM antes de persistir. La API nunca lo devuelve en claro.
                </p>
              </div>
            </div>
          )}

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}
          {status === 'saved' ? (
            <p className="text-sm text-success-700">Guardado correctamente.</p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? 'Guardando…' : 'Guardar configuración'}
            </Button>
          </div>
        </form>

        <div className="mt-6 rounded-lg border border-success-200 bg-success-50/50 p-3 text-xs text-success-800">
          <strong>Activo:</strong> los uploads de imágenes y los archivos del tenant ya usan esta
          configuración cuando el driver es <code>s3</code>. Si eliges disco local o no completás el
          bucket, el server cae al adapter global del env.
        </div>
      </CardContent>
    </Card>
  );
}

const SUPPORTED_LOCALES = [
  { code: 'es-ES', label: 'Español' },
  { code: 'en-US', label: 'English' },
] as const;

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  EMAIL: 'Email',
  IN_APP: 'In-app',
  WEBHOOK: 'Webhook',
};

interface TemplateDraft {
  channel: NotificationChannel;
  locale: string;
  subject: string;
  body: string;
}

function NotificationTemplatesTab() {
  const [keys, setKeys] = useState<string[] | null>(null);
  const [overrides, setOverrides] = useState<NotificationTemplateOverride[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; draft: TemplateDraft } | null>(null);
  const [pending, setPending] = useState(false);

  async function reload() {
    try {
      const [k, list] = await Promise.all([
        adminNotificationsApi.listKnownKeys(),
        adminNotificationsApi.listOverrides(),
      ]);
      setKeys(k);
      setOverrides(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las plantillas.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startNew(key: string) {
    setEditing({
      key,
      draft: { channel: 'EMAIL', locale: 'es-ES', subject: '', body: '' },
    });
  }

  function startEdit(o: NotificationTemplateOverride) {
    setEditing({
      key: o.key,
      draft: {
        channel: o.channel,
        locale: o.locale,
        subject: o.subject ?? '',
        body: o.body,
      },
    });
  }

  function cancelEdit() {
    setEditing(null);
  }

  async function handleSave() {
    if (!editing) return;
    setPending(true);
    setError(null);
    try {
      await adminNotificationsApi.upsertOverride(editing.key, {
        channel: editing.draft.channel,
        locale: editing.draft.locale,
        subject: editing.draft.subject || null,
        body: editing.draft.body,
      });
      setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la plantilla.');
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(o: NotificationTemplateOverride) {
    if (
      !window.confirm(
        `¿Quitar el override de "${o.key}" (${o.channel} · ${o.locale})? Volverá al texto por defecto del producto.`,
      )
    )
      return;
    setPending(true);
    try {
      await adminNotificationsApi.deleteOverride(o.key, { channel: o.channel, locale: o.locale });
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar la plantilla.');
    } finally {
      setPending(false);
    }
  }

  if (keys === null) {
    return (
      <div className="space-y-2">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Editar plantilla <span className="font-mono text-base">{editing.key}</span>
            </CardTitle>
            <CardDescription>
              Variables disponibles: <code>{'{{course}}'}</code>, <code>{'{{quiz}}'}</code>,{' '}
              <code>{'{{number}}'}</code>, <code>{'{{scorePercent}}'}</code>,{' '}
              <code>{'{{handle}}'}</code> y otras según el evento. Las variables no resueltas se
              dejan vacías.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-channel">Canal</Label>
                <Select
                  id="tpl-channel"
                  value={editing.draft.channel}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, channel: e.target.value as NotificationChannel },
                    })
                  }
                >
                  <option value="EMAIL">Email</option>
                  <option value="IN_APP">In-app</option>
                  <option value="WEBHOOK">Webhook</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-locale">Idioma</Label>
                <Select
                  id="tpl-locale"
                  value={editing.draft.locale}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, locale: e.target.value } })
                  }
                >
                  {SUPPORTED_LOCALES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label} ({l.code})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-subject">Asunto (opcional)</Label>
                <Input
                  id="tpl-subject"
                  value={editing.draft.subject}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, subject: e.target.value },
                    })
                  }
                  placeholder="Ej: Te matriculaste en {{course}}"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-body">Cuerpo</Label>
                <textarea
                  id="tpl-body"
                  rows={6}
                  value={editing.draft.body}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, body: e.target.value } })
                  }
                  required
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Acabas de matricularte en el curso {{course}}…"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2 border-t border-border-soft pt-3">
              <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={pending || !editing.draft.body.trim()}
              >
                {pending ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Plantillas de notificación</CardTitle>
          <CardDescription>
            Personalizá el copy de cada notificación enviada por la plataforma. Si no creas un
            override, se usa el texto por defecto del producto. Soportado por canal (Email, In-app,
            Webhook) y por idioma. El fallback de idioma es <code>es-ES</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border-soft">
            {keys.map((key) => {
              const overridesForKey = overrides.filter((o) => o.key === key);
              return (
                <li key={key} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm font-semibold text-text">{key}</p>
                    {overridesForKey.length === 0 ? (
                      <p className="mt-1 text-xs text-text-subtle">
                        Usando el texto por defecto del producto.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {overridesForKey.map((o) => (
                          <li key={o.id} className="flex items-center gap-2 text-xs">
                            <Badge variant="info">
                              {CHANNEL_LABEL[o.channel]} · {o.locale}
                            </Badge>
                            <button
                              type="button"
                              onClick={() => startEdit(o)}
                              className="text-text-muted hover:text-brand-700 hover:underline"
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDelete(o)}
                              className="text-danger-700 hover:underline"
                              disabled={pending}
                            >
                              Quitar
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => startNew(key)}
                    disabled={pending}
                  >
                    + Override
                  </Button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
