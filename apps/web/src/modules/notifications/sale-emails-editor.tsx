'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// «Correos»: lo que reciben los alumnos al comprar (recibo de la compra, de
/// cada renovación, pago fallido y reembolso). El creador cambia el asunto y el
/// mensaje con datos de la compra (`{nombre}`, `{producto}`…), lo ve al
/// momento con datos de ejemplo (ordenador y móvil), se manda una prueba y
/// puede volver al original. El recibo con los datos de la compra va siempre
/// debajo: eso no se edita.
///
/// Un solo componente para los dos modos (regla #5): Ajustes del modo sencillo
/// y `/admin/emails` en el completo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  SALE_EMAIL_LANGS,
  saleEmailsApi,
  type SaleEmailKey,
  type SaleEmailLang,
  type SaleEmailPreview,
  type SaleEmailsState,
  type SaleEmailTemplate,
} from './sale-emails-client';

/** Endónimos: cada idioma se reconoce en el suyo. */
const LANG_NAMES: Record<SaleEmailLang, string> = {
  es: 'Español',
  en: 'English',
  pt: 'Português',
};

type TemplateLabel =
  | 'purchase_receipt'
  | 'purchase_renewal_receipt'
  | 'purchase_payment_failed'
  | 'purchase_refund';

/** `purchase.receipt` → `purchase_receipt` (next-intl usa el punto para anidar). */
const labelKey = (key: SaleEmailKey) => key.replace(/\./g, '_') as TemplateLabel;

interface Draft {
  subject: string;
  body: string;
}

function effectiveText(tpl: SaleEmailTemplate, lang: SaleEmailLang): Draft {
  const own = tpl.overrides[lang];
  return own
    ? { subject: own.subject ?? tpl.defaults[lang].subject, body: own.body }
    : { ...tpl.defaults[lang] };
}

export function SaleEmailsEditor({ variant = 'simple' }: { variant?: 'simple' | 'full' }) {
  const t = useTranslations('correosVenta');
  const tErrors = useTranslations('errors');
  const [state, setState] = useState<SaleEmailsState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<SaleEmailKey | null>(null);
  const [lang, setLang] = useState<SaleEmailLang>('es');
  const [draft, setDraft] = useState<Draft>({ subject: '', body: '' });
  const [preview, setPreview] = useState<SaleEmailPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'reset'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState('');
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastField = useRef<'subject' | 'body'>('body');
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await saleEmailsApi.list();
      setState(next);
      setPolicy(next.settings.refundPolicyUrl ?? '');
      setLoadError(false);
      return next;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void reload().then((s) => {
      if (s) setLang(s.academyLocale);
    });
    // En el móvil, la vista previa empieza como la verá el alumno en el suyo.
    if (window.matchMedia?.('(max-width: 700px)').matches) setDevice('mobile');
  }, [reload]);

  const template = useMemo(
    () => state?.templates.find((tpl) => tpl.key === selected) ?? null,
    [state, selected],
  );
  const saved = template ? effectiveText(template, lang) : null;
  const dirty = !!saved && (saved.subject !== draft.subject || saved.body !== draft.body);
  const customized = !!template?.overrides[lang];

  function open(key: SaleEmailKey) {
    if (!state) return;
    const tpl = state.templates.find((x) => x.key === key);
    if (!tpl) return;
    setSelected(key);
    setDraft(effectiveText(tpl, lang));
    setNotice(null);
    setError(null);
    setPreview(null);
  }

  function changeLang(next: SaleEmailLang) {
    setLang(next);
    if (template) setDraft(effectiveText(template, next));
    setNotice(null);
    setError(null);
  }

  // Vista previa: el borrador tal cual, con medio segundo de calma al teclear.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      saleEmailsApi
        .preview(selected, lang, draft)
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError(false);
        })
        .catch(() => {
          if (!cancelled) setPreviewError(true);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected, lang, draft]);

  function fitFrame() {
    const doc = frameRef.current?.contentDocument;
    if (frameRef.current && doc?.documentElement) {
      frameRef.current.style.height = `${Math.max(doc.documentElement.scrollHeight, 400)}px`;
    }
  }

  function insertToken(variable: string) {
    if (!state) return;
    const text = `{${state.tokens[lang][variable as keyof SaleEmailsState['tokens']['es']]}}`;
    const field = lastField.current === 'subject' ? subjectRef.current : bodyRef.current;
    const key = lastField.current;
    const current = draft[key];
    const start = field?.selectionStart ?? current.length;
    const end = field?.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
    setDraft({ ...draft, [key]: next });
    window.requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function message(e: unknown, fallback: string): string {
    return e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : fallback;
  }

  async function save() {
    if (!selected) return;
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const stored = await saleEmailsApi.save(selected, lang, draft);
      setDraft(stored);
      await reload();
      setNotice(t('guardado'));
    } catch (e) {
      setError(message(e, t('errorGuardar')));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!selected) return;
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      const res = await saleEmailsApi.test(selected, lang, draft);
      setNotice(t('pruebaEnviada', { email: res.sentTo }));
    } catch (e) {
      setError(message(e, t('errorPrueba')));
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    if (!selected || !template) return;
    const name = t(`plantillas.${labelKey(selected)}.nombre`);
    if (!window.confirm(t('originalConfirmar', { nombre: name, idioma: LANG_NAMES[lang] }))) {
      return;
    }
    setBusy('reset');
    setError(null);
    setNotice(null);
    try {
      await saleEmailsApi.reset(selected, lang);
      const next = await reload();
      const tpl = next?.templates.find((x) => x.key === selected);
      if (tpl) setDraft(effectiveText(tpl, lang));
      setNotice(t('originalHecho'));
    } catch (e) {
      setError(message(e, t('errorGuardar')));
    } finally {
      setBusy(null);
    }
  }

  async function savePolicy() {
    setPolicyNotice(null);
    setPolicyError(null);
    const value = policy.trim();
    if (value && !/^https?:\/\/\S+\.\S+/i.test(value)) {
      setPolicyError(t('politicaInvalida'));
      return;
    }
    try {
      const res = await saleEmailsApi.saveSettings({ refundPolicyUrl: value || null });
      setPolicy(res.refundPolicyUrl ?? '');
      setPolicyNotice(t('politicaGuardada'));
    } catch (e) {
      setPolicyError(message(e, t('errorGuardar')));
    }
  }

  return (
    <section
      id="emails"
      data-testid="correos-venta"
      className="rounded-2xl border border-border bg-surface p-4 sm:p-6"
    >
      <h2 className="text-lg font-bold text-text">
        {variant === 'full' ? t('tituloCompleto') : t('titulo')}
      </h2>
      <p className="mt-1 max-w-[62ch] text-sm text-text-muted">{t('sub')}</p>

      {loadError ? (
        <p role="alert" className="mt-4 text-sm font-semibold text-danger-700">
          {t('errorCargar')}
        </p>
      ) : !state ? (
        <div className="mt-4 space-y-2" aria-hidden>
          <div className="skeleton h-14 w-full rounded-xl" />
          <div className="skeleton h-14 w-full rounded-xl" />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {state.templates.map((tpl) => {
            const any = SALE_EMAIL_LANGS.some((l) => tpl.overrides[l]);
            const isOpen = selected === tpl.key;
            return (
              <li key={tpl.key} data-testid={`correo-${tpl.key}`}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => (isOpen ? setSelected(null) : open(tpl.key))}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-subtle"
                >
                  <Icon name="mail" size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-text">
                      {t(`plantillas.${labelKey(tpl.key)}.nombre`)}
                    </span>
                    <span className="block text-sm text-text-muted">
                      {t(`plantillas.${labelKey(tpl.key)}.cuando`)}
                    </span>
                  </span>
                  <span
                    className={
                      any
                        ? 'rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700'
                        : 'rounded-full bg-bg-subtle px-2.5 py-0.5 text-xs font-semibold text-text-muted'
                    }
                  >
                    {any ? t('personalizado') : t('original')}
                  </span>
                  <span
                    className={isOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
                  >
                    <Icon name="chevron-down" size={16} />
                  </span>
                </button>

                {isOpen && template ? (
                  <div
                    className="border-t border-border px-4 pb-5 pt-4"
                    data-testid="editor-correo"
                  >
                    <fieldset>
                      <legend className="text-sm font-semibold text-text">{t('idioma')}</legend>
                      <div className="mt-1.5 inline-flex rounded-xl border border-border p-0.5">
                        {SALE_EMAIL_LANGS.map((l) => (
                          <button
                            key={l}
                            type="button"
                            lang={l}
                            aria-pressed={lang === l}
                            onClick={() => changeLang(l)}
                            className={
                              lang === l
                                ? 'h-9 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white'
                                : 'h-9 rounded-lg px-3 text-sm font-semibold text-text hover:bg-bg-subtle'
                            }
                          >
                            {LANG_NAMES[l]}
                            {template.overrides[l] ? ' •' : ''}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1.5 max-w-[62ch] text-sm text-text-subtle">
                        {t('idiomaAyuda')}
                      </p>
                    </fieldset>

                    <label
                      htmlFor="correo-asunto"
                      className="mt-4 block text-sm font-semibold text-text"
                    >
                      {t('asunto')}
                    </label>
                    <input
                      id="correo-asunto"
                      ref={subjectRef}
                      value={draft.subject}
                      maxLength={200}
                      onFocus={() => (lastField.current = 'subject')}
                      onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                      className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface px-3 text-[15px] text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
                    />

                    <label
                      htmlFor="correo-mensaje"
                      className="mt-4 block text-sm font-semibold text-text"
                    >
                      {t('mensaje')}
                    </label>
                    <textarea
                      id="correo-mensaje"
                      ref={bodyRef}
                      rows={7}
                      value={draft.body}
                      maxLength={5000}
                      onFocus={() => (lastField.current = 'body')}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-[15px] leading-relaxed text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
                    />

                    <div className="mt-3">
                      <p className="text-sm font-semibold text-text">{t('datos')}</p>
                      <p className="text-sm text-text-subtle">{t('datosAyuda')}</p>
                      <div className="mt-2 flex flex-wrap gap-2" data-testid="datos-correo">
                        {template.variables.map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => insertToken(v)}
                            title={t(`vars.${v}`)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm text-text hover:border-brand-600"
                          >
                            <span className="font-mono text-[13px] text-brand-700">
                              {`{${state.tokens[lang][v]}}`}
                            </span>
                            <span className="text-text-muted">{t(`vars.${v}`)}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <p className="mt-4 flex gap-2 rounded-xl bg-bg-subtle p-3 text-sm text-text-muted">
                      <Icon name="lock" size={16} />
                      <span>{t('reciboFijo')}</span>
                    </p>

                    {error ? (
                      <p role="alert" className="mt-3 text-sm font-semibold text-danger-700">
                        {error}
                      </p>
                    ) : null}
                    {notice ? (
                      <p
                        role="status"
                        className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-success-700"
                      >
                        <Icon name="check" size={16} />
                        {notice}
                      </p>
                    ) : null}

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void save()}
                        disabled={
                          !dirty || !draft.subject.trim() || !draft.body.trim() || busy !== null
                        }
                        className="h-11 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                      >
                        {busy === 'save' ? t('guardando') : t('guardar')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendTest()}
                        disabled={busy !== null}
                        className="h-11 rounded-xl border border-border bg-surface px-4 font-semibold text-text hover:border-border-strong disabled:opacity-50"
                      >
                        {busy === 'test' ? t('enviando') : t('probar')}
                      </button>
                      {customized ? (
                        <button
                          type="button"
                          onClick={() => void restore()}
                          disabled={busy !== null}
                          className="h-11 rounded-xl px-3 font-semibold text-danger-700 hover:bg-danger-50 disabled:opacity-50"
                        >
                          {t('volverOriginal')}
                        </button>
                      ) : null}
                    </div>

                    <div className="mt-6">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-[15px] font-bold text-text">{t('vistaPrevia')}</h3>
                        <div className="inline-flex rounded-xl border border-border p-0.5">
                          {(['desktop', 'mobile'] as const).map((d) => (
                            <button
                              key={d}
                              type="button"
                              aria-pressed={device === d}
                              onClick={() => setDevice(d)}
                              className={
                                device === d
                                  ? 'h-8 rounded-lg bg-bg-subtle px-3 text-sm font-semibold text-text'
                                  : 'h-8 rounded-lg px-3 text-sm text-text-muted hover:text-text'
                              }
                            >
                              {d === 'desktop' ? t('ordenador') : t('movil')}
                            </button>
                          ))}
                        </div>
                      </div>
                      {preview ? (
                        <p
                          className="mt-2 truncate text-sm text-text-muted"
                          data-testid="vista-previa-asunto"
                        >
                          <span className="font-semibold text-text">{t('asunto')}:</span>{' '}
                          {preview.subject}
                        </p>
                      ) : null}
                      {previewError ? (
                        <p role="alert" className="mt-2 text-sm text-danger-700">
                          {t('errorVista')}
                        </p>
                      ) : null}
                      <div className="mt-2 overflow-x-auto rounded-xl border border-border bg-bg-subtle p-2">
                        {preview ? (
                          <iframe
                            ref={frameRef}
                            title={t('vistaPrevia')}
                            data-testid="vista-previa-correo"
                            sandbox="allow-same-origin"
                            srcDoc={preview.html}
                            onLoad={fitFrame}
                            className="mx-auto block rounded-lg bg-white"
                            style={{
                              // Su ancho de verdad: en una pantalla estrecha se
                              // desplaza en vez de encoger (encogido no sería
                              // lo que ve el alumno).
                              width: device === 'desktop' ? 640 : 375,
                              height: 900,
                              border: 0,
                            }}
                          />
                        ) : (
                          <div
                            className="skeleton mx-auto h-[420px] w-full rounded-lg"
                            aria-hidden
                          />
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {state ? (
        <div className="mt-6">
          <label htmlFor="correo-politica" className="block text-sm font-semibold text-text">
            {t('politica')}
          </label>
          <p className="mt-0.5 max-w-[62ch] text-sm text-text-subtle">{t('politicaAyuda')}</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input
              id="correo-politica"
              type="url"
              inputMode="url"
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
              placeholder="https://"
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-[15px] text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
            />
            <button
              type="button"
              onClick={() => void savePolicy()}
              className="h-11 rounded-xl border border-border bg-surface px-4 font-semibold text-text hover:border-border-strong"
            >
              {t('politicaGuardar')}
            </button>
          </div>
          {policyError ? (
            <p role="alert" className="mt-1.5 text-sm font-semibold text-danger-700">
              {policyError}
            </p>
          ) : null}
          {policyNotice ? (
            <p role="status" className="mt-1.5 text-sm font-semibold text-success-700">
              {policyNotice}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
