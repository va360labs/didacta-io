'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { SpaceIcon, isIconName } from '@/components/space-icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { authStorage } from '@/lib/auth-storage';
import {
  COMMUNITY_SPACE_ICONS,
  communityApi,
  invalidateCommunitySpacesCache,
  type CommunitySpace,
} from '@/modules/community';

type IconMode = 'icon' | 'emoji';

const SUGGESTED_COLORS = [
  '#1E5AA8',
  '#18B5A8',
  '#0D1B2A',
  '#2E7DCE',
  '#16A34A',
  '#F59E0B',
  '#FF6F61',
  '#7C3AED',
];

interface FormState {
  slug: string;
  title: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: string;
}

const EMPTY_FORM: FormState = {
  slug: '',
  title: '',
  description: '',
  icon: 'hash',
  color: SUGGESTED_COLORS[0]!,
  sortOrder: '0',
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function EspaciosAdminPage() {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [spaces, setSpaces] = useState<CommunitySpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CommunitySpace | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [iconMode, setIconMode] = useState<IconMode>('icon');

  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    try {
      setSpaces(await communityApi.listSpaces());
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startEdit(space: CommunitySpace) {
    setEditing(space);
    setIconMode(isIconName(space.icon) ? 'icon' : 'emoji');
    setForm({
      slug: space.slug,
      title: space.title,
      description: space.description ?? '',
      icon: space.icon,
      color: space.color,
      sortOrder: String(space.sortOrder),
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setIconMode('icon');
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        icon: form.icon,
        color: form.color,
        sortOrder: Number(form.sortOrder) || 0,
      };
      if (editing) {
        await communityApi.updateSpace(editing.slug, payload);
      } else {
        await communityApi.createSpace({ slug: form.slug.trim(), ...payload });
      }
      invalidateCommunitySpacesCache();
      cancelEdit();
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(space: CommunitySpace) {
    if (!window.confirm(t('spaces.deleteConfirm', { name: space.title }))) return;
    setPending(true);
    setError(null);
    try {
      await communityApi.deleteSpace(space.slug);
      invalidateCommunitySpacesCache();
      if (editing?.slug === space.slug) cancelEdit();
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setPending(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">{t('spaces.noAccess')}</CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('spaces.title')}</h1>
        <p className="mt-1 max-w-2xl text-text-muted">{t('spaces.subtitle')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t('spaces.listTitle')}</CardTitle>
            <CardDescription>
              {spaces === null
                ? t('spaces.loading')
                : spaces.length === 0
                  ? t('spaces.emptyList')
                  : t('spaces.count', { count: spaces.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {spaces === null ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-14 w-full" />
                ))}
              </div>
            ) : spaces.length === 0 ? null : (
              <ul className="divide-y divide-border-soft">
                {spaces.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-3">
                    <div
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                      style={{ backgroundColor: `${s.color}22` }}
                    >
                      <SpaceIcon icon={s.icon} color={s.color} size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        {s.title}
                        {s.isSystem ? (
                          <span title={t('spaces.systemTitle')} className="text-text-subtle">
                            🔒
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-text-subtle">
                        /{s.slug} · {t('spaces.orderMeta', { order: s.sortOrder })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(s)}
                        disabled={pending}
                      >
                        {t('spaces.edit')}
                      </Button>
                      {!s.isSystem ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDelete(s)}
                          disabled={pending}
                          className="text-danger-700 hover:bg-danger-50"
                        >
                          {t('spaces.delete')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {editing
                ? t('spaces.formEditTitle', { name: editing.title })
                : t('spaces.formNewTitle')}
            </CardTitle>
            <CardDescription>
              {editing ? t('spaces.formEditDescription') : t('spaces.formNewDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="space-title">{t('spaces.nameLabel')}</Label>
                <Input
                  id="space-title"
                  value={form.title}
                  onChange={(e) => {
                    const title = e.target.value;
                    setForm((f) => ({
                      ...f,
                      title,
                      slug: editing ? f.slug : slugify(title),
                    }));
                  }}
                  required
                  minLength={1}
                  maxLength={60}
                  placeholder={t('spaces.namePlaceholder')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="space-slug">{t('spaces.slugLabel')}</Label>
                <Input
                  id="space-slug"
                  value={form.slug}
                  onChange={(e) =>
                    !editing && setForm((f) => ({ ...f, slug: slugify(e.target.value) }))
                  }
                  readOnly={!!editing}
                  required
                  minLength={1}
                  maxLength={60}
                  placeholder={t('spaces.slugPlaceholder')}
                  className="font-mono"
                />
                {editing ? (
                  <p className="text-xs text-text-subtle">{t('spaces.slugLocked')}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="space-desc">{t('spaces.descLabel')}</Label>
                <Input
                  id="space-desc"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  maxLength={200}
                  placeholder={t('spaces.descPlaceholder')}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('spaces.iconLabel')}</Label>
                  <div className="flex rounded-md border border-border text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setIconMode('icon');
                        setForm((f) => ({ ...f, icon: 'hash' }));
                      }}
                      className={
                        iconMode === 'icon'
                          ? 'rounded-l-md bg-surface-2 px-2.5 py-1 font-medium text-text'
                          : 'rounded-l-md px-2.5 py-1 text-text-muted hover:text-text'
                      }
                    >
                      {t('spaces.iconMode')}
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
                      {t('spaces.emojiMode')}
                    </button>
                  </div>
                </div>

                {iconMode === 'icon' ? (
                  <div className="flex flex-wrap gap-1.5">
                    {COMMUNITY_SPACE_ICONS.map((i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, icon: i }))}
                        aria-label={i}
                        aria-pressed={form.icon === i}
                        className={
                          form.icon === i
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
                      value={form.icon}
                      onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                      placeholder={t('spaces.emojiPlaceholder')}
                      maxLength={4}
                      className="text-lg"
                    />
                    <p className="text-[11px] text-text-subtle">{t('spaces.emojiHint')}</p>
                  </div>
                )}

                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-2"
                  style={{ backgroundColor: `${form.color}18` }}
                >
                  <SpaceIcon icon={form.icon || 'hash'} color={form.color} size={16} />
                  <span className="text-sm font-medium" style={{ color: form.color }}>
                    {form.title || t('spaces.previewFallback')}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('spaces.colorLabel')}</Label>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, color: c }))}
                      aria-label={t('spaces.colorAria', { value: c })}
                      aria-pressed={form.color === c}
                      className={
                        form.color === c
                          ? 'h-8 w-8 rounded-md ring-2 ring-brand-500 ring-offset-2 ring-offset-bg'
                          : 'h-8 w-8 rounded-md ring-1 ring-border'
                      }
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <Input
                  type="text"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  pattern="^#[0-9a-fA-F]{6}$"
                  required
                  placeholder="#1E5AA8"
                  className="font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="space-order">{t('spaces.orderLabel')}</Label>
                <Input
                  id="space-order"
                  type="number"
                  min="0"
                  value={form.sortOrder}
                  onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
                  placeholder="0"
                />
                <p className="text-xs text-text-subtle">{t('spaces.orderHint')}</p>
              </div>

              <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                    {t('spaces.cancel')}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    form.title.trim().length === 0 ||
                    (!editing && form.slug.trim().length === 0)
                  }
                >
                  {pending
                    ? t('spaces.saving')
                    : editing
                      ? t('spaces.saveChanges')
                      : t('spaces.create')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
