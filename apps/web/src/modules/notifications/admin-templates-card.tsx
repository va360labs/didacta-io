'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Gestor de emails de la plataforma — sección `/admin/emails`.
///
/// Lista TODOS los emails/notificaciones que envía el producto (catálogo del
/// backend: transaccionales + NotificationHub) agrupados por área, con su
/// texto por defecto, y permite al tenant_admin personalizar asunto y cuerpo
/// por canal e idioma. Si no hay override, se usa el default del producto.
/// Las partes estructurales (botón CTA, código OTP, botones de decisión) no
/// son editables: un override nunca puede romper un email.
///
/// Historia: nació como tab "Plantillas" de /admin/configuracion (solo keys
/// del hub); en alpha.83 se consolidó aquí con el catálogo completo (regla #5:
/// un solo camino).

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { adminSmtpApi } from '@/lib/admin-smtp';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminNotificationsApi,
  type EmailTemplateCatalogEntry,
  type EmailTemplateCategory,
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

/** Orden y nombre de las secciones del catálogo. */
const CATEGORY_ORDER: Array<{ key: EmailTemplateCategory; label: string }> = [
  { key: 'account', label: 'Cuenta y acceso' },
  { key: 'members', label: 'Inscripción de miembros' },
  { key: 'billing', label: 'Membresía y pagos' },
  { key: 'learning', label: 'Aprendizaje' },
  { key: 'community', label: 'Comunidad' },
  { key: 'system', label: 'Sistema' },
];

interface EditorState {
  entry: EmailTemplateCatalogEntry;
  channel: NotificationChannel;
  locale: string;
  subject: string;
  body: string;
  /** Override existente para (channel, locale), si lo hay. */
  existing: NotificationTemplateOverride | null;
}

function findOverride(
  overrides: NotificationTemplateOverride[],
  key: string,
  channel: NotificationChannel,
  locale: string,
): NotificationTemplateOverride | null {
  return (
    overrides.find((o) => o.key === key && o.channel === channel && o.locale === locale) ?? null
  );
}

export function EmailTemplatesManager() {
  const [catalog, setCatalog] = useState<EmailTemplateCatalogEntry[] | null>(null);
  const [overrides, setOverrides] = useState<NotificationTemplateOverride[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState(false);
  /** Se recuerda entre envíos para no reescribir el correo cada vez. */
  const [lastTestEmail, setLastTestEmail] = useState('');

  async function reload() {
    try {
      const [cat, list] = await Promise.all([
        adminNotificationsApi.getCatalog(),
        adminNotificationsApi.listOverrides(),
      ]);
      setCatalog(cat);
      setOverrides(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los emails.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const grouped = useMemo(() => {
    if (!catalog) return [];
    return CATEGORY_ORDER.map((cat) => ({
      ...cat,
      entries: catalog.filter((e) => e.category === cat.key),
    })).filter((g) => g.entries.length > 0);
  }, [catalog]);

  /** Abre el editor prefilleado con el valor EFECTIVO (override o default). */
  function openEditor(
    entry: EmailTemplateCatalogEntry,
    channel: NotificationChannel = 'EMAIL',
    locale = 'es-ES',
  ) {
    const existing = findOverride(overrides, entry.key, channel, locale);
    setNotice(null);
    setEditor({
      entry,
      channel,
      locale,
      subject: existing ? (existing.subject ?? '') : (entry.defaultSubject ?? ''),
      body: existing ? existing.body : entry.defaultBody,
      existing,
    });
  }

  /** Al cambiar canal/idioma dentro del editor, re-prefillea con su efectivo. */
  function retarget(channel: NotificationChannel, locale: string) {
    if (!editor) return;
    const existing = findOverride(overrides, editor.entry.key, channel, locale);
    setEditor({
      ...editor,
      channel,
      locale,
      subject: existing ? (existing.subject ?? '') : (editor.entry.defaultSubject ?? ''),
      body: existing ? existing.body : editor.entry.defaultBody,
      existing,
    });
  }

  async function handleSave() {
    if (!editor) return;
    setPending(true);
    setError(null);
    try {
      await adminNotificationsApi.upsertOverride(editor.entry.key, {
        channel: editor.channel,
        locale: editor.locale,
        subject: editor.subject.trim() ? editor.subject : null,
        body: editor.body,
      });
      setEditor(null);
      setNotice(`Plantilla de «${editor.entry.name}» personalizada.`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la plantilla.');
    } finally {
      setPending(false);
    }
  }

  /**
   * Manda el email real de esta plantilla a una dirección, para verlo antes de
   * que salga a cientos de personas. Las variables se rellenan con el nombre de
   * cada una entre corchetes: así se ve dónde encaja cada dato sin inventarse
   * valores que confundan.
   */
  async function handleSendTest() {
    if (!editor) return;
    const to = window.prompt(
      `¿A qué dirección enviamos la prueba de «${editor.entry.name}»?`,
      lastTestEmail,
    );
    if (!to?.trim()) return;

    setPending(true);
    setError(null);
    try {
      const variables = Object.fromEntries(
        editor.entry.variables.map((v) => [v.name, `[${v.name}]`]),
      );
      const res = await adminSmtpApi.testTemplate({
        toEmail: to.trim(),
        templateKey: editor.entry.key,
        variables,
      });
      setLastTestEmail(to.trim());
      setNotice(`Prueba enviada a ${res.sentTo}. Si no llega, mira en spam.`);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos enviar la prueba.');
    } finally {
      setPending(false);
    }
  }

  async function handleRestore(entry: EmailTemplateCatalogEntry, o: NotificationTemplateOverride) {
    if (
      !window.confirm(
        `¿Restaurar «${entry.name}» (${CHANNEL_LABEL[o.channel]} · ${o.locale}) al texto por defecto del producto?`,
      )
    )
      return;
    setPending(true);
    setError(null);
    try {
      await adminNotificationsApi.deleteOverride(o.key, { channel: o.channel, locale: o.locale });
      setEditor(null);
      setNotice(`«${entry.name}» vuelve al texto por defecto.`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos restaurar la plantilla.');
    } finally {
      setPending(false);
    }
  }

  if (catalog === null) {
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
      {notice ? (
        <div
          role="status"
          className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700"
        >
          {notice}
        </div>
      ) : null}

      {editor ? (
        <Card data-testid="email-template-editor">
          <CardHeader>
            <CardTitle>
              Personalizar «{editor.entry.name}»{' '}
              <span className="font-mono text-sm text-text-subtle">{editor.entry.key}</span>
            </CardTitle>
            <CardDescription>{editor.entry.description}</CardDescription>
          </CardHeader>
          <CardContent>
            {editor.entry.variables.length > 0 ? (
              <div className="mb-3 rounded-lg border border-border-soft bg-surface-subtle p-3">
                <p className="mb-1.5 text-xs font-semibold text-text-muted">
                  Variables disponibles (las no resueltas quedan vacías):
                </p>
                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                  {editor.entry.variables.map((v) => (
                    <li key={v.name} className="text-xs text-text-muted">
                      <code className="rounded bg-surface px-1 py-0.5">{`{{${v.name}}}`}</code>{' '}
                      {v.description}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {editor.entry.structuralNote ? (
              <p className="mb-3 rounded-lg border border-info-100 bg-info-50 p-3 text-xs text-info-700">
                ℹ️ {editor.entry.structuralNote}
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              {editor.entry.source === 'hub' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="tpl-channel">Canal</Label>
                    <Select
                      id="tpl-channel"
                      value={editor.channel}
                      onChange={(e) =>
                        retarget(e.target.value as NotificationChannel, editor.locale)
                      }
                    >
                      <option value="EMAIL">Email</option>
                      <option value="IN_APP">In-app</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tpl-locale">Idioma</Label>
                    <Select
                      id="tpl-locale"
                      value={editor.locale}
                      onChange={(e) => retarget(editor.channel, e.target.value)}
                    >
                      {SUPPORTED_LOCALES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label} ({l.code})
                        </option>
                      ))}
                    </Select>
                  </div>
                </>
              ) : (
                <p className="text-xs text-text-subtle sm:col-span-2">
                  Email transaccional — se personaliza el canal Email en español (es-ES).
                </p>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-subject">Asunto</Label>
                <Input
                  id="tpl-subject"
                  value={editor.subject}
                  onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
                  placeholder={editor.entry.defaultSubject ?? ''}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-body">Cuerpo</Label>
                <textarea
                  id="tpl-body"
                  rows={8}
                  value={editor.body}
                  onChange={(e) => setEditor({ ...editor, body: e.target.value })}
                  required
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border-soft pt-3">
              {editor.existing ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto text-danger-700"
                  onClick={() => void handleRestore(editor.entry, editor.existing!)}
                  disabled={pending}
                >
                  Restaurar por defecto
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleSendTest()}
                disabled={pending}
              >
                Enviarme una prueba
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditor(null)}
                disabled={pending}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={pending || !editor.body.trim()}
              >
                {pending ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {grouped.map((group) => (
        <Card key={group.key}>
          <CardHeader>
            <CardTitle>{group.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border-soft">
              {group.entries.map((entry) => {
                const entryOverrides = overrides.filter((o) => o.key === entry.key);
                const customized = entryOverrides.length > 0;
                return (
                  <li
                    key={entry.key}
                    className="flex flex-wrap items-start gap-3 py-3"
                    data-testid={`email-template-${entry.key}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
                        {entry.name}
                        {entry.channels.map((c) => (
                          <Badge key={c} variant="muted">
                            {CHANNEL_LABEL[c]}
                          </Badge>
                        ))}
                        {customized ? <Badge variant="info">Personalizado</Badge> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-text-subtle">{entry.description}</p>
                      <p className="mt-1 truncate text-xs text-text-muted">
                        <span className="font-medium">Asunto:</span>{' '}
                        {findOverride(overrides, entry.key, 'EMAIL', 'es-ES')?.subject ??
                          entry.defaultSubject ??
                          '(sin asunto)'}
                      </p>
                      {entryOverrides.length > 0 ? (
                        <ul className="mt-1.5 space-y-1">
                          {entryOverrides.map((o) => (
                            <li key={o.id} className="flex items-center gap-2 text-xs">
                              <Badge variant="info">
                                {CHANNEL_LABEL[o.channel]} · {o.locale}
                              </Badge>
                              <button
                                type="button"
                                onClick={() => openEditor(entry, o.channel, o.locale)}
                                className="text-text-muted hover:text-brand-700 hover:underline"
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRestore(entry, o)}
                                className="text-danger-700 hover:underline"
                                disabled={pending}
                              >
                                Restaurar
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditor(entry)}
                      disabled={pending}
                    >
                      {customized ? 'Editar' : 'Personalizar'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Alias legacy: el componente nació como tab "Plantillas" de configuración. */
export const NotificationTemplatesTab = EmailTemplatesManager;
