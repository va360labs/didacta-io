'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { SocialIcon } from '@/components/social-icon';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  MAX_SOCIAL_LINKS,
  detectSocialKind,
  socialLinkName,
  socialLinkProblem,
  type SocialLink,
} from '@/lib/social-links';
import { publishThemeUpdate, themingApi, type TenantTheme } from '@/lib/theming';

/**
 * Cómo se presenta la academia en su comunidad (la tarjeta de /community, como
 * el «About» de un grupo de Skool): portada, descripción y enlaces sociales.
 *
 * Lo pintan los Ajustes del modo sencillo y la Marca del modo completo, así que
 * vive aquí una sola vez. La portada se sube al momento (como el logo); la
 * descripción y los enlaces se guardan con el botón de la pantalla que los usa.
 */

/** Mismo tope que la columna y el DTO de mod.theming. */
export const MAX_ABOUT_CHARS = 280;
/** Los mismos tipos y tope que `uploadCoverSchema` en la API. */
const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_COVER_BYTES = 10 * 1024 * 1024;

async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(file);
  });
}

// ── Portada ──────────────────────────────────────────────────────────────────

export function CoverField({
  theme,
  onTheme,
}: {
  theme: TenantTheme | null;
  onTheme: (theme: TenantTheme) => void;
}) {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const coverUrl = theme?.coverUrl ?? null;

  async function upload(file: File) {
    setError(null);
    if (!COVER_TYPES.includes(file.type)) return setError(t('academyProfile.coverErrorType'));
    if (file.size > MAX_COVER_BYTES) {
      return setError(t('academyProfile.coverErrorSize', { mb: (file.size / 1048576).toFixed(1) }));
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy('upload');
    try {
      const updated = await themingApi.uploadCover(token, {
        data: await toBase64(file),
        filename: file.name,
        contentType: file.type,
      });
      onTheme(updated);
      publishThemeUpdate(updated);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('academyProfile.coverError'),
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setError(null);
    setBusy('remove');
    try {
      const updated = await themingApi.removeCover(token);
      onTheme(updated);
      publishThemeUpdate(updated);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('academyProfile.coverError'),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" data-testid="academy-cover-field">
      <p className="text-sm font-semibold text-text">{t('academyProfile.coverLabel')}</p>
      <input
        ref={inputRef}
        type="file"
        accept={COVER_TYPES.join(',')}
        className="sr-only"
        data-testid="academy-cover-input"
        aria-label={t('academyProfile.coverLabel')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          // Permite volver a elegir el mismo fichero tras un error.
          e.target.value = '';
        }}
      />
      {coverUrl ? (
        // Al tamaño de la tarjeta de la comunidad (y en su proporción): a todo
        // el ancho del formulario la foto se comía la pantalla.
        <div className="max-w-sm overflow-hidden rounded-xl border border-border bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverUrl}
            alt={t('academyProfile.coverAlt')}
            className="block aspect-[2/1] w-full object-cover"
            data-testid="academy-cover-preview"
          />
          <div className="flex flex-wrap items-center justify-end gap-2 p-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => inputRef.current?.click()}
            >
              {busy === 'upload'
                ? t('academyProfile.coverUploading')
                : t('academyProfile.coverChange')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void remove()}
              data-testid="academy-cover-remove"
            >
              {busy === 'remove'
                ? t('academyProfile.coverRemoving')
                : t('academyProfile.coverRemove')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-2 px-6 py-7 text-center transition-colors hover:border-brand-300 hover:bg-brand-50/50"
        >
          <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-100 text-brand-700">
            <Icon name={busy === 'upload' ? 'clock' : 'image'} size={20} />
          </span>
          <span className="text-sm font-medium text-text">
            {busy === 'upload'
              ? t('academyProfile.coverUploading')
              : t('academyProfile.coverUpload')}
          </span>
          <span className="text-xs text-text-subtle">{t('academyProfile.coverFormats')}</span>
        </button>
      )}
      <p className="text-xs text-text-subtle">{t('academyProfile.coverHelp')}</p>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-700">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ── Descripción ──────────────────────────────────────────────────────────────

export function AboutField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('adminMarca');
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-text">
        {t('academyProfile.aboutLabel')}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_ABOUT_CHARS}
        rows={3}
        placeholder={t('academyProfile.aboutPlaceholder')}
        data-testid="academy-about-input"
        className="w-full resize-y rounded-xl border border-border bg-surface px-4 py-3 text-[15px] leading-snug text-text outline-none placeholder:text-text-subtle focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
      />
      <div className="flex items-start justify-between gap-3 text-xs text-text-subtle">
        <p>{t('academyProfile.aboutHelp')}</p>
        <span className="shrink-0 tabular-nums" aria-hidden="true">
          {value.length}/{MAX_ABOUT_CHARS}
        </span>
      </div>
    </div>
  );
}

// ── Enlaces ──────────────────────────────────────────────────────────────────

/** Un enlace mientras se edita: el texto tal cual, y si ya se ha tocado. */
export interface LinkDraft {
  key: string;
  url: string;
  touched: boolean;
}

const LINK_ERROR = {
  https: 'academyProfile.linkError.https',
  credentials: 'academyProfile.linkError.credentials',
  host: 'academyProfile.linkError.host',
  length: 'academyProfile.linkError.length',
} as const;

let draftSeq = 0;
function newDraft(url = ''): LinkDraft {
  draftSeq += 1;
  return { key: `link-${draftSeq}`, url, touched: url !== '' };
}

export function draftsFromLinks(links: readonly SocialLink[]): LinkDraft[] {
  return links.map((l) => newDraft(l.url));
}

/**
 * Lo que se guarda: los enlaces con su red detectada, sin las filas vacías.
 * `invalid` = hay alguno que la API rechazaría (no se guarda nada).
 */
export function linksFromDrafts(drafts: readonly LinkDraft[]): {
  links: SocialLink[];
  invalid: boolean;
} {
  const links: SocialLink[] = [];
  let invalid = false;
  for (const d of drafts) {
    const url = d.url.trim();
    if (!url) continue;
    const kind = detectSocialKind(url);
    if (socialLinkProblem(kind, url) !== null) invalid = true;
    links.push({ kind, url });
  }
  return { links, invalid };
}

export function SocialLinksField({
  drafts,
  onChange,
  showErrors,
}: {
  drafts: LinkDraft[];
  onChange: (drafts: LinkDraft[]) => void;
  /** Tras intentar guardar: se marcan también los que no se han tocado. */
  showErrors: boolean;
}) {
  const t = useTranslations('adminMarca');
  const labelId = useId();

  function set(key: string, patch: Partial<LinkDraft>) {
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  return (
    <div className="space-y-2" data-testid="academy-links-field">
      <p id={labelId} className="text-sm font-semibold text-text">
        {t('academyProfile.linksLabel')}
      </p>
      <p className="text-xs text-text-subtle">{t('academyProfile.linksHelp')}</p>
      {drafts.length > 0 ? (
        <ul className="space-y-2" aria-labelledby={labelId}>
          {drafts.map((d, i) => {
            const url = d.url.trim();
            const kind = detectSocialKind(url);
            const problem = url ? socialLinkProblem(kind, url) : null;
            const showProblem = problem !== null && (d.touched || showErrors);
            const errorId = `${d.key}-error`;
            return (
              <li key={d.key}>
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-text-muted"
                    title={url ? socialLinkName(kind, url, t('academyProfile.linkWeb')) : undefined}
                    data-testid="academy-link-kind"
                    data-kind={url ? kind : undefined}
                  >
                    <SocialIcon kind={kind} size={20} />
                  </span>
                  <input
                    type="url"
                    inputMode="url"
                    value={d.url}
                    placeholder="https://"
                    maxLength={500}
                    aria-label={t('academyProfile.linkAria', { n: i + 1 })}
                    aria-invalid={showProblem}
                    aria-describedby={showProblem ? errorId : undefined}
                    data-testid="academy-link-input"
                    onChange={(e) => set(d.key, { url: e.target.value })}
                    onBlur={() => set(d.key, { touched: true })}
                    className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-[15px] text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100 aria-[invalid=true]:border-danger-600"
                  />
                  <button
                    type="button"
                    onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                    aria-label={t('academyProfile.linkRemove', { n: i + 1 })}
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-text-muted hover:bg-bg-subtle hover:text-text"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>
                {showProblem ? (
                  <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-danger-700">
                    {t(LINK_ERROR[problem])}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {drafts.length < MAX_SOCIAL_LINKS ? (
        <button
          type="button"
          onClick={() => onChange([...drafts, newDraft()])}
          data-testid="academy-link-add"
          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-sm font-semibold text-text hover:border-border-strong"
        >
          <Icon name="plus" size={16} />
          {t('academyProfile.linkAdd')}
        </button>
      ) : (
        <p className="text-xs text-text-subtle">
          {t('academyProfile.linksMax', { max: MAX_SOCIAL_LINKS })}
        </p>
      )}
    </div>
  );
}
