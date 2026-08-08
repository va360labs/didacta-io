'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta de configuración Stripe per-tenant (Administración → Pagos).
 * Consume `/api/v1/admin/tenant-settings/stripe`. Mirror de
 * `SmtpSettingsCard`: mismos 4 estados de banner, mismo patrón write-only
 * para los secretos y merge-on-omit en el backend.
 *
 * Un único par de credenciales sirve a mod.billing (venta de cursos sueltos)
 * y mod.subscriptions (suscripciones/membresía) — comparten cuenta de
 * Stripe del tenant, igual que hoy comparten el fallback de instancia.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  adminStripeApi,
  deriveStripeStatus,
  type AdminStripeDto,
  type AdminStripeUpsertPayload,
} from '@/lib/admin-stripe';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';

interface StripeFormValues {
  secretKey: string;
  webhookSecret: string;
  subscriptionsWebhookSecret: string;
}

const EMPTY_FORM: StripeFormValues = {
  secretKey: '',
  webhookSecret: '',
  subscriptionsWebhookSecret: '',
};

interface ToastState {
  variant: 'success' | 'error' | 'info';
  message: string;
}

export interface StripeSettingsCardProps {
  /** Inyectable para tests: permite pasar un cliente fake sin tocar fetch. */
  api?: typeof adminStripeApi;
}

export function StripeSettingsCard({
  api = adminStripeApi,
}: StripeSettingsCardProps): React.JSX.Element {
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
  const [dto, setDto] = useState<AdminStripeDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<StripeFormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get();
        if (cancelled) return;
        setDto(data);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('stripe.loadError'),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setToast(null);
    if (!dto?.hasSecretKey && !form.secretKey.trim()) {
      setToast({ variant: 'error', message: t('stripe.missingSecretKey') });
      return;
    }
    if (!dto?.hasWebhookSecret && !form.webhookSecret.trim()) {
      setToast({
        variant: 'error',
        message: t('stripe.missingWebhookSecret'),
      });
      return;
    }
    setSaving(true);
    try {
      const payload: AdminStripeUpsertPayload = {
        ...(form.secretKey.trim() ? { secretKey: form.secretKey.trim() } : {}),
        ...(form.webhookSecret.trim() ? { webhookSecret: form.webhookSecret.trim() } : {}),
        ...(form.subscriptionsWebhookSecret.trim()
          ? { subscriptionsWebhookSecret: form.subscriptionsWebhookSecret.trim() }
          : {}),
      };
      const updated = await api.upsert(payload);
      setDto(updated);
      setForm(EMPTY_FORM);
      setToast({
        variant: 'success',
        message: t('stripe.savedInfo'),
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('stripe.saveError'),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setToast(null);
    try {
      const result = await api.test();
      setDto((prev) =>
        prev ? { ...prev, verifiedAt: result.verifiedAt, mode: result.mode } : prev,
      );
      setToast({
        variant: 'success',
        message: t('stripe.testOkInfo', { mode: result.mode }),
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('stripe.testError'),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      await api.remove();
      const refreshed = await api.get();
      setDto(refreshed);
      setForm(EMPTY_FORM);
      setToast({
        variant: 'success',
        message: refreshed.hasGlobalFallback
          ? t('stripe.deletedFallbackInfo')
          : t('stripe.deletedNoFallbackInfo'),
      });
      setDeleteDialogOpen(false);
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('stripe.deleteError'),
      });
    } finally {
      setDeleting(false);
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('stripe.title')}</CardTitle>
        <CardDescription>{t('stripe.help')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadError ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {loadError}
          </div>
        ) : null}

        {dto ? <StripeStatusBanner dto={dto} /> : <StripeStatusBannerSkeleton />}

        <form onSubmit={handleSubmit} aria-busy={saving} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="stripe-secret-key">
              {dto?.hasSecretKey ? t('stripe.secretKeyLabelOptional') : t('stripe.secretKeyLabel')}
            </Label>
            <Input
              id="stripe-secret-key"
              required={!dto?.hasSecretKey}
              type="password"
              autoComplete="off"
              value={form.secretKey}
              onChange={(e) => setForm({ ...form, secretKey: e.target.value })}
              placeholder={
                dto?.hasSecretKey ? t('stripe.secretKeyPhSaved') : t('stripe.secretKeyPhEmpty')
              }
              className="font-mono"
            />
            <p className="text-xs text-text-subtle">{t('stripe.secretKeyHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stripe-webhook-secret">
              {dto?.hasWebhookSecret ? t('stripe.webhookLabelOptional') : t('stripe.webhookLabel')}
            </Label>
            <Input
              id="stripe-webhook-secret"
              required={!dto?.hasWebhookSecret}
              type="password"
              autoComplete="off"
              value={form.webhookSecret}
              onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
              placeholder={
                dto?.hasWebhookSecret ? t('stripe.webhookPhSaved') : t('stripe.webhookPhEmpty')
              }
              className="font-mono"
            />
            <p className="break-all text-xs text-text-subtle">
              {t.rich('stripe.billingEndpoint', {
                url: `${origin}/api/v1/modules/billing/webhook`,
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stripe-subs-webhook-secret">{t('stripe.subsWebhookLabel')}</Label>
            <Input
              id="stripe-subs-webhook-secret"
              type="password"
              autoComplete="off"
              value={form.subscriptionsWebhookSecret}
              onChange={(e) => setForm({ ...form, subscriptionsWebhookSecret: e.target.value })}
              placeholder={
                dto?.hasSubscriptionsWebhookSecret
                  ? t('stripe.webhookPhSaved')
                  : t('stripe.subsWebhookPhEmpty')
              }
              className="font-mono"
            />
            <p className="break-all text-xs text-text-subtle">
              {t.rich('stripe.subsEndpoint', {
                url: `${origin}/api/v1/modules/subscriptions/webhook`,
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
          </div>

          {toast ? (
            <div
              role="status"
              aria-live="polite"
              className={
                'rounded-md border p-3 text-sm sm:col-span-2 ' +
                (toast.variant === 'success'
                  ? 'border-success-200 bg-success-50 text-success-700'
                  : toast.variant === 'error'
                    ? 'border-danger-100 bg-danger-50 text-danger-700'
                    : 'border-brand-100 bg-brand-50 text-brand-700')
              }
              data-testid="stripe-toast"
            >
              {toast.message}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-4 sm:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? t('stripe.savingCta') : t('stripe.saveCta')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!dto?.hasTenantConfig || testing}
                onClick={() => void handleTest()}
              >
                {testing ? t('stripe.testingCta') : t('stripe.testCta')}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={!dto?.hasTenantConfig}
              onClick={() => setDeleteDialogOpen(true)}
              className="text-danger-700 hover:bg-danger-50"
            >
              {t('stripe.deleteConfigCta')}
            </Button>
          </div>
        </form>
      </CardContent>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stripe.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('stripe.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('stripe.cancelCta')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? t('stripe.deletingCta') : t('stripe.deleteCta')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Banner superior con el estado actual de Stripe. Se renderiza siempre, con
 * uno de 4 estilos según `deriveStripeStatus(dto)`.
 */
export function StripeStatusBanner({ dto }: { dto: AdminStripeDto }): React.JSX.Element {
  const t = useTranslations('adminPagos');
  const status = deriveStripeStatus(dto);

  if (status === 'verified') {
    const date = dto.verifiedAt
      ? formatDateTime(dto.verifiedAt, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    return (
      <div
        role="status"
        data-testid="stripe-banner-verified"
        className="flex items-center gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700"
      >
        <span aria-hidden="true">●</span>
        <span>
          {t.rich('stripe.verifiedBanner', {
            mode: dto.mode ?? 'none',
            date,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </span>
      </div>
    );
  }

  if (status === 'configured-unverified') {
    return (
      <div
        role="status"
        data-testid="stripe-banner-unverified"
        className="flex items-center gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700"
      >
        <span aria-hidden="true">●</span>
        <span>{t.rich('stripe.unverifiedBanner', { em: (chunks) => <em>{chunks}</em> })}</span>
      </div>
    );
  }

  if (status === 'fallback') {
    return (
      <div
        role="status"
        data-testid="stripe-banner-fallback"
        className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-700"
      >
        <span aria-hidden="true">●</span>
        <span>{t('stripe.fallbackBanner')}</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="stripe-banner-none"
      className="flex items-center gap-2 rounded-lg border border-danger-100 bg-danger-50 px-3 py-2 text-sm text-danger-700"
    >
      <span aria-hidden="true">●</span>
      <span>{t('stripe.noneBanner')}</span>
    </div>
  );
}

function StripeStatusBannerSkeleton(): React.JSX.Element {
  return <div className="h-10 w-full animate-pulse rounded-lg bg-surface-2" aria-hidden="true" />;
}
