'use client';

/// Tab "Plantillas" del módulo `mod.notifications` para `/admin/configuracion`.
///
/// Permite al tenant_admin sobrescribir el copy por defecto de cada
/// notificación de la plataforma (cuando un alumno se matricula, cuando
/// supera un quiz, etc.) por canal (Email/In-app/Webhook) y por idioma.
/// Si no hay override, se usa el texto por defecto del producto.
///
/// Extraído del core en el refactor ADR-011: el componente vivía dentro
/// de `apps/web/src/app/(app)/admin/configuracion/page.tsx` y ahora
/// pertenece al módulo (que lo declara en su `index.ts`).

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminNotificationsApi,
  type NotificationChannel,
  type NotificationTemplateOverride,
} from './admin-client';

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

export function NotificationTemplatesTab() {
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
            Personaliza el copy de cada notificación enviada por la plataforma. Si no creas un
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
