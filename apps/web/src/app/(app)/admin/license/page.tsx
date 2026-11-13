'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Licencia (B1 de `work/migracion-env-a-panel.md`).
 *
 * super_admin-only (enforced por el backend — `LicenseAdminController`). Si
 * `DIDACTA_LICENSE_KEY` está fijada por env, el formulario de activación no
 * se muestra: el env gana siempre (§1 del documento), y aquí solo se ve el
 * estado con el badge "definido por el operador".
 *
 * No hay servidor de licencias en este flujo (eso es el "motor" de
 * `work/motor-licencias-propuesta.md`, decisión de producto aparte): la
 * verificación es 100% local con las claves públicas embebidas en el SDK.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { adminLicenseApi, type AdminLicenseStatusDto } from '@/lib/admin-license';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';

interface ToastState {
  variant: 'success' | 'error';
  message: string;
}

export default function AdminLicenciaPage() {
  const t = useTranslations('adminMonetizacion.license');
  const tLicStatus = useTranslations('adminMonetizacion.licenseStatus');
  const tErrors = useTranslations('errors');
  const [status, setStatus] = useState<AdminLicenseStatusDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminLicenseApi.get();
      setStatus(data);
    } catch (err) {
      setLoadError(apiErrorMessage(err, tErrors));
    }
  }, [tErrors]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setToast(null);
    if (!keyInput.trim()) {
      setToast({ variant: 'error', message: t('pasteKey') });
      return;
    }
    setSaving(true);
    try {
      const updated = await adminLicenseApi.setKey(keyInput.trim());
      setStatus(updated);
      setKeyInput('');
      setToast({
        variant: 'success',
        message: t('activated', { status: tLicStatus(updated.status) }),
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message: apiErrorMessage(err, tErrors),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      const updated = await adminLicenseApi.refresh();
      setStatus(updated);
    } catch (err) {
      setToast({
        variant: 'error',
        message: apiErrorMessage(err, tErrors),
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      const updated = await adminLicenseApi.clearKey();
      setStatus(updated);
      setToast({ variant: 'success', message: t('removed') });
      setDeleteDialogOpen(false);
    } catch (err) {
      setToast({
        variant: 'error',
        message: apiErrorMessage(err, tErrors),
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-text-muted">{t('intro')}</p>
      </header>

      {loadError ? (
        <Card>
          <CardContent className="p-6 text-sm text-danger-700">{loadError}</CardContent>
        </Card>
      ) : status === null ? (
        <div className="skeleton h-40 w-full" />
      ) : (
        <>
          <StatusCard
            status={status}
            onRefresh={() => void handleRefresh()}
            refreshing={refreshing}
          />

          <Card>
            <CardHeader>
              <CardTitle>
                {status.hasKeyConfigured ? t('changeKeyTitle') : t('activateTitle')}
              </CardTitle>
              <CardDescription>
                {status.managedByEnv ? t('managedByEnvDescription') : t('pasteJwtDescription')}
              </CardDescription>
            </CardHeader>
            {status.managedByEnv ? null : (
              <CardContent className="space-y-4">
                <form onSubmit={handleSubmit} aria-busy={saving} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="license-key">{t('keyLabel')}</Label>
                    <Textarea
                      id="license-key"
                      rows={4}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="eyJhbGciOiJFUzI1NiIs..."
                      className="font-mono text-xs"
                    />
                  </div>

                  {toast ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className={
                        'rounded-md border p-3 text-sm ' +
                        (toast.variant === 'success'
                          ? 'border-success-200 bg-success-50 text-success-700'
                          : 'border-danger-100 bg-danger-50 text-danger-700')
                      }
                      data-testid="license-toast"
                    >
                      {toast.message}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-4">
                    <Button type="submit" disabled={saving}>
                      {saving
                        ? t('activating')
                        : status.hasKeyConfigured
                          ? t('saveNewKey')
                          : t('activate')}
                    </Button>
                    {status.hasKeyConfigured ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setDeleteDialogOpen(true)}
                        className="text-danger-700 hover:bg-danger-50"
                      >
                        {t('removeKey')}
                      </Button>
                    ) : null}
                  </div>
                </form>
              </CardContent>
            )}
          </Card>

          {status.capabilities.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('capabilitiesTitle')}</CardTitle>
                <CardDescription>{t('capabilitiesDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {status.capabilities.map((cap) => (
                    <Badge key={cap} variant="outline" className="font-mono text-xs">
                      {cap}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('removeDialogTitle')}</DialogTitle>
            <DialogDescription>{t('removeDialogDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? t('removing') : t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const STATUS_STYLE: Record<
  AdminLicenseStatusDto['status'],
  { border: string; bg: string; text: string; icon: 'check' | 'clock' | 'alert' }
> = {
  active: {
    border: 'border-success-200',
    bg: 'bg-success-50',
    text: 'text-success-700',
    icon: 'check',
  },
  dev: {
    border: 'border-warning-200',
    bg: 'bg-warning-50',
    text: 'text-warning-700',
    icon: 'alert',
  },
  grace: {
    border: 'border-warning-200',
    bg: 'bg-warning-50',
    text: 'text-warning-700',
    icon: 'clock',
  },
  expired: {
    border: 'border-danger-100',
    bg: 'bg-danger-50',
    text: 'text-danger-700',
    icon: 'alert',
  },
  invalid: {
    border: 'border-danger-100',
    bg: 'bg-danger-50',
    text: 'text-danger-700',
    icon: 'alert',
  },
  community: {
    border: 'border-border-soft',
    bg: 'bg-surface-2',
    text: 'text-text-muted',
    icon: 'check',
  },
};

function licenseDate(iso: string | undefined | null): string | null {
  if (!iso) return null;
  return formatDateTime(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusCard({
  status,
  onRefresh,
  refreshing,
}: {
  status: AdminLicenseStatusDto;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const t = useTranslations('adminMonetizacion.license');
  const tLicStatus = useTranslations('adminMonetizacion.licenseStatus');
  const style = STATUS_STYLE[status.status];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="shield" size={18} />
          {t('statusTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="status"
          data-testid="license-status-banner"
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${style.border} ${style.bg} ${style.text}`}
        >
          <span className="flex items-center gap-2">
            <Icon name={style.icon} size={16} aria-hidden="true" />
            <strong>{tLicStatus(status.status)}</strong>
            {status.organizationName ? <span>— {status.organizationName}</span> : null}
          </span>
          {status.managedByEnv ? (
            <Badge variant="outline" title={t('managedByEnvTitle')}>
              {t('managedByEnvBadge')}
            </Badge>
          ) : null}
        </div>

        {status.status !== 'community' ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {status.plan ? (
              <div>
                <dt className="text-text-subtle">{t('planLabel')}</dt>
                <dd className="font-medium">{status.plan}</dd>
              </div>
            ) : null}
            {status.edition ? (
              <div>
                <dt className="text-text-subtle">{t('editionLabel')}</dt>
                <dd className="font-medium capitalize">{status.edition}</dd>
              </div>
            ) : null}
            {licenseDate(status.issuedAt) ? (
              <div>
                <dt className="text-text-subtle">{t('issuedLabel')}</dt>
                <dd className="font-medium">{licenseDate(status.issuedAt)}</dd>
              </div>
            ) : null}
            {licenseDate(status.expiresAt) ? (
              <div>
                <dt className="text-text-subtle">{t('expiresLabel')}</dt>
                <dd className="font-medium">{licenseDate(status.expiresAt)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {status.warnings.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700">
            {status.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center justify-between border-t border-border-soft pt-3">
          <span className="text-xs text-text-subtle">
            {t('lastCheck', { date: licenseDate(status.loadedAt) ?? '—' })}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? t('revalidating') : t('revalidate')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
