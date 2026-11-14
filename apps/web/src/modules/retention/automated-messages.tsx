'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Switch } from '@/components/ui/switch';
import { UserAvatar } from '@/components/user-chip';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { cn } from '@/lib/utils';
import {
  isModuleOff,
  retentionApi,
  type Automation,
  type AutomationDraft,
  type PreviewResult,
  type RetentionSettings,
  type RetentionTemplate,
  type RetentionTrigger,
  RETENTION_TRIGGERS,
} from './client';

/**
 * «Mensajes automáticos»: lo que el aula le escribe sola a cada persona
 * (bienvenida, primera semana, si deja de entrar…), firmado por quien la
 * administra. Pensada para quien no es técnico: plantillas que se activan con
 * un clic, frases en vez de opciones y una vista previa con datos reales.
 *
 * La misma pieza vale para el modo sencillo (Ajustes) y para el completo
 * (pestaña en Configuración): solo cambia el envoltorio.
 */

type UiLang = 'es' | 'en' | 'pt';

/** Variables en el orden en que se ofrecen, con su nombre en cada idioma. */
type VariableKey =
  | 'name'
  | 'academy'
  | 'course'
  | 'courseLink'
  | 'introLink'
  | 'communityLink'
  | 'academyLink'
  | 'level';

const VARIABLES: ReadonlyArray<{
  key: VariableKey;
  tokens: Record<UiLang, string>;
  onlyLevel?: true;
}> = [
  { key: 'name', tokens: { es: 'nombre', en: 'name', pt: 'nome' } },
  { key: 'academy', tokens: { es: 'academia', en: 'academy', pt: 'escola' } },
  { key: 'course', tokens: { es: 'curso', en: 'course', pt: 'curso' } },
  { key: 'courseLink', tokens: { es: 'enlace_curso', en: 'course_link', pt: 'link_curso' } },
  {
    key: 'introLink',
    tokens: { es: 'enlace_presentate', en: 'intro_link', pt: 'link_apresentacao' },
  },
  {
    key: 'communityLink',
    tokens: { es: 'enlace_comunidad', en: 'community_link', pt: 'link_comunidade' },
  },
  { key: 'academyLink', tokens: { es: 'enlace_academia', en: 'academy_link', pt: 'link_escola' } },
  { key: 'level', tokens: { es: 'nivel', en: 'level', pt: 'nivel' }, onlyLevel: true },
];

function uiLang(locale: string): UiLang {
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return base === 'en' || base === 'pt' ? base : 'es';
}

const HOURS = Array.from({ length: 25 }, (_, h) => h);

export function AutomatedMessages({ variant = 'simple' }: { variant?: 'simple' | 'full' }) {
  const t = useTranslations('modRetention');
  const tErrors = useTranslations('errors');
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [templates, setTemplates] = useState<RetentionTemplate[]>([]);
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [moduleOff, setModuleOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, tpls, st] = await Promise.all([
        retentionApi.list(),
        retentionApi.templates(),
        retentionApi.settings(),
      ]);
      setAutomations(list);
      setTemplates(tpls);
      setSettings(st);
      setError(null);
    } catch (err) {
      if (isModuleOff(err)) setModuleOff(true);
      else setError(apiErrorMessage(err, tErrors));
    }
  }, [tErrors]);

  useEffect(() => {
    void load();
  }, [load]);

  async function activate(key: string) {
    setBusyKey(key);
    try {
      await retentionApi.activateTemplate(key);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setBusyKey(null);
    }
  }

  async function toggle(a: Automation, enabled: boolean) {
    setBusyKey(a.id);
    try {
      const updated = await retentionApi.update(a.id, { enabled });
      setAutomations((prev) => prev?.map((x) => (x.id === a.id ? updated : x)) ?? null);
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setBusyKey(null);
    }
  }

  if (moduleOff) return null;

  const available = templates.filter((tp) => !tp.automationId && !tp.unavailableReason);

  return (
    <section
      data-testid="mensajes-automaticos"
      className={cn(
        'rounded-2xl border border-border bg-surface p-4 sm:p-6',
        variant === 'full' && 'rounded-xl',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-text">{t('titulo')}</h2>
          <p className="mt-1 max-w-[62ch] text-sm text-text-muted">{t('sub')}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-text hover:border-border-strong"
        >
          <Icon name="plus" size={16} />
          {t('nuevo')}
        </button>
      </div>

      {settings ? <SenderLine settings={settings} onSettings={setSettings} /> : null}

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
        >
          {error}
        </p>
      ) : null}

      {automations === null ? (
        <div className="skeleton mt-4 h-24" />
      ) : automations.length > 0 ? (
        <ul
          className="mt-4 divide-y divide-border rounded-xl border border-border"
          data-testid="lista-mensajes"
        >
          {automations.map((a) => (
            <li
              key={a.id}
              data-testid={`mensaje-${a.templateKey ?? a.id}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
            >
              <span
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-full',
                  a.enabled ? 'bg-brand-50 text-brand-700' : 'bg-bg-subtle text-text-subtle',
                )}
              >
                <Icon name={triggerIcon(a.trigger)} size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-text">{a.name}</span>
                  {a.emailEnabled ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-bg-subtle px-2 py-0.5 text-xs font-semibold text-text-muted">
                      <Icon name="mail" size={12} />
                      {t('tambienCorreo')}
                    </span>
                  ) : null}
                </div>
                <div className="text-sm text-text-muted">
                  {triggerSummary(t as unknown as T, a)}
                </div>
                <div className="mt-0.5 text-xs text-text-subtle" data-testid="metricas">
                  {t('metricas', {
                    enviados: a.stats.sent,
                    leidos: a.stats.read,
                    respondidos: a.stats.replied,
                  })}
                  {a.stats.pending > 0 ? ` · ${t('enCola', { n: a.stats.pending })}` : ''}
                </div>
              </div>
              <Switch
                checked={a.enabled}
                disabled={busyKey === a.id}
                label={
                  a.enabled ? t('apagar', { nombre: a.name }) : t('encender', { nombre: a.name })
                }
                onCheckedChange={(v) => void toggle(a, v)}
              />
              <button
                type="button"
                onClick={() => setEditing(a)}
                className="text-sm font-semibold text-brand-600 hover:underline"
              >
                {t('editar')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-xl bg-bg-subtle p-4 text-sm text-text-muted">{t('vacio')}</p>
      )}

      {available.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-[15px] font-bold text-text">{t('plantillasTitulo')}</h3>
          <p className="mt-1 text-sm text-text-muted">{t('plantillasSub')}</p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {available.map((tp) => (
              <li
                key={tp.key}
                data-testid={`plantilla-${tp.key}`}
                className="flex flex-col rounded-xl border border-border p-4"
              >
                <div className="flex items-center gap-2">
                  <Icon name={triggerIcon(tp.trigger)} size={16} />
                  <span className="font-semibold text-text">{tp.name}</span>
                </div>
                <p className="mt-1 text-sm text-text-muted">
                  {triggerSummary(t as unknown as T, tp)}
                </p>
                <p className="mt-2 line-clamp-3 text-sm whitespace-pre-line text-text-subtle">
                  <TokenText text={tp.body} />
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={busyKey === tp.key}
                    onClick={() => void activate(tp.key)}
                    className="h-9 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {t('activar')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {settings ? <RulesPanel settings={settings} onSettings={setSettings} /> : null}

      {editing ? (
        <AutomationEditor
          automation={editing === 'new' ? null : editing}
          sender={settings?.sender ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Texto de una plantilla con sus variables resaltadas: quien no es técnico ve
 * de un vistazo qué parte se cambia por el dato de cada persona.
 */
function TokenText({ text }: { text: string }) {
  const parts = text.split(/(\{[\p{L}_]+\})/u);
  return (
    <>
      {parts.map((part, i) =>
        /^\{[\p{L}_]+\}$/u.test(part) ? (
          <span key={i} className="rounded bg-brand-50 px-1 font-medium text-brand-700">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** La pestaña «Mensajes automáticos» de Configuración (modo completo). */
export function AutomatedMessagesTab() {
  return <AutomatedMessages variant="full" />;
}

function triggerIcon(trigger: RetentionTrigger): Parameters<typeof Icon>[0]['name'] {
  switch (trigger) {
    case 'WELCOME':
      return 'sparkles';
    case 'DAYS_AFTER_JOIN':
      return 'calendar';
    case 'INACTIVE':
      return 'clock';
    case 'COURSE_COMPLETED':
      return 'award';
    case 'FIRST_POST':
      return 'message';
    case 'LEVEL_UP':
      return 'trophy';
    case 'ANNIVERSARY':
      return 'target';
  }
}

/** Lo justo del traductor para los textos que dependen de los días. */
type T = (key: string, values?: Record<string, string | number>) => string;

function triggerSummary(
  t: T,
  a: { trigger: RetentionTrigger; days: number | null; resendAfterDays: number | null },
): string {
  const base = t(`disparador.${a.trigger}`, { dias: a.days ?? 0 });
  if (a.trigger === 'INACTIVE' && a.resendAfterDays) {
    return `${base} · ${t('reenvio', { dias: a.resendAfterDays })}`;
  }
  return base;
}

function SenderLine({
  settings,
  onSettings,
}: {
  settings: RetentionSettings;
  onSettings: (s: RetentionSettings) => void;
}) {
  const t = useTranslations('modRetention');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  if (!settings.sender) return null;
  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-bg-subtle px-4 py-3"
      data-testid="firma"
    >
      <UserAvatar name={settings.sender.name} avatarUrl={settings.sender.avatarUrl} size={32} />
      <span className="min-w-0 flex-1 text-sm text-text">
        {t('firma', { nombre: settings.sender.name ?? '' })}
      </span>
      {settings.staff.length > 1 ? (
        <select
          aria-label={t('firmaCambiar')}
          value={settings.sender.id}
          onChange={async (e) => {
            try {
              onSettings(await retentionApi.saveSettings({ senderUserId: e.target.value }));
              setError(null);
            } catch (err) {
              setError(apiErrorMessage(err, tErrors));
            }
          }}
          className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-text"
        >
          {settings.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : null}
      {error ? <span className="w-full text-sm text-danger-700">{error}</span> : null}
    </div>
  );
}

function RulesPanel({
  settings,
  onSettings,
}: {
  settings: RetentionSettings;
  onSettings: (s: RetentionSettings) => void;
}) {
  const t = useTranslations('modRetention');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  async function save(patch: Parameters<typeof retentionApi.saveSettings>[0]) {
    try {
      onSettings(await retentionApi.saveSettings(patch));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    }
  }
  return (
    <details className="mt-6 rounded-xl border border-border px-4 py-3" data-testid="reglas">
      <summary className="cursor-pointer text-[15px] font-bold text-text">
        {t('reglasTitulo')}
      </summary>
      <ul className="mt-3 space-y-1.5 text-sm text-text-muted">
        <li>• {t('reglaUnoAlDia')}</li>
        <li>• {t('reglaEquipo')}</li>
        <li>• {t('reglaNoRepetir')}</li>
        <li>• {t('reglaDesdeActivar')}</li>
      </ul>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-semibold text-text">
          {t('franja')}
          <span className="mt-1.5 flex items-center gap-2 font-normal">
            <select
              aria-label={t('franjaDesde')}
              value={settings.sendWindowStartHour}
              onChange={(e) => void save({ sendWindowStartHour: Number(e.target.value) })}
              className="h-10 rounded-lg border border-border bg-surface px-2 text-sm"
            >
              {HOURS.slice(0, 23).map((h) => (
                <option key={h} value={h}>
                  {`${String(h).padStart(2, '0')}:00`}
                </option>
              ))}
            </select>
            <span className="text-text-muted">{t('franjaA')}</span>
            <select
              aria-label={t('franjaHasta')}
              value={settings.sendWindowEndHour}
              onChange={(e) => void save({ sendWindowEndHour: Number(e.target.value) })}
              className="h-10 rounded-lg border border-border bg-surface px-2 text-sm"
            >
              {HOURS.slice(2).map((h) => (
                <option key={h} value={h}>
                  {`${String(h).padStart(2, '0')}:00`}
                </option>
              ))}
            </select>
          </span>
          <span className="mt-1 block text-xs font-normal text-text-subtle">
            {t('franjaAyuda')}
          </span>
        </label>
        <label className="block text-sm font-semibold text-text">
          {t('esperaManual')}
          <select
            value={settings.manualCooldownHours}
            onChange={(e) => void save({ manualCooldownHours: Number(e.target.value) })}
            className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface px-2 text-sm font-normal"
          >
            {[0, 12, 24, 48, 72].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? t('esperaNunca') : t('esperaHoras', { horas: h })}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs font-normal text-text-subtle">
            {t('esperaAyuda')}
          </span>
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger-700">
          {error}
        </p>
      ) : null}
    </details>
  );
}

function AutomationEditor({
  automation,
  sender,
  onClose,
  onSaved,
}: {
  automation: Automation | null;
  sender: RetentionSettings['sender'];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('modRetention');
  const tErrors = useTranslations('errors');
  const lang = uiLang(useLocale());
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    automation
      ? {
          trigger: automation.trigger,
          name: automation.name,
          days: automation.days,
          resendAfterDays: automation.resendAfterDays,
          body: automation.body,
          emailEnabled: automation.emailEnabled,
          emailSubject: automation.emailSubject,
        }
      : {
          trigger: 'WELCOME',
          name: '',
          days: null,
          resendAfterDays: null,
          body: '',
          emailEnabled: false,
          emailSubject: '',
        },
  );
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const needsDays = draft.trigger === 'DAYS_AFTER_JOIN' || draft.trigger === 'INACTIVE';
  const variables = useMemo(
    () => VARIABLES.filter((v) => !v.onlyLevel || draft.trigger === 'LEVEL_UP'),
    [draft.trigger],
  );

  // Vista previa con los datos de quien mira (sin inventar a nadie).
  useEffect(() => {
    if (!draft.body.trim()) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const id = setTimeout(() => {
      retentionApi
        .preview({ trigger: draft.trigger, body: draft.body, subject: draft.emailSubject })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err) => setPreviewError(apiErrorMessage(err, tErrors)));
    }, 350);
    return () => clearTimeout(id);
  }, [draft.trigger, draft.body, draft.emailSubject, tErrors]);

  function insert(token: string) {
    const el = bodyRef.current;
    const text = `{${token}}`;
    if (!el) {
      setDraft((d) => ({ ...d, body: d.body + text }));
      return;
    }
    const start = el.selectionStart ?? draft.body.length;
    const end = el.selectionEnd ?? start;
    const next = draft.body.slice(0, start) + text + draft.body.slice(end);
    setDraft((d) => ({ ...d, body: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...draft,
        days: needsDays ? draft.days : null,
        resendAfterDays: draft.trigger === 'INACTIVE' ? draft.resendAfterDays : null,
        emailSubject: draft.emailSubject?.trim() || null,
      };
      if (automation) {
        const { trigger: _trigger, ...patch } = payload;
        void _trigger;
        await retentionApi.update(automation.id, patch);
      } else {
        await retentionApi.create({ ...payload, enabled: true });
      }
      await onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!automation || !confirm(t('borrarConfirmar'))) return;
    try {
      await retentionApi.remove(automation.id);
      await onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    }
  }

  return (
    <div
      className="mt-6 rounded-2xl border-2 border-brand-200 bg-surface p-4 sm:p-5"
      data-testid="editor-mensaje"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-bold text-text">
          {automation ? t('editorEditar') : t('editorNuevo')}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-text-muted hover:underline"
        >
          {t('cancelar')}
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="min-w-0 space-y-4">
          <label className="block text-sm font-semibold text-text">
            {t('cuando')}
            <select
              value={draft.trigger}
              disabled={automation !== null}
              onChange={(e) => {
                const trigger = e.target.value as RetentionTrigger;
                setDraft((d) => ({
                  ...d,
                  trigger,
                  days: trigger === 'DAYS_AFTER_JOIN' ? 7 : trigger === 'INACTIVE' ? 14 : null,
                  resendAfterDays: null,
                }));
              }}
              className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface px-3 text-[15px] font-normal disabled:bg-bg-subtle"
            >
              {RETENTION_TRIGGERS.map((tr) => (
                <option key={tr} value={tr}>
                  {t(`disparadorOpcion.${tr}`)}
                </option>
              ))}
            </select>
          </label>

          {needsDays ? (
            <div className="flex flex-wrap items-end gap-4">
              <label className="block text-sm font-semibold text-text">
                {draft.trigger === 'INACTIVE' ? t('diasSinEntrar') : t('diasDesdeAlta')}
                <input
                  type="number"
                  min={draft.trigger === 'INACTIVE' ? 3 : 1}
                  max={draft.trigger === 'INACTIVE' ? 365 : 730}
                  value={draft.days ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      days: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  className="mt-1.5 h-11 w-28 rounded-xl border border-border bg-surface px-3 text-[15px] font-normal"
                />
              </label>
              {draft.trigger === 'INACTIVE' ? (
                <label className="flex items-center gap-2 pb-2.5 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={draft.resendAfterDays !== null}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, resendAfterDays: e.target.checked ? 7 : null }))
                    }
                    className="h-4 w-4"
                  />
                  {t('reenviarSi')}
                  {draft.resendAfterDays !== null ? (
                    <input
                      type="number"
                      min={1}
                      max={90}
                      aria-label={t('reenviarDias')}
                      value={draft.resendAfterDays}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, resendAfterDays: Number(e.target.value) || 1 }))
                      }
                      className="h-9 w-16 rounded-lg border border-border bg-surface px-2"
                    />
                  ) : null}
                  {draft.resendAfterDays !== null ? t('reenviarDiasMas') : null}
                </label>
              ) : null}
            </div>
          ) : null}

          <label className="block text-sm font-semibold text-text">
            {t('nombreInterno')}
            <input
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={t('nombreInternoEjemplo')}
              className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface px-3 text-[15px] font-normal"
            />
          </label>

          <div>
            <label htmlFor="mensaje-texto" className="block text-sm font-semibold text-text">
              {t('texto')}
            </label>
            <textarea
              id="mensaje-texto"
              ref={bodyRef}
              rows={8}
              maxLength={4000}
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-[15px] leading-relaxed text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
            />
            <p className="mt-1 text-xs text-text-subtle">{t('variablesAyuda')}</p>
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="variables">
              {variables.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insert(v.tokens[lang])}
                  title={t(`variable.${v.key}`)}
                  className="rounded-full border border-border bg-bg-subtle px-2.5 py-1 font-mono text-xs text-text hover:border-brand-600"
                >
                  {`{${v.tokens[lang]}}`}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-bg-subtle p-3">
            <label className="flex items-center justify-between gap-3 text-sm font-semibold text-text">
              <span>
                {t('correoTambien')}
                <span className="block text-xs font-normal text-text-muted">
                  {t('correoAyuda')}
                </span>
              </span>
              <Switch
                checked={draft.emailEnabled}
                label={t('correoTambien')}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, emailEnabled: v }))}
              />
            </label>
            {draft.emailEnabled ? (
              <input
                aria-label={t('asunto')}
                placeholder={t('asunto')}
                value={draft.emailSubject ?? ''}
                maxLength={200}
                onChange={(e) => setDraft((d) => ({ ...d, emailSubject: e.target.value }))}
                className="mt-3 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
              />
            ) : null}
          </div>
        </div>

        <div className="min-w-0" data-testid="vista-previa">
          <p className="text-sm font-semibold text-text">{t('vistaPrevia')}</p>
          <p className="text-xs text-text-subtle">
            {preview
              ? t('vistaPreviaPara', { nombre: preview.recipient.name })
              : t('vistaPreviaAyuda')}
          </p>
          <div className="mt-2 rounded-2xl bg-bg-subtle p-3">
            {sender ? (
              <div className="flex items-start gap-2.5">
                <UserAvatar name={sender.name} avatarUrl={sender.avatarUrl} size={34} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text">{sender.name}</div>
                  <div className="mt-1 rounded-2xl rounded-tl-sm bg-surface px-3 py-2 text-[15px] leading-relaxed break-words whitespace-pre-line text-text shadow-sm [overflow-wrap:anywhere]">
                    {preview?.body ?? draft.body ?? ''}
                  </div>
                </div>
              </div>
            ) : null}
            {draft.emailEnabled && preview?.subject ? (
              <p className="mt-3 text-xs text-text-muted">
                <Icon name="mail" size={12} /> {t('asuntoPrevia', { asunto: preview.subject })}
              </p>
            ) : null}
          </div>
          {previewError ? (
            <p role="alert" className="mt-2 text-sm font-semibold text-danger-700">
              {previewError}
            </p>
          ) : null}
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving || !draft.body.trim()}
          onClick={() => void save()}
          className="h-11 rounded-xl bg-brand-600 px-6 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? t('guardando') : automation ? t('guardar') : t('guardarYActivar')}
        </button>
        {automation ? (
          <button
            type="button"
            onClick={() => void remove()}
            className="text-sm font-semibold text-danger-700 hover:underline"
          >
            {t('borrar')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
