'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminModulesApi, type TenantModuleListItem } from '@/lib/admin-modules';
import { adminTenantsApi, type TenantListItem } from '@/lib/admin-tenants';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { tenantSettingsApi, type TenantSettingMetadata } from '@/lib/tenant-settings';
import { zoomLiveApi } from '@/lib/zoom-live';

interface SmtpDraft {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
}

const EMPTY_SMTP: SmtpDraft = { host: '', port: '587', user: '', password: '', from: '' };

// Branding tiene su propia pantalla en /admin/branding con preview live.
// Se removió la tab acá para no duplicar entry-point y confundir al admin.
type TabKey = 'notifications' | 'modules' | 'aula-virtual' | 'storage' | 'plantillas' | 'raw';

const TABS: Array<{ key: TabKey; label: string; description: string }> = [
  {
    key: 'notifications',
    label: 'Notificaciones',
    description: 'Servidor SMTP saliente para emails transaccionales.',
  },
  {
    key: 'modules',
    label: 'Módulos',
    description: 'Activá o desactivá módulos del producto para tu organización.',
  },
  {
    key: 'aula-virtual',
    label: 'Aula virtual',
    description: 'Credenciales Zoom para sesiones síncronas (próximamente con mod.zoom-live).',
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
          : 'No pudimos cargar la configuración. Probá refrescar la página.',
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
        {TABS.map((t) => {
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
              Servidor saliente para enviar emails. Si no configurás esto, las notificaciones
              quedarán registradas pero no se enviarán.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveSmtp} className="grid gap-4 sm:grid-cols-2">
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
                  <span className="text-sm text-success-700">✓ Guardado cifrado.</span>
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

      {tab === 'storage' ? (
        <Card>
          <CardHeader>
            <CardTitle>Storage</CardTitle>
            <CardDescription>
              El backend de archivos se selecciona vía variables de entorno del servidor (no es
              configurable per-tenant todavía).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-text-muted">
              Estado actual: <strong className="text-text">controlado por env</strong> (
              <code>STORAGE_DRIVER</code>). Si tu organización necesita un bucket S3 propio, hablá
              con el equipo de plataforma.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {tab === 'plantillas' ? (
        <Card>
          <CardHeader>
            <CardTitle>Plantillas de notificación</CardTitle>
            <CardDescription>
              Override del copy de cada notificación enviada por la plataforma.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 p-8 text-center">
              <Badge variant="warning" className="mb-3">
                Próximamente
              </Badge>
              <p className="text-sm text-text-muted">
                Por ahora se usan las plantillas default de Didacta. Vas a poder customizarlas
                pronto.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
    try {
      if (item.enabled) {
        await adminModulesApi.disable(item.name, { force, tenantId: targetTenantId });
      } else {
        await adminModulesApi.enable(item.name, targetTenantId);
      }
      setConfirmCascade(null);
      await reload(targetTenantId);
    } catch (e) {
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

      {items.map((item) => (
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
            <Button
              type="button"
              variant={item.enabled ? 'secondary' : 'primary'}
              onClick={() => toggle(item)}
              disabled={busy !== null}
            >
              {busy === item.name ? '…' : item.enabled ? 'Desactivar' : 'Activar'}
            </Button>
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
