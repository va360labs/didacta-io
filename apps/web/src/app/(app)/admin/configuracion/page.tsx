'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { adminModulesApi, type TenantModuleListItem } from '@/lib/admin-modules';
import { meApi } from '@/lib/me';
import { adminTenantsApi, type TenantListItem } from '@/lib/admin-tenants';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { tenantSettingsApi, type TenantSettingMetadata } from '@/lib/tenant-settings';
import { flatAdminConfigTabs } from '@/modules';

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
//
// Tabs DEL CORE: notifications, modules, storage, plantillas, raw. Otros
// tabs los aportan los módulos vía `moduleExtensions` (ver
// `apps/web/src/modules/`). El extension point convierte tabs como
// "Aula virtual" del módulo `mod.zoom-live` en una declaración del
// propio módulo en lugar de un hard-code en el core.

interface ConfigTabSpec {
  key: string;
  label: string;
  description: string;
  /// Solo set para tabs aportados por un módulo. Si el módulo NO está
  /// activo para el tenant, el tab desaparece. Tabs del core NO declaran
  /// `requiresModule`.
  requiresModule?: string;
  /// Componente que renderiza el contenido del tab. Para tabs del core
  /// es null y el switch `renderTabContent` selecciona; para tabs de
  /// extensión es el `Component` declarado por el módulo.
  Component?: React.ComponentType;
}

const CORE_TABS: ConfigTabSpec[] = [
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
    key: 'storage',
    label: 'Storage',
    description: 'Backend de archivos (S3 o disco local) configurado vía variables de entorno.',
  },
  {
    key: 'raw',
    label: 'Avanzado',
    description:
      'Vista cruda (debug) de todos los valores guardados en este tenant, agrupados por módulo. Útil para troubleshooting; lo normal es usar las tabs específicas.',
  },
];

/// Lista combinada CORE + EXTENSIONS, calculada una vez por mount. El
/// orden es: tabs del core en su orden declarado, seguido de los tabs
/// de extensión en el orden del catálogo. Ningún módulo puede pisar el
/// `key` de un tab del core (validado en runtime).
const ALL_TABS: ConfigTabSpec[] = [
  ...CORE_TABS,
  ...flatAdminConfigTabs().map(({ moduleName, tab }) => ({
    key: tab.key,
    label: tab.label,
    description: tab.description,
    requiresModule: moduleName,
    Component: tab.Component,
  })),
];

type TabKey = string;

export default function ConfiguracionPage() {
  const [items, setItems] = useState<TenantSettingMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('notifications');
  const [activeModules, setActiveModules] = useState<Set<string> | null>(null);

  // Carga la lista de módulos activos del tenant para filtrar tabs cuyo
  // módulo está desactivado (ej. mod.zoom-live → oculta "Aula virtual").
  // Re-ejecuta también cuando otro componente dispara el evento
  // `didacta:modules-changed` (típicamente el ModulesTab de esta misma
  // página tras un toggle), así el filtro se actualiza sin recargar.
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      const token = authStorage.getAccessToken();
      if (!token) return;
      meApi
        .getMyModules(token)
        .then((res) => {
          if (!cancelled) setActiveModules(new Set(res.activeModules));
        })
        .catch(() => {
          // Si falla (red, módulo registry indisponible), pasamos a un
          // set VACÍO en lugar de null para ser ESTRICTOS: ocultamos
          // tabs de módulos hasta que la lista llegue. Antes era
          // permisivo y dejaba el tab visible aunque el módulo
          // estuviera desactivado — ese era el síntoma reportado
          // en alpha.17.
          if (!cancelled) setActiveModules(new Set<string>());
        });
    }
    refresh();
    window.addEventListener('didacta:modules-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('didacta:modules-changed', refresh);
    };
  }, []);

  /// Filtra tabs cuyo `requiresModule` no está activo. Si `activeModules`
  /// aún no llegó del API (estado inicial pre-fetch), ocultamos los tabs
  /// de extensión por seguridad — la versión anterior era permisiva (los
  /// mostraba durante el flash) y el operador veía el tab incluso con el
  /// módulo desactivado. Tabs del core (sin `requiresModule`) siempre
  /// visibles.
  const visibleTabs = ALL_TABS.filter((t) => {
    if (!t.requiresModule) return true;
    if (!activeModules) return false;
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
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [smtpHydrating, setSmtpHydrating] = useState(true);
  const [smtpDecryptFailed, setSmtpDecryptFailed] = useState(false);
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

  // Hidratar el form de SMTP con los campos no-secretos guardados (UI-FIX-02).
  // El backend devuelve host/port/user/from descifrados y el password como null
  // (redactado). Detectamos `hasStoredPassword` para mostrar placeholder claro.
  useEffect(() => {
    if (!items) return;
    const smtpMeta = items.find((i) => i.moduleName === 'notifications' && i.key === 'smtp');
    if (!smtpMeta?.hasValue) {
      setHasStoredPassword(false);
      setSmtpHydrating(false);
      return;
    }
    let cancelled = false;
    void tenantSettingsApi
      .get('notifications', 'smtp')
      .then((detail) => {
        if (cancelled) return;
        setSmtpDecryptFailed(detail.decryptFailed === true);
        const v = detail.value;
        if (!v || typeof v !== 'object') {
          setSmtpHydrating(false);
          return;
        }
        const obj = v as Record<string, unknown>;
        setSmtp((s) => ({
          ...s,
          host: typeof obj['host'] === 'string' ? (obj['host'] as string) : s.host,
          port:
            typeof obj['port'] === 'number'
              ? String(obj['port'])
              : typeof obj['port'] === 'string'
                ? (obj['port'] as string)
                : s.port,
          user: typeof obj['user'] === 'string' ? (obj['user'] as string) : s.user,
          from: typeof obj['from'] === 'string' ? (obj['from'] as string) : s.from,
          // password queda vacío — el backend hace merge y conserva el guardado
          // si no tipeás uno nuevo (alpha.69).
        }));
        setHasStoredPassword(true);
        setSmtpHydrating(false);
      })
      .catch(() => {
        // Si falla la hidratación, el form queda con defaults.
        setSmtpHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [items]);

  async function handleSaveSmtp(e: FormEvent) {
    e.preventDefault();
    setSmtpStatus('saving');
    setSmtpError(null);
    try {
      const port = Number(smtp.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('El puerto debe ser un número entre 1 y 65535.');
      }
      // Contraseña: solo es required si NO hay una guardada todavía. Si ya
      // hay password guardada y el campo está vacío, el backend hace merge
      // y conserva la guardada. Ver alpha.69.
      if (!smtp.password && !hasStoredPassword) {
        throw new Error('Contraseña requerida.');
      }
      await tenantSettingsApi.upsert('notifications', 'smtp', {
        isSecret: true,
        value: {
          host: smtp.host.trim(),
          port,
          user: smtp.user.trim(),
          // Mandamos el password siempre. Si está vacío, el backend lo
          // interpreta como "no cambiar" y mantiene el guardado.
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
            {smtpHydrating ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="skeleton h-10 sm:col-span-2" />
                <div className="skeleton h-10" />
                <div className="skeleton h-10" />
                <div className="skeleton h-10" />
                <div className="skeleton h-10" />
                <div className="skeleton h-10 sm:col-span-2" />
              </div>
            ) : null}
            {!smtpHydrating && smtpDecryptFailed ? (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700"
              >
                <p className="font-semibold">La configuración guardada no se puede leer</p>
                <p className="mt-0.5">
                  La clave de cifrado del cluster cambió desde que se guardó esta configuración.
                  Re-tipeá todos los campos y apretá &quot;Guardar SMTP&quot; para reciclarla con la
                  clave actual. Esto suele pasar después de un redeploy que regeneró la clave.
                </p>
              </div>
            ) : null}
            <form
              onSubmit={handleSaveSmtp}
              className={`grid gap-4 sm:grid-cols-2 ${smtpHydrating ? 'hidden' : ''}`}
            >
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
                  required={!hasStoredPassword}
                  type="password"
                  autoComplete="new-password"
                  value={smtp.password}
                  onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
                  placeholder={hasStoredPassword ? '••••••• (guardada — dejá vacío para no cambiarla)' : ''}
                />
                {hasStoredPassword ? (
                  <p className="text-xs text-text-subtle">
                    Hay una contraseña guardada. Dejala vacía para mantenerla, o tipeá una nueva
                    para reemplazarla.
                  </p>
                ) : null}
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

      {/* Tabs aportados por módulos vía extension point. Se renderiza el
          Component declarado en `moduleExtensions` cuando el tab activo
          coincide con su `key`. Filtrado por activeModules ya aplicado
          en `visibleTabs`. */}
      {(() => {
        const ext = ALL_TABS.find((t) => t.key === tab && t.Component);
        if (!ext || !ext.Component) return null;
        const Component = ext.Component;
        return <Component />;
      })()}

      {tab === 'storage' ? <StorageTab /> : null}

      {/* tab "plantillas" lo aporta `mod.notifications` vía extension —
          render genérico unos bloques arriba se encarga. */}

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
                          {new Date(it.updatedAt).toLocaleDateString('es-ES', {
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
            Si confirmas, se desactivarán también esos módulos en cascada.
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
          configuración cuando el driver es <code>s3</code>. Si eliges disco local o no completas el
          bucket, el server cae al adapter global del env.
        </div>
      </CardContent>
    </Card>
  );
}
