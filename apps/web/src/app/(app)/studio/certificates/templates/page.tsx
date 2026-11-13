'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  certificateTemplatesApi,
  type CertificateTemplate,
  type CertificateTemplateInput,
} from '@/modules/certificates';

export default function CertificateTemplatesPage() {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const emptyDraft: CertificateTemplateInput = {
    name: '',
    body: t('certTemplates.defaultBody'),
    primaryColor: '#0f172a',
    logoUrl: '',
    signerName: '',
    signerTitle: '',
    isDefault: false,
  };
  const [items, setItems] = useState<CertificateTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CertificateTemplate | null>(null);
  const [draft, setDraft] = useState<CertificateTemplateInput>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    try {
      setItems(await certificateTemplatesApi.list());
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('certTemplates.loadError'),
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startCreate() {
    setEditing(null);
    setDraft(emptyDraft);
    setShowForm(true);
  }

  function startEdit(tpl: CertificateTemplate) {
    setEditing(tpl);
    setDraft({
      name: tpl.name,
      body: tpl.body,
      primaryColor: tpl.primaryColor,
      logoUrl: tpl.logoUrl ?? '',
      signerName: tpl.signerName ?? '',
      signerTitle: tpl.signerTitle ?? '',
      isDefault: tpl.isDefault,
    });
    setShowForm(true);
  }

  function cancel() {
    setShowForm(false);
    setEditing(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: CertificateTemplateInput = {
        ...draft,
        logoUrl: draft.logoUrl ? draft.logoUrl : null,
        signerName: draft.signerName || null,
        signerTitle: draft.signerTitle || null,
      };
      if (editing) {
        await certificateTemplatesApi.update(editing.id, payload);
      } else {
        await certificateTemplatesApi.create(payload);
      }
      setShowForm(false);
      setEditing(null);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('certTemplates.saveError'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDefault(tpl: CertificateTemplate) {
    setBusy(true);
    try {
      await certificateTemplatesApi.setDefault(tpl.id);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? apiErrorMessage(e, tErrors)
          : t('certTemplates.setDefaultError'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    setBusy(true);
    setError(null);
    try {
      const payload: CertificateTemplateInput = {
        ...draft,
        logoUrl: draft.logoUrl ? draft.logoUrl : null,
        signerName: draft.signerName || null,
        signerTitle: draft.signerTitle || null,
      };
      const blob = await certificateTemplatesApi.preview(payload);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('certTemplates.previewError'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(tpl: CertificateTemplate) {
    if (!confirm(t('certTemplates.confirmDelete', { name: tpl.name }))) return;
    setBusy(true);
    try {
      await certificateTemplatesApi.remove(tpl.id);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('certTemplates.deleteError'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {t('certTemplates.title')}
          </h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            {t.rich('certTemplates.intro', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </div>
        <Button type="button" onClick={startCreate} disabled={showForm}>
          <Icon name="plus" size={16} />
          {t('certTemplates.newTemplate')}
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {editing ? t('certTemplates.editTemplate') : t('certTemplates.newTemplate')}
            </CardTitle>
            <CardDescription>
              {t('certTemplates.variablesIntro')}{' '}
              <code className="font-mono text-xs">{'{{alumno}}'}</code>,{' '}
              <code className="font-mono text-xs">{'{{curso}}'}</code>,{' '}
              <code className="font-mono text-xs">{'{{fecha}}'}</code>,{' '}
              <code className="font-mono text-xs">{'{{numero}}'}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-name">{t('certTemplates.nameLabel')}</Label>
                <Input
                  id="tpl-name"
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t('certTemplates.namePlaceholder')}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-body">{t('certTemplates.bodyLabel')}</Label>
                <Textarea
                  id="tpl-body"
                  required
                  rows={4}
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-color">{t('certTemplates.colorLabel')}</Label>
                <Input
                  id="tpl-color"
                  required
                  pattern="^#[0-9a-fA-F]{6}$"
                  value={draft.primaryColor ?? '#0f172a'}
                  onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })}
                  placeholder="#0f172a"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-logo">{t('certTemplates.logoLabel')}</Label>
                <Input
                  id="tpl-logo"
                  type="url"
                  value={draft.logoUrl ?? ''}
                  onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-signer">{t('certTemplates.signerNameLabel')}</Label>
                <Input
                  id="tpl-signer"
                  value={draft.signerName ?? ''}
                  onChange={(e) => setDraft({ ...draft, signerName: e.target.value })}
                  placeholder={t('certTemplates.signerNamePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-signer-title">{t('certTemplates.signerTitleLabel')}</Label>
                <Input
                  id="tpl-signer-title"
                  value={draft.signerTitle ?? ''}
                  onChange={(e) => setDraft({ ...draft, signerTitle: e.target.value })}
                  placeholder={t('certTemplates.signerTitlePlaceholder')}
                />
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={draft.isDefault ?? false}
                  onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                />
                {t('certTemplates.markDefaultLabel')}
              </label>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy}>
                  {busy
                    ? t('certTemplates.saving')
                    : editing
                      ? t('certTemplates.saveChanges')
                      : t('certTemplates.createTemplate')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handlePreview}
                  disabled={busy || !draft.name || !draft.body}
                >
                  {t('certTemplates.previewPdf')}
                </Button>
                <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
                  {t('certTemplates.cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {items === null ? (
        <div className="space-y-2">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="award" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">{t('certTemplates.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">
              {t.rich('certTemplates.emptyHint', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <Button type="button" onClick={startCreate} className="mt-2">
              <Icon name="plus" size={16} />
              {t('certTemplates.createFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((tpl) => (
            <Card key={tpl.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-4">
                <span
                  aria-hidden="true"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl text-white"
                  style={{ background: tpl.primaryColor }}
                >
                  <Icon name="award" size={22} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-semibold leading-tight text-text">
                      {tpl.name}
                    </h3>
                    {tpl.isDefault ? (
                      <Badge variant="success" dot>
                        {t('certTemplates.defaultBadge')}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 text-sm text-text-muted">{tpl.body}</p>
                  <p className="flex flex-wrap items-center gap-1 text-xs text-text-subtle">
                    <span className="font-mono">{tpl.primaryColor}</span>
                    {tpl.signerName ? (
                      <span>{t('certTemplates.signedBy', { name: tpl.signerName })}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {!tpl.isDefault ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleSetDefault(tpl)}
                      disabled={busy}
                      size="sm"
                    >
                      {t('certTemplates.markDefault')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => startEdit(tpl)}
                    disabled={busy}
                    size="sm"
                  >
                    <Icon name="edit" size={13} />
                    {t('certTemplates.edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(tpl)}
                    disabled={busy || tpl.isDefault}
                    title={tpl.isDefault ? t('certTemplates.cantDeleteDefault') : undefined}
                  >
                    <Icon name="trash" size={13} />
                    {t('certTemplates.delete')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
