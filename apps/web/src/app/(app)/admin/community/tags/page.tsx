'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ColorField, SUGGESTED_COLORS } from '@/components/color-field';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { authStorage } from '@/lib/auth-storage';
import {
  COMMUNITY_TAG_ICONS,
  communityApi,
  invalidateCommunityTagsCache,
  type CommunityTag,
  type CommunityTagIcon,
} from '@/modules/community';

interface FormState {
  name: string;
  color: string;
  icon: CommunityTagIcon | '';
}

const EMPTY_FORM: FormState = { name: '', color: SUGGESTED_COLORS[0]!, icon: '' };

export default function CommunityTagsAdminPage() {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [tags, setTags] = useState<CommunityTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CommunityTag | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Solo super_admin/tenant_admin pueden gestionar. El backend ya
  // rechaza cualquier acción no autorizada — esta verificación es
  // sólo para mostrar el mensaje correcto en lugar de un 403.
  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    try {
      setTags(await communityApi.listTags());
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startEdit(tag: CommunityTag) {
    setEditing(tag);
    setForm({
      name: tag.name,
      color: tag.color,
      icon: (tag.icon as CommunityTagIcon | null) ?? '',
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        color: form.color,
        icon: form.icon === '' ? null : form.icon,
      };
      if (editing) {
        await communityApi.updateTag(editing.id, payload);
      } else {
        await communityApi.createTag(payload);
      }
      invalidateCommunityTagsCache();
      cancelEdit();
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(tag: CommunityTag) {
    if (!window.confirm(t('tags.deleteConfirm', { name: tag.name }))) return;
    setPending(true);
    setError(null);
    try {
      await communityApi.deleteTag(tag.id);
      invalidateCommunityTagsCache();
      if (editing?.id === tag.id) cancelEdit();
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
        <CardContent className="p-6 text-sm text-danger-700">{t('tags.noAccess')}</CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('tags.title')}</h1>
        <p className="mt-1 max-w-2xl text-text-muted">{t('tags.subtitle')}</p>
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
            <CardTitle>{t('tags.listTitle')}</CardTitle>
            <CardDescription>
              {tags === null
                ? t('tags.loading')
                : tags.length === 0
                  ? t('tags.emptyList')
                  : t('tags.count', { count: tags.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tags === null ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : tags.length === 0 ? null : (
              <ul className="divide-y divide-border-soft">
                {tags.map((tag) => (
                  <li key={tag.id} className="flex items-center gap-3 py-3">
                    <TagPreview tag={tag} />
                    <span className="font-mono text-xs text-text-subtle">{tag.color}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(tag)}
                        disabled={pending}
                      >
                        {t('tags.edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDelete(tag)}
                        disabled={pending}
                        className="text-danger-700 hover:bg-danger-50"
                      >
                        {t('tags.delete')}
                      </Button>
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
              {editing ? t('tags.formEditTitle', { name: editing.name }) : t('tags.formNewTitle')}
            </CardTitle>
            <CardDescription>
              {editing ? t('tags.formEditDescription') : t('tags.formNewDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="tag-name">{t('tags.nameLabel')}</Label>
                <Input
                  id="tag-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  minLength={1}
                  maxLength={40}
                  placeholder={t('tags.namePlaceholder')}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tag-color">{t('tags.colorLabel')}</Label>
                <ColorField
                  id="tag-color"
                  value={form.color}
                  onChange={(color) => setForm((f) => ({ ...f, color }))}
                  swatchAriaLabel={(value) => t('tags.colorAria', { value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tag-icon">{t('tags.iconLabel')}</Label>
                <Select
                  id="tag-icon"
                  value={form.icon}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, icon: e.target.value as FormState['icon'] }))
                  }
                >
                  <option value="">{t('tags.noIcon')}</option>
                  {COMMUNITY_TAG_ICONS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="rounded-md border border-border-soft bg-surface-2 p-3">
                <p className="text-xs text-text-subtle">{t('tags.preview')}</p>
                <div className="mt-2">
                  <TagPreview
                    tag={{
                      id: 'preview',
                      tenantId: '',
                      name: form.name || t('tags.previewFallback'),
                      color: form.color,
                      icon: form.icon || null,
                      createdAt: '',
                      updatedAt: '',
                    }}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                    {t('tags.cancel')}
                  </Button>
                ) : null}
                <Button type="submit" disabled={pending || form.name.trim().length === 0}>
                  {pending ? t('tags.saving') : editing ? t('tags.saveChanges') : t('tags.create')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/**
 * Preview del chip tal cual se renderiza en el feed: fondo con el color
 * a opacidad baja + texto sólido. Si hay icono, va a la izquierda.
 */
function TagPreview({ tag }: { tag: CommunityTag }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        // Mezclar con el color base del surface para que el chip respete
        // el theme (light/dark). 18% de opacidad da contraste razonable
        // sin dominar la card.
        backgroundColor: `${tag.color}2E`,
        color: tag.color,
      }}
    >
      {tag.icon ? <Icon name={tag.icon as IconName} size={14} /> : null}
      {tag.name}
    </span>
  );
}
