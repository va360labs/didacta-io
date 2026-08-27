'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useFocusTrap } from '@/lib/use-focus-trap';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ColorField, SUGGESTED_COLORS } from '@/components/color-field';
import { Icon, type IconName } from '@/components/icon';
import { SpaceIcon } from '@/components/space-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  communityApi,
  invalidateCommunitySpacesCache,
  COMMUNITY_SPACE_ICONS,
} from '@/modules/community';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

type IconMode = 'icon' | 'emoji';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CreateSpaceModal({ open, onClose }: Props) {
  const t = useTranslations('comunidadComponentes');
  const tErrors = useTranslations('errors');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [iconMode, setIconMode] = useState<IconMode>('icon');
  const [selectedIcon, setSelectedIcon] = useState<string>('hash');
  const [emojiValue, setEmojiValue] = useState('');
  const [color, setColor] = useState<string>(SUGGESTED_COLORS[0]!);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emojiRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Foco dentro al abrir, atrapado, y devuelto al disparador al cerrar (LMS-122).
  useFocusTrap(panelRef, open);

  const currentIcon = iconMode === 'emoji' ? emojiValue || '✦' : selectedIcon;

  useEffect(() => {
    if (open) {
      setTitle('');
      setSlug('');
      setIconMode('icon');
      setSelectedIcon('hash');
      setEmojiValue('');
      setColor(SUGGESTED_COLORS[0]!);
      setError(null);
      setPending(false);
      // El foco inicial lo pone `useFocusTrap` sobre `[data-autofocus]`.
    }
  }, [open]);

  useEffect(() => {
    if (iconMode === 'emoji') setTimeout(() => emojiRef.current?.focus(), 50);
  }, [iconMode]);

  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !slug.trim()) return;
    const icon = iconMode === 'emoji' ? emojiValue.trim() || 'hash' : selectedIcon;
    setPending(true);
    setError(null);
    try {
      await communityApi.createSpace({
        slug: slug.trim(),
        title: title.trim(),
        icon,
        color,
        sortOrder: 99,
      });
      invalidateCommunitySpacesCache();
      window.dispatchEvent(new Event('didacta:spaces-changed'));
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setPending(false);
    }
  }

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Ver `ui/dialog.tsx`: el fondo es un <button> para que la zona de cierre
          esté anunciada y etiquetada, no un <div> mudo que solo entiende el ratón. */}
      <button
        type="button"
        aria-label={t('cancel')}
        onClick={onClose}
        className="fixed inset-0 -z-10 cursor-default bg-black/50"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t('newSpaceTitle')}
        className="relative w-full max-w-sm rounded-xl border border-border bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="border-b border-border-soft px-5 py-4">
          <h2 className="text-base font-semibold text-text">{t('newSpaceTitle')}</h2>
          <p className="mt-0.5 text-xs text-text-muted">{t('newSpaceSubtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-2.5 text-xs text-danger-700"
            >
              {error}
            </div>
          ) : null}

          {/* Nombre */}
          <div className="space-y-1.5">
            <Label htmlFor="cs-title">{t('nameLabel')}</Label>
            <Input
              data-autofocus
              id="cs-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setSlug(slugify(e.target.value));
              }}
              required
              maxLength={60}
              placeholder={t('namePlaceholder')}
            />
            {slug ? <p className="font-mono text-[11px] text-text-subtle">/{slug}</p> : null}
          </div>

          {/* Icono — toggle icono / emoji */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('iconLabel')}</Label>
              <div className="flex rounded-md border border-border text-xs">
                <button
                  type="button"
                  onClick={() => setIconMode('icon')}
                  className={
                    iconMode === 'icon'
                      ? 'rounded-l-md bg-surface-2 px-2.5 py-1 font-medium text-text'
                      : 'rounded-l-md px-2.5 py-1 text-text-muted hover:text-text'
                  }
                >
                  {t('iconLabel')}
                </button>
                <button
                  type="button"
                  onClick={() => setIconMode('emoji')}
                  className={
                    iconMode === 'emoji'
                      ? 'rounded-r-md bg-surface-2 px-2.5 py-1 font-medium text-text'
                      : 'rounded-r-md px-2.5 py-1 text-text-muted hover:text-text'
                  }
                >
                  {t('emojiTitle')}
                </button>
              </div>
            </div>

            {iconMode === 'icon' ? (
              <div className="flex flex-wrap gap-1.5">
                {COMMUNITY_SPACE_ICONS.map((i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedIcon(i)}
                    aria-label={i}
                    aria-pressed={selectedIcon === i}
                    className={
                      selectedIcon === i
                        ? 'grid h-8 w-8 place-items-center rounded-lg border-2 border-brand-500 bg-brand-50 text-brand-700'
                        : 'grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface-2 text-text-muted hover:border-border-strong hover:text-text'
                    }
                  >
                    <Icon name={i as IconName} size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Input
                  ref={emojiRef}
                  value={emojiValue}
                  onChange={(e) => setEmojiValue(e.target.value)}
                  placeholder={t('emojiPlaceholder')}
                  maxLength={4}
                  className="text-lg"
                />
                <p className="text-[11px] text-text-subtle">{t('emojiHint')}</p>
              </div>
            )}
          </div>

          {/* Color: mismas muestras que el resto de la app y, desde el lote de
              feedback de onboarding, también el input hex que aquí faltaba. */}
          <div className="space-y-1.5">
            <Label htmlFor="create-space-color">{t('colorLabel')}</Label>
            <ColorField
              id="create-space-color"
              value={color}
              onChange={setColor}
              swatchAriaLabel={(c) => t('colorAria', { color: c })}
            />
          </div>

          {/* Preview */}
          <div
            className="flex items-center gap-2.5 rounded-lg px-3 py-2"
            style={{ backgroundColor: `${color}18` }}
          >
            <SpaceIcon icon={currentIcon} color={color} size={16} />
            <span className="text-sm font-medium" style={{ color }}>
              {title || t('spaceNameFallback')}
            </span>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || !slug.trim()}>
              {pending ? t('creating') : t('createSpace')}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
