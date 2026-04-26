'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { tenantSettingsApi, type TenantSettingMetadata } from '@/lib/tenant-settings';

interface SmtpDraft {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
}

const EMPTY_SMTP: SmtpDraft = { host: '', port: '587', user: '', password: '', from: '' };

type TabKey = 'notifications' | 'aula-virtual' | 'storage' | 'branding' | 'plantillas' | 'raw';

const TABS: Array<{ key: TabKey; label: string; description: string }> = [
  {
    key: 'notifications',
    label: 'Notificaciones',
    description: 'Servidor SMTP saliente para emails transaccionales.',
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
    key: 'branding',
    label: 'Branding',
    description: 'Personalización visual de tu organización.',
  },
  {
    key: 'plantillas',
    label: 'Plantillas',
    description: 'Override del copy de las notificaciones (próximamente).',
  },
  {
    key: 'raw',
    label: 'Todos los settings',
    description: 'Vista cruda de los valores guardados con flag de cifrado.',
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

      {tab === 'aula-virtual' ? (
        <Card>
          <CardHeader>
            <CardTitle>Aula virtual · Zoom</CardTitle>
            <CardDescription>
              Configurá las credenciales Server-to-Server de Zoom para crear sesiones síncronas
              vinculadas a tus cursos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 p-8 text-center">
              <Badge variant="warning" className="mb-3">
                Próximamente
              </Badge>
              <p className="text-sm text-text-muted">
                La integración con Zoom llega con el módulo <code>mod.zoom-live</code> en la próxima
                fase. Mientras tanto, configurá las sesiones manualmente.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

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

      {tab === 'branding' ? (
        <Card>
          <CardHeader>
            <CardTitle>Branding</CardTitle>
            <CardDescription>
              La personalización visual (logo, color, fuentes, custom CSS) se gestiona en una
              pantalla dedicada con preview live.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/admin/branding">Ir a Branding →</Link>
            </Button>
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
            <CardTitle>Todos los settings</CardTitle>
            <CardDescription>
              Vista cruda de los valores guardados. Los secretos muestran <code>•••</code> sin
              posibilidad de leerlos.
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
