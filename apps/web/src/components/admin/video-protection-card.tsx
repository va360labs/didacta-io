'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Administración → Seguridad → Protección de vídeo (Bunny Stream).
 *
 * Aquí el admin de la academia:
 *  - ve si la protección está apagada, activada o activada con algo que revisar;
 *  - pega la «Token authentication key» de cada librería de Bunny. La clave
 *    viaja una sola vez del panel a la API y se guarda cifrada: nunca se vuelve
 *    a mostrar, solo si está guardada;
 *  - comprueba de verdad que Bunny acepta la firma (la API pide a Bunny un vídeo
 *    de la academia con firma y sin ella);
 *  - activa o desactiva la protección y ajusta el tope por cuenta y la marca de
 *    agua.
 *
 * El orden importa y la tarjeta lo dice: primero guardar la clave aquí y
 * DESPUÉS activar «Embed view token authentication» en Bunny. Al revés, todos
 * los vídeos dejan de cargar hasta que la clave esté puesta.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import {
  summarizeVideoProtection,
  videoProtectionApi,
  type SignatureCheckOutcome,
  type VideoProtectionLibrary,
  type VideoProtectionState,
  type VideoProtectionSummary,
} from '@/lib/video-protection';

export interface VideoProtectionCardProps {
  /** Inyectable para tests: permite pasar un cliente fake sin tocar fetch. */
  api?: typeof videoProtectionApi;
}

const STATUS_KEYS = {
  off: 'statusOff',
  disabled: 'statusDisabled',
  unverified: 'statusUnverified',
  attention: 'statusAttention',
  on: 'statusOn',
} as const satisfies Record<VideoProtectionSummary, string>;

const STATUS_STYLES: Record<VideoProtectionSummary, string> = {
  off: 'border-border bg-surface-2 text-text',
  disabled: 'border-warning-200 bg-warning-50 text-warning-700',
  unverified: 'border-warning-200 bg-warning-50 text-warning-700',
  attention: 'border-danger-100 bg-danger-50 text-danger-700',
  on: 'border-success-200 bg-success-50 text-success-700',
};

const CHECK_KEYS = {
  ok: 'checkOk',
  not_enforced: 'checkNotEnforced',
  rejected: 'checkRejected',
  video_unavailable: 'checkVideoUnavailable',
  unreachable: 'checkUnreachable',
  no_key: 'checkNoKey',
  no_video: 'checkNoVideo',
} as const satisfies Record<SignatureCheckOutcome, string>;

function checkTone(outcome: SignatureCheckOutcome): string {
  if (outcome === 'ok') return 'text-success-700';
  if (outcome === 'rejected') return 'text-danger-700';
  return 'text-warning-700';
}

const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;
const code = (chunks: ReactNode) => (
  <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{chunks}</code>
);

export function VideoProtectionCard({ api = videoProtectionApi }: VideoProtectionCardProps) {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [state, setState] = useState<VideoProtectionState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await api.getAdmin();
        if (!cancelled) setState(fresh);
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('videoProtection.loadError'),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const summary = state ? summarizeVideoProtection(state) : null;

  return (
    <Card data-testid="video-protection-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="video" size={18} />
          {t('videoProtection.title')}
        </CardTitle>
        <CardDescription>{t('videoProtection.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {loadError ? (
          <p role="alert" className="text-sm text-danger-700">
            {loadError}
          </p>
        ) : null}

        {!state && !loadError ? <div className="skeleton h-24 w-full" /> : null}

        {state && summary ? (
          <>
            <div
              role="status"
              data-testid={`video-protection-status-${summary}`}
              className={`rounded-lg border px-3 py-2 text-sm ${STATUS_STYLES[summary]}`}
            >
              {t.rich(`videoProtection.${STATUS_KEYS[summary]}`, { strong })}
            </div>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text">{t('videoProtection.stepsTitle')}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-text-muted">
                <li>{t.rich('videoProtection.step1', { strong })}</li>
                <li>{t('videoProtection.step2')}</li>
                <li>{t.rich('videoProtection.step3', { strong })}</li>
                <li>{t.rich('videoProtection.step4', { strong })}</li>
                <li>{t.rich('videoProtection.step5', { strong, code })}</li>
              </ol>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text">
                {t('videoProtection.librariesTitle')}
              </h3>
              {state.libraries.length > 0 ? (
                <ul className="flex flex-col gap-4">
                  {state.libraries.map((library) => (
                    <li key={library.libraryId}>
                      <LibraryForm api={api} library={library} onState={setState} />
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <p className="text-sm text-text-muted">{t('videoProtection.noLibraries')}</p>
                  <LibraryForm api={api} onState={setState} />
                </>
              )}
            </section>

            <SettingsForm api={api} state={state} onState={setState} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Clave y comprobación de UNA librería. Sin `library` (aún no hay vídeos de
 * Bunny detectados en la academia) pide también el ID de la librería.
 */
function LibraryForm({
  api,
  library,
  onState,
}: {
  api: typeof videoProtectionApi;
  library?: VideoProtectionLibrary;
  onState: (state: VideoProtectionState) => void;
}) {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [libraryInput, setLibraryInput] = useState('');
  const [tokenKey, setTokenKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Resultado de la comprobación recién lanzada (también `no_key`/`no_video`, que no se guardan). */
  const [checked, setChecked] = useState<SignatureCheckOutcome | null>(null);

  const libraryId = library?.libraryId;
  const configured = library?.configured ?? false;
  const idPrefix = `video-protection-${libraryId ?? 'new'}`;
  const targetLibrary = (libraryId ?? libraryInput).trim();
  const outcome = checked ?? library?.lastCheck?.outcome ?? null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const key = tokenKey.trim();
    if (!targetLibrary || !key) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      onState(await api.saveTokenKey(targetLibrary, key));
      setTokenKey('');
      setLibraryInput('');
      setChecked(null);
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiHttpError
          ? apiErrorMessage(err, tErrors)
          : t('videoProtection.saveKeyError'),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCheck() {
    if (!libraryId) return;
    setChecking(true);
    setSaved(false);
    setError(null);
    try {
      const result = await api.check(libraryId);
      setChecked(result.outcome);
      // El resultado queda guardado en el servidor: refresca el estado general.
      onState(await api.getAdmin());
    } catch (err) {
      setError(
        err instanceof ApiHttpError
          ? apiErrorMessage(err, tErrors)
          : t('videoProtection.checkError'),
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-busy={saving || checking}
      data-testid={`video-protection-library-${libraryId ?? 'new'}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-4"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-text">
          {libraryId
            ? t('videoProtection.libraryName', { id: libraryId })
            : t('videoProtection.newLibraryName')}
        </span>
        {configured ? (
          <Badge variant="outline" className="border-success-200 bg-success-50 text-success-700">
            {t('videoProtection.badgeConfigured')}
          </Badge>
        ) : (
          <Badge variant="outline">{t('videoProtection.badgeNotConfigured')}</Badge>
        )}
        {library ? (
          <Badge variant="outline">
            {library.inUse ? t('videoProtection.badgeInUse') : t('videoProtection.badgeNotInUse')}
          </Badge>
        ) : null}
      </div>

      {libraryId ? null : (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-library`}>{t('videoProtection.libraryIdLabel')}</Label>
          <Input
            id={`${idPrefix}-library`}
            inputMode="numeric"
            pattern="\d+"
            value={libraryInput}
            onChange={(e) => setLibraryInput(e.target.value)}
            placeholder={t('videoProtection.libraryIdPlaceholder')}
          />
        </div>
      )}

      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-key`}>
          {configured ? t('videoProtection.keyLabelReplace') : t('videoProtection.keyLabel')}
        </Label>
        <Input
          id={`${idPrefix}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={tokenKey}
          onChange={(e) => setTokenKey(e.target.value)}
          placeholder={
            configured
              ? t('videoProtection.keyPlaceholderReplace')
              : t('videoProtection.keyPlaceholder')
          }
          className="font-mono"
        />
        <p className="text-xs text-text-subtle">{t('videoProtection.keyHint')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || !tokenKey.trim() || !targetLibrary}>
          {saving ? t('videoProtection.savingKey') : t('videoProtection.saveKey')}
        </Button>
        {libraryId ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!configured || checking}
            onClick={() => void handleCheck()}
          >
            {checking ? t('videoProtection.checking') : t('videoProtection.check')}
          </Button>
        ) : null}
        {saved ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-700"
          >
            <Icon name="check" size={16} />
            {t('videoProtection.keySaved')}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="text-sm font-semibold text-danger-700">
            {error}
          </span>
        ) : null}
      </div>

      {configured || outcome ? (
        <div className="text-sm" data-testid={`video-protection-check-${outcome ?? 'none'}`}>
          {outcome ? (
            <p role="status" className={`font-medium ${checkTone(outcome)}`}>
              {t(`videoProtection.${CHECK_KEYS[outcome]}`)}
            </p>
          ) : (
            <p className="text-text-muted">{t('videoProtection.neverChecked')}</p>
          )}
          {library?.lastCheck ? (
            <p className="mt-1 text-xs text-text-subtle">
              {t('videoProtection.lastCheck', {
                date: formatDateTime(library.lastCheck.checkedAt),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** Interruptor, marca de agua y tope de vídeos distintos por cuenta. */
function SettingsForm({
  api,
  state,
  onState,
}: {
  api: typeof videoProtectionApi;
  state: VideoProtectionState;
  onState: (state: VideoProtectionState) => void;
}) {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [enabled, setEnabled] = useState(state.enabled);
  const [watermark, setWatermark] = useState(state.watermark);
  const [perHour, setPerHour] = useState(String(state.limits.perHour));
  const [perDay, setPerDay] = useState(String(state.limits.perDay));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const maxVideosPerHour = Number(perHour);
    const maxVideosPerDay = Number(perDay);
    if (
      !Number.isInteger(maxVideosPerHour) ||
      !Number.isInteger(maxVideosPerDay) ||
      maxVideosPerHour < 1 ||
      maxVideosPerDay < maxVideosPerHour
    ) {
      setStatus('error');
      setError(t('videoProtection.limitsInvalid'));
      return;
    }
    setStatus('saving');
    setError(null);
    try {
      const next = await api.saveSettings({
        enabled,
        watermark,
        maxVideosPerHour,
        maxVideosPerDay,
      });
      onState(next);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      setStatus('error');
      setError(
        err instanceof ApiHttpError
          ? apiErrorMessage(err, tErrors)
          : t('videoProtection.saveSettingsError'),
      );
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-busy={status === 'saving'}
      data-testid="video-protection-settings"
      className="flex flex-col gap-4 border-t border-border-soft pt-5"
    >
      <h3 className="text-sm font-semibold text-text">{t('videoProtection.settingsTitle')}</h3>

      <div className="flex items-start gap-3">
        <input
          id="video-protection-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          aria-describedby="video-protection-enabled-help"
          className="mt-1 h-4 w-4 cursor-pointer rounded border-border text-brand-600 focus:ring-brand-300"
        />
        <div className="flex-1">
          <Label htmlFor="video-protection-enabled" className="cursor-pointer">
            {t('videoProtection.enabledLabel')}
          </Label>
          <p id="video-protection-enabled-help" className="text-xs text-text-muted">
            {t('videoProtection.enabledHelp')}
          </p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <input
          id="video-protection-watermark"
          type="checkbox"
          checked={watermark}
          onChange={(e) => setWatermark(e.target.checked)}
          aria-describedby="video-protection-watermark-help"
          className="mt-1 h-4 w-4 cursor-pointer rounded border-border text-brand-600 focus:ring-brand-300"
        />
        <div className="flex-1">
          <Label htmlFor="video-protection-watermark" className="cursor-pointer">
            {t('videoProtection.watermarkLabel')}
          </Label>
          <p id="video-protection-watermark-help" className="text-xs text-text-muted">
            {t('videoProtection.watermarkHelp')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex w-48 flex-col gap-1.5">
          <Label htmlFor="video-protection-per-hour">{t('videoProtection.perHourLabel')}</Label>
          <Input
            id="video-protection-per-hour"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            step={1}
            required
            value={perHour}
            onChange={(e) => setPerHour(e.target.value)}
          />
        </div>
        <div className="flex w-48 flex-col gap-1.5">
          <Label htmlFor="video-protection-per-day">{t('videoProtection.perDayLabel')}</Label>
          <Input
            id="video-protection-per-day"
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            step={1}
            required
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-text-subtle">{t('videoProtection.limitsHelp')}</p>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === 'saving'}>
          {status === 'saving'
            ? t('videoProtection.savingSettings')
            : t('videoProtection.saveSettings')}
        </Button>
        {status === 'saved' ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-700"
          >
            <Icon name="check" size={16} />
            {t('videoProtection.settingsSaved')}
          </span>
        ) : null}
        {status === 'error' && error ? (
          <span role="alert" className="text-sm font-semibold text-danger-700">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
