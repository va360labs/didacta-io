'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Tab "Aula virtual" de /admin/configuracion: formulario de credenciales Zoom
/// Server-to-Server del módulo mod.zoom-live.
///
/// mod.zoom-live es un módulo BUILT-IN (no se instala por ZIP del marketplace),
/// así que su UI vive aquí, en apps/web, compilada en el host — NO en un surface
/// bundle cargado por `loadModuleUI` (ese mecanismo solo sirve módulos instalados
/// por ZIP; para un built-in devuelve 404 "no está instalado"). Patrón correcto,
/// igual que el resto de módulos core in-tree (community, payment-connections…).

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { zoomLiveApi } from './client';

type TestStatus =
  | 'idle'
  | 'testing'
  | { kind: 'real' | 'stub'; accountId: string }
  | { error: string };

export function ZoomAdminSurface() {
  const t = useTranslations('modZoomLive');
  const tErrors = useTranslations('errors');
  const [draft, setDraft] = useState({
    accountId: '',
    clientId: '',
    clientSecret: '',
    webhookSecret: '',
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('saving');
    setErrMsg(null);
    try {
      await zoomLiveApi.upsertCredentials({
        accountId: draft.accountId.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
        // Siempre se manda (aunque vacío): el merge del backend conserva el
        // guardado previo cuando llega vacío, igual que clientSecret. Si se
        // omitiera la clave por completo del body, el merge no tendría nada
        // que preservar.
        webhookSecret: draft.webhookSecret,
      });
      setStatus('saved');
      setDraft((s) => ({ ...s, clientSecret: '', webhookSecret: '' }));
    } catch (e) {
      setStatus('error');
      setErrMsg(apiErrorMessage(e, tErrors));
    }
  }

  async function handleClear() {
    if (!confirm(t('admin.clearConfirm'))) return;
    setStatus('saving');
    setErrMsg(null);
    try {
      await zoomLiveApi.removeCredentials();
      setStatus('saved');
      setDraft({ accountId: '', clientId: '', clientSecret: '', webhookSecret: '' });
    } catch (e) {
      setStatus('error');
      setErrMsg(apiErrorMessage(e, tErrors));
    }
  }

  async function handleTest() {
    setTestStatus('testing');
    try {
      const res = await zoomLiveApi.testCredentials();
      setTestStatus(res);
    } catch (e) {
      setTestStatus({ error: apiErrorMessage(e, tErrors) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.title')}</CardTitle>
        <CardDescription>{t('admin.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="zoom-account">{t('admin.accountId')}</Label>
            <Input
              id="zoom-account"
              required
              value={draft.accountId}
              onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zoom-client">{t('admin.clientId')}</Label>
            <Input
              id="zoom-client"
              required
              value={draft.clientId}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zoom-secret">{t('admin.clientSecret')}</Label>
            <Input
              id="zoom-secret"
              required
              type="password"
              value={draft.clientSecret}
              onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="zoom-webhook-secret">{t('admin.webhookSecret')}</Label>
            <Input
              id="zoom-webhook-secret"
              type="password"
              value={draft.webhookSecret}
              onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })}
              autoComplete="new-password"
              placeholder={t('admin.webhookSecretPlaceholder')}
            />
            <p className="text-xs text-text-subtle">
              {t.rich('admin.webhookSecretHint', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? t('admin.saving') : t('admin.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleTest}
              disabled={testStatus === 'testing'}
            >
              {testStatus === 'testing' ? t('admin.testing') : t('admin.test')}
            </Button>
            <Button type="button" variant="ghost" onClick={handleClear}>
              {t('admin.clear')}
            </Button>
            {status === 'saved' ? (
              <span className="text-sm text-success-700">{t('admin.saved')}</span>
            ) : null}
            {status === 'error' && errMsg ? (
              <span className="text-sm text-danger-700">{errMsg}</span>
            ) : null}
          </div>
          {typeof testStatus === 'object' && 'kind' in testStatus ? (
            <div className="sm:col-span-2 rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
              {testStatus.kind === 'real'
                ? t('admin.testOk', { accountId: testStatus.accountId })
                : t('admin.testStub')}
            </div>
          ) : null}
          {typeof testStatus === 'object' && 'error' in testStatus ? (
            <div className="sm:col-span-2 rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700">
              {t('admin.testError', { message: testStatus.error })}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
