'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · SCIM Provisioning (séptimo piloto License SDK).
 *
 * Reglas:
 *   - El panel completo va envuelto en `<EeGate>` con `LICENSE_CAPABILITIES.SCIM`.
 *     Sin licencia EE se muestra el upsell card (mismo patrón que white-label,
 *     custom-domains y mfa-enforcement).
 *   - El backend GATEA además todos los endpoints (token CRUD + /scim/v2/*) —
 *     esta página solo es UX. Sin la capability cualquier llamada vuelve con
 *     402 vía LicenseExceptionFilter.
 *
 * Flujo end-to-end del admin:
 *   1. Genera token nuevo → modal muestra el token plano UNA SOLA VEZ.
 *   2. Admin lo copia y lo pega en el panel del IdP (Okta, Azure AD, etc.).
 *   3. El IdP empieza a hacer requests a /scim/v2/Users con ese Bearer.
 *   4. Si el admin pierde el token o quiere rotarlo: revocar + crear nuevo.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { scimTokenApi, type ScimTokenCreated, type ScimTokenStatus } from '@/lib/scim';

export default function AdminScimPage() {
  const t = useTranslations('adminApi');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('scim.title')}</h1>
        <p className="text-text-muted">{t('scim.subtitle')}</p>
      </header>

      <EeGate capability={LICENSE_CAPABILITIES.SCIM} fallback={<ScimUpsellCard />}>
        <ScimPanel />
      </EeGate>
    </div>
  );
}

/**
 * Panel principal — solo se renderiza cuando la capability está activa.
 */
function ScimPanel() {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [status, setStatus] = useState<ScimTokenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ScimTokenCreated | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await scimTokenApi.status(token);
        setStatus(fresh);
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('scim.statusLoadError'),
        );
      }
    })();
  }, []);

  async function refresh() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const fresh = await scimTokenApi.status(token);
      setStatus(fresh);
    } catch {
      // El último error ya se muestra; mantenemos estado anterior.
    }
  }

  async function handleCreate() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (status?.active && !window.confirm(t('scim.confirmRotate'))) {
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const created = await scimTokenApi.create(token);
      setRevealed(created);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('scim.createError'),
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('scim.confirmRevoke'))) {
      return;
    }
    setRevoking(true);
    setActionError(null);
    try {
      await scimTokenApi.revoke(token);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('scim.revokeError'),
      );
    } finally {
      setRevoking(false);
    }
  }

  if (status === null && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Estado actual */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="lock" size={18} />
            {t('scim.tokenTitle')}
            <ScimStatusBadge active={status?.active ?? false} />
          </CardTitle>
          <CardDescription>
            {t.rich('scim.tokenDescription', {
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status?.active ? (
            <div className="rounded-lg border border-border-soft bg-surface-2 p-4 text-sm">
              <p>
                {t.rich('scim.tokenActive', {
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                  prefix: status.prefix,
                })}
              </p>
              <p className="text-text-muted">
                {t('scim.tokenMeta', {
                  created: formatDateTime(status.createdAt),
                  hasLastUsed: String(Boolean(status.lastUsedAt)),
                  lastUsed: status.lastUsedAt ? formatDateTime(status.lastUsedAt) : '',
                })}
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t('scim.noToken')}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={handleCreate} disabled={creating}>
              {creating
                ? t('scim.generating')
                : status?.active
                  ? t('scim.rotateToken')
                  : t('scim.generateToken')}
            </Button>
            {status?.active ? (
              <Button type="button" variant="ghost" onClick={handleRevoke} disabled={revoking}>
                {revoking ? t('scim.revoking') : t('scim.revoke')}
              </Button>
            ) : null}
          </div>

          {actionError ? <p className="text-sm text-danger-700">{actionError}</p> : null}
        </CardContent>
      </Card>

      {/* Token revelado (UNA SOLA VEZ) */}
      {revealed ? <RevealedTokenCard reveal={revealed} onClose={() => setRevealed(null)} /> : null}

      {/* URL del endpoint SCIM */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="code" size={18} />
            {t('scim.endpointTitle')}
          </CardTitle>
          <CardDescription>{t('scim.endpointDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
            {typeof window !== 'undefined' ? `${window.location.origin}/scim/v2` : '/scim/v2'}
          </code>
        </CardContent>
      </Card>

      {/* Instrucciones de configuración */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="help" size={18} />
            {t('scim.configureIdpTitle')}
          </CardTitle>
          <CardDescription>{t('scim.configureIdpDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-semibold">{t('scim.step1Title')}</p>
            <p className="text-text-muted">{t('scim.step1Description')}</p>
          </div>
          <div>
            <p className="font-semibold">{t('scim.step2Title')}</p>
            <p className="text-text-muted">
              {t.rich('scim.step2Description', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('scim.step3Title')}</p>
            <p className="text-text-muted">
              {t.rich('scim.step3Description', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('scim.step4Title')}</p>
            <p className="text-text-muted">
              {t.rich('scim.step4Description', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('scim.step5Title')}</p>
            <p className="text-text-muted">
              {t.rich('scim.step5Description', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-warning-800">
            <p className="font-semibold">{t('scim.usersOnlyTitle')}</p>
            <p className="text-xs">
              {t.rich('scim.usersOnlyDescription', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
                usersLink: (chunks) => <a href="/admin/usuarios">{chunks}</a>,
              })}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ScimStatusBadge({ active }: { active: boolean }) {
  const t = useTranslations('adminApi');
  if (active) return <Badge className="bg-success-600 text-white">{t('scim.badgeActive')}</Badge>;
  return <Badge variant="outline">{t('scim.badgeNoToken')}</Badge>;
}

/**
 * Modal-card que muestra el token plano UNA SOLA VEZ. Diseñado para ser
 * intrusivo: el usuario debe pulsar &ldquo;Ya lo copié&rdquo; para hacerlo
 * desaparecer.
 */
function RevealedTokenCard({ reveal, onClose }: { reveal: ScimTokenCreated; onClose: () => void }) {
  const t = useTranslations('adminApi');
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(reveal.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin clipboard API (browser viejo / iframe) → mostramos el token igual,
      // el usuario lo selecciona a mano.
    }
  }

  return (
    <Card
      role="region"
      aria-label={t('scim.revealedAria')}
      className="border-warning-300 bg-warning-50"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-warning-900">
          <Icon name="lock" size={18} />
          {t('scim.revealedTitle')}
        </CardTitle>
        <CardDescription className="text-warning-800">{reveal.warning}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block break-all rounded border border-warning-300 bg-surface px-3 py-2 font-mono text-sm">
          {reveal.token}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={handleCopy}>
            {copied ? t('scim.copied') : t('scim.copyToClipboard')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('scim.copiedClose')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE).
 */
export function ScimUpsellCard() {
  const t = useTranslations('adminApi');
  return (
    <Card role="region" aria-label={t('scim.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('scim.upsellTitle')}
        </CardTitle>
        <CardDescription>{t('scim.upsellDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('scim.upsellCapability', {
            codeChip: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
            ),
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('scim.seePlans')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
