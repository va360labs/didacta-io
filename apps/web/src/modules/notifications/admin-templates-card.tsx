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
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { adminSmtpApi } from '@/lib/admin-smtp';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { labelOr } from '@/lib/i18n/labels';
import {
  adminNotificationsApi,
  type EmailTemplateCatalogEntry,
  type EmailTemplateCategory,
  type NotificationChannel,
  type NotificationTemplateOverride,
} from './admin-client';

/**
 * Idiomas que el tenant puede personalizar. Los nombres son ENDÓNIMOS (cada
 * idioma en el suyo), así que no pasan por el catálogo: «Español» se escribe
 * igual mire quien mire.
 */
const SUPPORTED_LOCALES = [
  { code: 'es-ES', label: 'Español' },
  { code: 'en-US', label: 'English' },
] as const;

/**
 * Idioma de referencia del producto (espejo de `HUB_DEFAULT_LOCALE` en la API).
 * Es el que se abre por defecto en el editor y el destino de cualquier camino
 * degradado: nunca un `undefined` implícito.
 */
const REFERENCE_LOCALE = 'es-ES';

/** Orden de las secciones del catálogo; el nombre sale de `category.*`. */
const CATEGORY_ORDER: EmailTemplateCategory[] = [
  'account',
  'members',
  'billing',
  'learning',
  'community',
  'system',
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
  const t = useTranslations('modNotifications');
  const tErrors = useTranslations('errors');
  const [catalog, setCatalog] = useState<EmailTemplateCatalogEntry[] | null>(null);
  /**
   * Copy por defecto del producto POR IDIOMA. El listado de la pantalla usa el
   * de referencia (`catalog`); el editor usa el del idioma que se está
   * personalizando.
   */
  const [catalogByLocale, setCatalogByLocale] = useState<
    Record<string, EmailTemplateCatalogEntry[]>
  >({});
  const [overrides, setOverrides] = useState<NotificationTemplateOverride[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState(false);
  /** Se recuerda entre envíos para no reescribir el correo cada vez. */
  const [lastTestEmail, setLastTestEmail] = useState('');

  async function reload() {
    try {
      // Un catálogo por idioma personalizable (hoy 2). Se piden juntos: el
      // editor necesita el copy por defecto del idioma que se elija SIN que la
      // pantalla se quede esperando a mitad de una edición.
      const [porIdioma, list] = await Promise.all([
        Promise.all(
          SUPPORTED_LOCALES.map(async (l) => [l.code, await adminNotificationsApi.getCatalog(l.code)] as const), // prettier-ignore
        ),
        adminNotificationsApi.listOverrides(),
      ]);
      const mapa = Object.fromEntries(porIdioma);
      setCatalogByLocale(mapa);
      setCatalog(mapa[REFERENCE_LOCALE] ?? null);
      setOverrides(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorLoad'));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const grouped = useMemo(() => {
    if (!catalog) return [];
    return CATEGORY_ORDER.map((key) => ({
      key,
      entries: catalog.filter((e) => e.category === key),
    })).filter((g) => g.entries.length > 0);
  }, [catalog]);

  /**
   * Copy por defecto del producto para (key, idioma). El catálogo se carga una
   * vez por idioma soportado, así que el prefill de un override `en-US` sale en
   * inglés: antes salía siempre en español y el admin tenía que borrar un texto
   * español para escribir el inglés encima.
   *
   * CAMINO DEGRADADO: un idioma sin catálogo cargado (fallo de red en su
   * fetch) cae al del idioma de referencia, que siempre está. Nunca a vacío:
   * un editor en blanco parece que el email no existe.
   */
  function defaultsFor(entry: EmailTemplateCatalogEntry, locale: string) {
    const porIdioma = catalogByLocale[locale]?.find((e) => e.key === entry.key);
    return porIdioma ?? entry;
  }

  /** Abre el editor prefilleado con el valor EFECTIVO (override o default). */
  function openEditor(
    entry: EmailTemplateCatalogEntry,
    channel: NotificationChannel = 'EMAIL',
    locale = REFERENCE_LOCALE,
  ) {
    const existing = findOverride(overrides, entry.key, channel, locale);
    const def = defaultsFor(entry, locale);
    setNotice(null);
    setEditor({
      entry,
      channel,
      locale,
      subject: existing ? (existing.subject ?? '') : (def.defaultSubject ?? ''),
      body: existing ? existing.body : def.defaultBody,
      existing,
    });
  }

  /** Al cambiar canal/idioma dentro del editor, re-prefillea con su efectivo. */
  function retarget(channel: NotificationChannel, locale: string) {
    if (!editor) return;
    const existing = findOverride(overrides, editor.entry.key, channel, locale);
    const def = defaultsFor(editor.entry, locale);
    setEditor({
      ...editor,
      channel,
      locale,
      subject: existing ? (existing.subject ?? '') : (def.defaultSubject ?? ''),
      body: existing ? existing.body : def.defaultBody,
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
      setNotice(t('noticeSaved', { name: editor.entry.name }));
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorSave'));
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
    const to = window.prompt(t('promptTestAddress', { name: editor.entry.name }), lastTestEmail);
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
      setNotice(t('noticeTestSent', { email: res.sentTo }));
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorTest'));
    } finally {
      setPending(false);
    }
  }

  async function handleRestore(entry: EmailTemplateCatalogEntry, o: NotificationTemplateOverride) {
    if (
      !window.confirm(
        t('confirmRestore', {
          name: entry.name,
          channel: labelOr(t, `channel.${o.channel}`, o.channel),
          locale: o.locale,
        }),
      )
    )
      return;
    setPending(true);
    setError(null);
    try {
      await adminNotificationsApi.deleteOverride(o.key, { channel: o.channel, locale: o.locale });
      setEditor(null);
      setNotice(t('noticeRestored', { name: entry.name }));
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorRestore'));
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
              {t('editorTitle', { name: editor.entry.name })}{' '}
              <span className="font-mono text-sm text-text-subtle">{editor.entry.key}</span>
            </CardTitle>
            <CardDescription>{editor.entry.description}</CardDescription>
          </CardHeader>
          <CardContent>
            {editor.entry.variables.length > 0 ? (
              <div className="mb-3 rounded-lg border border-border-soft bg-surface-subtle p-3">
                <p className="mb-1.5 text-xs font-semibold text-text-muted">
                  {t('variablesTitle')}
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
                    <Label htmlFor="tpl-channel">{t('channelLabel')}</Label>
                    <Select
                      id="tpl-channel"
                      value={editor.channel}
                      onChange={(e) =>
                        retarget(e.target.value as NotificationChannel, editor.locale)
                      }
                    >
                      <option value="EMAIL">{t('channel.EMAIL')}</option>
                      <option value="IN_APP">{t('channel.IN_APP')}</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tpl-locale">{t('localeLabel')}</Label>
                    <Select
                      id="tpl-locale"
                      value={editor.locale}
                      onChange={(e) => retarget(editor.channel, e.target.value)}
                    >
                      {SUPPORTED_LOCALES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {t('localeOption', { label: l.label, code: l.code })}
                        </option>
                      ))}
                    </Select>
                  </div>
                </>
              ) : (
                <p className="text-xs text-text-subtle sm:col-span-2">{t('transactionalNote')}</p>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-subject">{t('subjectLabel')}</Label>
                <Input
                  id="tpl-subject"
                  value={editor.subject}
                  onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
                  placeholder={editor.entry.defaultSubject ?? ''}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-body">{t('bodyLabel')}</Label>
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
                  {t('restoreDefault')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleSendTest()}
                disabled={pending}
              >
                {t('sendTest')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditor(null)}
                disabled={pending}
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={pending || !editor.body.trim()}
              >
                {pending ? t('saving') : t('save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {grouped.map((group) => (
        <Card key={group.key}>
          <CardHeader>
            <CardTitle>{t(`category.${group.key}`)}</CardTitle>
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
                            {labelOr(t, `channel.${c}`, c)}
                          </Badge>
                        ))}
                        {customized ? <Badge variant="info">{t('customized')}</Badge> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-text-subtle">{entry.description}</p>
                      <p className="mt-1 truncate text-xs text-text-muted">
                        <span className="font-medium">{t('subjectPrefix')}</span>{' '}
                        {findOverride(overrides, entry.key, 'EMAIL', 'es-ES')?.subject ??
                          entry.defaultSubject ??
                          t('noSubject')}
                      </p>
                      {entryOverrides.length > 0 ? (
                        <ul className="mt-1.5 space-y-1">
                          {entryOverrides.map((o) => (
                            <li key={o.id} className="flex items-center gap-2 text-xs">
                              <Badge variant="info">
                                {labelOr(t, `channel.${o.channel}`, o.channel)} · {o.locale}
                              </Badge>
                              <button
                                type="button"
                                onClick={() => openEditor(entry, o.channel, o.locale)}
                                className="text-text-muted hover:text-brand-700 hover:underline"
                              >
                                {t('edit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRestore(entry, o)}
                                className="text-danger-700 hover:underline"
                                disabled={pending}
                              >
                                {t('restore')}
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
                      {customized ? t('edit') : t('customize')}
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
