'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
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

const SUGGESTED_COLORS = [
  '#1E5AA8',
  '#18B5A8',
  '#2E7DCE',
  '#16A34A',
  '#F59E0B',
  '#FF6F61',
  '#7C3AED',
  '#0D1B2A',
];

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
  const [color, setColor] = useState(SUGGESTED_COLORS[0]!);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLInputElement>(null);

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
      setTimeout(() => titleRef.current?.focus(), 50);
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('newSpaceTitle')}
        className="relative w-full max-w-sm rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
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
              ref={titleRef}
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

          {/* Color */}
          <div className="space-y-1.5">
            <Label>{t('colorLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={t('colorAria', { color: c })}
                  aria-pressed={color === c}
                  className={
                    color === c
                      ? 'h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-surface'
                      : 'h-7 w-7 rounded-full ring-1 ring-border hover:ring-border-strong'
                  }
                  style={{ backgroundColor: c, ['--tw-ring-color' as string]: c }}
                />
              ))}
            </div>
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
