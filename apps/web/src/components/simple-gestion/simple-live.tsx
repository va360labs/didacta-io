'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { formatDateTime } from '@/lib/i18n/format';
import { getBrowserTimeZone } from '@/lib/i18n/user-prefs';
import { tenantSettingsApi } from '@/lib/tenant-settings';
import { cn } from '@/lib/utils';
import { zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';
import { isoToWallTime } from '@/modules/zoom-live/wall-time';
import { buildStartIso, isHttpsUrl, upcoming } from './helpers';

const DURATIONS = [30, 45, 60, 90, 120];

/** Por dónde entra quien da la clase: su enlace de anfitrión o el de los alumnos. */
function entryUrl(s: ZoomSession): string | null {
  return s.startUrl || s.joinUrl || null;
}

const inputCls =
  'mt-1.5 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100';

/**
 * «Directos» del MODO SENCILLO: crear una clase es título, día y hora, y el
 * enlace de la videollamada que ya usa el creador (Zoom, Meet, Teams…). Sin
 * credenciales de Zoom ni «email del host». Si el aula tiene Zoom conectado,
 * se ofrece además que la reunión se cree sola. Los recordatorios y el
 * calendario son los de siempre (la clase es la misma fila).
 */
export function SimpleLive() {
  const t = useTranslations('modoSencilloGestion.directos');
  const [sessions, setSessions] = useState<ZoomSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | ZoomSession | null>(null);
  const [zoomConnected, setZoomConnected] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await zoomLiveApi.list());
      setError(null);
    } catch {
      setError(t('cargaError'));
    }
  }, [t]);

  useEffect(() => {
    void load();
    // ¿Tiene el aula su propio Zoom conectado? Solo entonces se ofrece crearla sola.
    tenantSettingsApi
      .get('zoom-live', 'credentials')
      .then(() => setZoomConnected(true))
      .catch(() => setZoomConnected(false));
  }, [load]);

  const next = sessions ? upcoming(sessions) : null;

  async function cancel(id: string) {
    if (!confirm(t('borrarConfirmar'))) return;
    try {
      await zoomLiveApi.cancel(id);
      await load();
    } catch {
      setError(t('error'));
    }
  }

  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/live/${id}`);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      /* sin portapapeles: el enlace sigue en «Entrar» */
    }
  }

  return (
    <div className="mx-auto max-w-[820px]" data-testid="directos-sencillo">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-text">
            {t('titulo')}
          </h1>
          <p className="mt-1 max-w-[62ch] text-text-muted">{t('sub')}</p>
        </div>
        {form === null && next && next.length > 0 ? (
          <button
            type="button"
            onClick={() => setForm('new')}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
          >
            <Icon name="plus" size={17} />
            {t('nueva')}
          </button>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
        >
          {error}
        </p>
      ) : null}

      {form !== null ? (
        <LiveForm
          session={form === 'new' ? null : form}
          zoomConnected={zoomConnected}
          onCancel={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await load();
          }}
        />
      ) : null}

      {next === null ? (
        <div className="skeleton mt-6 h-40 w-full" />
      ) : next.length === 0 && form === null ? (
        <section className="mt-6 rounded-2xl border border-border bg-surface px-6 py-10 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-700">
            <Icon name="video" size={24} />
          </span>
          <h2 className="mt-4 text-lg font-bold text-text">{t('vacioTitulo')}</h2>
          <p className="mx-auto mt-2 max-w-[52ch] text-text-muted">{t('vacioTexto')}</p>
          <button
            type="button"
            onClick={() => setForm('new')}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
          >
            <Icon name="plus" size={17} />
            {t('vacioBoton')}
          </button>
        </section>
      ) : next.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-3 text-base font-bold text-text">
            {t('proximas')}
          </h2>
          <ul>
            {next.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-50 text-center text-brand-700">
                  <span className="text-[17px] leading-none font-extrabold tabular-nums">
                    {formatDateTime(s.startTime, { day: 'numeric', timeZone: s.timezone })}
                  </span>
                  <span className="text-[11px] font-bold uppercase">
                    {formatDateTime(s.startTime, { month: 'short', timeZone: s.timezone })}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-text">{s.topic}</div>
                  <div className="text-sm text-text-subtle">
                    {formatDateTime(s.startTime, {
                      weekday: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: s.timezone,
                    })}
                    {' · '}
                    {t('apuntados', { n: s.registeredCount })}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {entryUrl(s) ? (
                    <a
                      href={entryUrl(s) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                      <Icon name="video" size={15} />
                      {t('entrar')}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void copy(s.id)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-semibold text-text hover:border-border-strong"
                  >
                    <Icon name="link" size={15} />
                    {copied === s.id ? t('copiado') : t('copiarAviso')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm(s)}
                    className="h-9 px-2 text-sm font-semibold text-brand-600 hover:underline"
                  >
                    {t('editar')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void cancel(s.id)}
                    className="h-9 px-2 text-sm font-semibold text-text-muted hover:text-danger-700"
                  >
                    {t('borrar')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function LiveForm({
  session,
  zoomConnected,
  onCancel,
  onSaved,
}: {
  session: ZoomSession | null;
  zoomConnected: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('modoSencilloGestion.directos');
  const tz = session?.timezone ?? getBrowserTimeZone() ?? 'Europe/Madrid';
  const wall = session ? isoToWallTime(session.startTime, tz) : '';
  const [topic, setTopic] = useState(session?.topic ?? '');
  const [date, setDate] = useState(wall.slice(0, 10));
  const [time, setTime] = useState(wall.slice(11, 16) || '19:00');
  const [duration, setDuration] = useState(session?.durationMinutes ?? 60);
  // Una clase creada con Zoom (tiene meeting) no cambia de enlace aquí.
  const externa = !session || !session.zoomMeetingId;
  const [link, setLink] = useState(session && externa ? (session.joinUrl ?? '') : '');
  const [useZoom, setUseZoom] = useState(false);
  const [announce, setAnnounce] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!topic.trim()) return setError(t('faltaTitulo'));
    const startTime = buildStartIso(date, time, tz);
    if (!startTime) return setError(t('faltaFecha'));
    const conEnlace = externa && !useZoom;
    if (conEnlace && !link.trim()) return setError(t('faltaEnlace'));
    if (conEnlace && !isHttpsUrl(link)) return setError(t('enlaceMal'));
    setSaving(true);
    try {
      if (session) {
        await zoomLiveApi.update(session.id, {
          topic: topic.trim(),
          startTime,
          durationMinutes: duration,
          timezone: tz,
          ...(conEnlace ? { externalJoinUrl: link.trim() } : {}),
        });
      } else {
        await zoomLiveApi.create({
          topic: topic.trim(),
          startTime,
          durationMinutes: duration,
          timezone: tz,
          hostEmail: authStorage.getSession()?.user.email ?? '',
          announce,
          ...(conEnlace ? { externalJoinUrl: link.trim() } : {}),
        });
      }
      await onSaved();
    } catch (err) {
      setError(
        err instanceof ApiHttpError && err.code === 'ZOOM_NOT_CONFIGURED'
          ? t('sinZoom')
          : t('error'),
      );
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-6 grid gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5"
      data-testid="form-directo"
    >
      <h2 className="text-lg font-bold text-text">
        {session ? t('editarTitulo') : t('formTitulo')}
      </h2>
      <div>
        <label htmlFor="directo-titulo" className="text-sm font-semibold text-text">
          {t('campoTitulo')}
        </label>
        <input
          id="directo-titulo"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={t('campoTituloPlaceholder')}
          maxLength={200}
          className={inputCls}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_140px]">
        <div>
          <label htmlFor="directo-fecha" className="text-sm font-semibold text-text">
            {t('fecha')}
          </label>
          <input
            id="directo-fecha"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="directo-hora" className="text-sm font-semibold text-text">
            {t('hora')}
          </label>
          <input
            id="directo-hora"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="directo-duracion" className="text-sm font-semibold text-text">
            {t('duracion')}
          </label>
          <select
            id="directo-duracion"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className={cn(inputCls, 'px-3')}
          >
            {(DURATIONS.includes(duration)
              ? DURATIONS
              : [...DURATIONS, duration].sort((a, b) => a - b)
            ).map((m) => (
              <option key={m} value={m}>
                {t('minutos', { n: m })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="-mt-2 text-xs text-text-subtle">{t('zona', { zona: tz.replace(/_/g, ' ') })}</p>

      {externa ? (
        <div>
          {zoomConnected && !session ? (
            <div className="mb-3 flex items-start gap-3 rounded-xl bg-bg-subtle p-3 text-sm text-text">
              <input
                id="directo-zoom"
                type="checkbox"
                checked={useZoom}
                onChange={(e) => setUseZoom(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <label htmlFor="directo-zoom">
                <span className="block font-semibold">{t('zoomPorMi')}</span>
                <span className="text-text-muted">{t('zoomPorMiAyuda')}</span>
              </label>
            </div>
          ) : null}
          {!useZoom ? (
            <>
              <label htmlFor="directo-enlace" className="text-sm font-semibold text-text">
                {t('enlace')}
              </label>
              <input
                id="directo-enlace"
                type="url"
                inputMode="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={t('enlacePlaceholder')}
                className={inputCls}
              />
              <p className="mt-1.5 text-sm text-text-subtle">{t('enlaceAyuda')}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {!session ? (
        <label className="flex items-center gap-2.5 text-sm font-medium text-text">
          <input
            type="checkbox"
            checked={announce}
            onChange={(e) => setAnnounce(e.target.checked)}
            className="h-4 w-4"
          />
          {t('anunciar')}
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger-700">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="h-11 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? t('guardando') : session ? t('guardar') : t('crear')}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-semibold text-text-muted">
          {t('cancelar')}
        </button>
      </div>
    </form>
  );
}
