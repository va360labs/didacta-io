'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Admin · Claves API.
 *
 * Dos pestañas: las claves en sí y la documentación EN VIVO para integradores
 * (antes `/admin/integraciones/api`, una página huérfana del menú a la que solo
 * se llegaba por un enlace enterrado en esta misma cabecera).
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ApiDocsTab } from '@/components/admin/api-docs-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminApiKeysApi,
  API_KEY_SCOPES,
  type CreatedApiKey,
  type TenantApiKey,
} from '@/lib/admin-api-keys';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';

function fmtDate(value: string | null): string {
  if (!value) return '—';
  return formatDateTime(value, { dateStyle: 'medium', timeStyle: 'short' });
}

const TABS = ['claves', 'docs'] as const;
type TabKey = (typeof TABS)[number];

export default function ApiKeysPage() {
  const t = useTranslations('adminApi');
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'claves';

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('keys.title')}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t.rich('keys.subtitle', {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          router.replace(next === 'claves' ? '/admin/api-keys' : `/admin/api-keys?tab=${next}`)
        }
      >
        <TabsList>
          <TabsTrigger value="claves">{t('keys.tabKeys')}</TabsTrigger>
          <TabsTrigger value="docs">{t('keys.tabDocs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="claves" className="mt-5">
          <KeysTab />
        </TabsContent>
        <TabsContent value="docs" className="mt-5">
          <ApiDocsTab />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function KeysTab() {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [keys, setKeys] = useState<TenantApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [pending, setPending] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  function scopeLabel(scope: string): string {
    switch (scope) {
      case 'enrollments:write':
        return t('keys.scopeEnrollmentsWrite');
      case 'enrollments:read':
        return t('keys.scopeEnrollmentsRead');
      case 'courses:read':
        return t('keys.scopeCoursesRead');
      case 'community:post':
        return t('keys.scopeCommunityPost');
      case 'orders:write':
        return t('keys.scopeOrdersWrite');
      case 'orders:read':
        return t('keys.scopeOrdersRead');
      default:
        return scope;
    }
  }

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const list = await adminApiKeysApi.list(token);
      setKeys(list);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('keys.loadError'));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    const token = authStorage.getAccessToken();
    if (!token || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const created = await adminApiKeysApi.create(token, {
        name: name.trim(),
        // La integración externa necesita ambos: inscribir/dar de baja y listar
        // cursos para mapear su producto → curso.
        scopes: [...API_KEY_SCOPES],
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      setCreatedKey(created);
      setName('');
      setExpiresAt('');
      setCreating(false);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('keys.createError'));
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('keys.confirmRevoke'))) return;
    setError(null);
    try {
      await adminApiKeysApi.revoke(token, id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('keys.revokeError'));
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">
          {t.rich('keys.contractNote', {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        {!creating ? (
          <Button onClick={() => setCreating(true)}>{t('keys.createKey')}</Button>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {createdKey ? (
        <Card className="border-success-200">
          <CardHeader>
            <CardTitle className="text-base">
              {t('keys.keyCreated', { name: createdKey.name })}
            </CardTitle>
            <CardDescription>{t('keys.copyNow')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={createdKey.token}
                readOnly
                className="flex-1 font-mono text-xs"
                aria-label={t('keys.tokenAria')}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(createdKey.token);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? t('keys.copied') : t('keys.copy')}
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreatedKey(null)}>
              {t('keys.savedIt')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('keys.newKeyTitle')}</CardTitle>
            <CardDescription>
              {t('keys.grantedScopes')}{' '}
              {API_KEY_SCOPES.map((s, i) => (
                <span key={s}>
                  {i > 0 ? ' · ' : ''}
                  <strong>{scopeLabel(s)}</strong>
                </span>
              ))}
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">
                {t('keys.nameLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder={t('keys.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-expires">{t('keys.expiresLabel')}</Label>
              <Input
                id="key-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 border-t border-border-soft pt-4">
              <Button onClick={handleCreate} disabled={pending || !name.trim()}>
                {pending ? t('keys.creating') : t('keys.createKey')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setName('');
                  setExpiresAt('');
                }}
                disabled={pending}
              >
                {t('keys.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {keys === null ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : keys.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">{t('keys.emptyKeys')}</p>
          ) : (
            <div className="divide-y divide-border-soft">
              {keys.map((k) => {
                const revoked = Boolean(k.revokedAt);
                const expired = k.expiresAt ? new Date(k.expiresAt).getTime() < Date.now() : false;
                return (
                  <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text">{k.name}</span>
                        {revoked ? (
                          <Badge variant="danger">{t('keys.badgeRevoked')}</Badge>
                        ) : expired ? (
                          <Badge variant="warning">{t('keys.badgeExpired')}</Badge>
                        ) : (
                          <Badge variant="success">{t('keys.badgeActive')}</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-subtle">
                        {k.scopes.map((s) => scopeLabel(s)).join(', ')}
                      </p>
                      <p className="mt-0.5 text-xs text-text-subtle">
                        {t('keys.keyMeta', {
                          created: fmtDate(k.createdAt),
                          hasCreator: String(Boolean(k.createdByEmail)),
                          creator: k.createdByEmail ?? '',
                          lastUsed: fmtDate(k.lastUsedAt),
                          hasExpiry: String(Boolean(k.expiresAt)),
                          expires: k.expiresAt ? fmtDate(k.expiresAt) : '',
                        })}
                      </p>
                    </div>
                    {!revoked ? (
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(k.id)}>
                        {t('keys.revoke')}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
