'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
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

export default function ConfiguracionPage() {
  const [items, setItems] = useState<TenantSettingMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo cargar la configuración');
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
        throw new Error('Puerto inválido (1–65535)');
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
      setSmtpError(e instanceof Error ? e.message : 'Error desconocido');
    }
  }

  async function handleDelete(scope: string, key: string) {
    if (!confirm(`¿Eliminar ${scope}.${key}? Si era una credencial, dejará de funcionar.`)) return;
    try {
      await tenantSettingsApi.remove(scope, key);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo eliminar');
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
        e instanceof ApiHttpError ? e.message : 'No se pudo enviar el email de prueba',
      );
    }
  }

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!items) return <p className="text-sm text-neutral-500">Cargando…</p>;

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Configuración del tenant</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Credenciales y preferencias de los módulos para tu organización. Los secretos se almacenan
          cifrados (AES-256-GCM) y nunca se devuelven en claro desde la API.
        </p>
      </header>

      <article className="rounded-md border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-lg font-semibold">Notificaciones · SMTP</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Servidor saliente para enviar correos. Si no configurás esto, las notificaciones por email
          se loguean pero no se envían.
        </p>

        <form onSubmit={handleSaveSmtp} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Host">
            <input
              required
              value={smtp.host}
              onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
              placeholder="smtp-relay.brevo.com"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </Field>
          <Field label="Puerto">
            <input
              required
              value={smtp.port}
              onChange={(e) => setSmtp({ ...smtp, port: e.target.value })}
              placeholder="587"
              inputMode="numeric"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </Field>
          <Field label="Usuario">
            <input
              required
              value={smtp.user}
              onChange={(e) => setSmtp({ ...smtp, user: e.target.value })}
              autoComplete="off"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </Field>
          <Field label="Contraseña">
            <input
              required
              type="password"
              value={smtp.password}
              onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
              autoComplete="new-password"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </Field>
          <Field label="Remitente (From)">
            <input
              required
              type="email"
              value={smtp.from}
              onChange={(e) => setSmtp({ ...smtp, from: e.target.value })}
              placeholder="noreply@tu-dominio.com"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </Field>

          <div className="sm:col-span-2 flex items-center gap-3">
            <Button type="submit" disabled={smtpStatus === 'saving'}>
              {smtpStatus === 'saving' ? 'Guardando…' : 'Guardar SMTP'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleTestSmtp}
              disabled={testStatus === 'sending'}
            >
              {testStatus === 'sending' ? 'Enviando…' : 'Probar envío'}
            </Button>
            {smtpStatus === 'saved' && (
              <span className="text-sm text-emerald-600 dark:text-emerald-400">
                ✓ Guardado cifrado.
              </span>
            )}
            {smtpStatus === 'error' && smtpError && (
              <span className="text-sm text-red-600 dark:text-red-400">{smtpError}</span>
            )}
            {testStatus === 'sent' && testMessage && (
              <span className="text-sm text-emerald-600 dark:text-emerald-400">{testMessage}</span>
            )}
            {testStatus === 'error' && testMessage && (
              <span className="text-sm text-red-600 dark:text-red-400">{testMessage}</span>
            )}
          </div>
        </form>
      </article>

      <article className="rounded-md border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-lg font-semibold">Todos los settings</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Vista cruda de los valores guardados. Los secretos muestran <code>•••</code> sin
          posibilidad de leerlos.
        </p>

        {items.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            Aún no configuraste nada.
          </p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="py-2">Módulo</th>
                <th className="py-2">Clave</th>
                <th className="py-2">Tipo</th>
                <th className="py-2">Actualizado</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={`${it.moduleName}/${it.key}`}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                >
                  <td className="py-2 font-mono text-xs">{it.moduleName}</td>
                  <td className="py-2 font-mono text-xs">{it.key}</td>
                  <td className="py-2 text-xs">
                    {it.isSecret ? (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        secreto •••
                      </span>
                    ) : (
                      <span className="rounded bg-neutral-100 px-2 py-0.5 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        plano
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-neutral-500">
                    {new Date(it.updatedAt).toLocaleString()}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(it.moduleName, it.key)}
                      className="text-xs text-red-600 underline decoration-dotted hover:decoration-solid dark:text-red-400"
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
      {children}
    </label>
  );
}
