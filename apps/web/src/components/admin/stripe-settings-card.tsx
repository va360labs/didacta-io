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
          err instanceof ApiHttpError
            ? err.message
            : 'No pudimos cargar la configuración de Stripe. Reintenta.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setToast(null);
    if (!dto?.hasSecretKey && !form.secretKey.trim()) {
      setToast({ variant: 'error', message: 'Falta la clave secreta (no hay una guardada).' });
      return;
    }
    if (!dto?.hasWebhookSecret && !form.webhookSecret.trim()) {
      setToast({
        variant: 'error',
        message: 'Falta el secreto del webhook (no hay uno guardado).',
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
        message: 'Credenciales guardadas. Usa "Probar conexión" para verificarlas contra Stripe.',
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? err.message : 'No pudimos guardar las credenciales.',
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
        message: `Conexión verificada — cuenta en modo ${result.mode === 'live' ? 'LIVE' : 'test'}.`,
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? err.message : 'No pudimos probar la conexión.',
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
          ? 'Credenciales eliminadas. El tenant ahora usa el Stripe global del host.'
          : 'Credenciales eliminadas. Sin Stripe, la venta de cursos y las suscripciones no funcionan hasta que guardes unas nuevas.',
      });
      setDeleteDialogOpen(false);
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? err.message : 'No pudimos eliminar las credenciales.',
      });
    } finally {
      setDeleting(false);
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pagos · Stripe</CardTitle>
        <CardDescription>
          Cuenta de Stripe de esta academia: cobra la venta de cursos sueltos (mod.billing) y las
          suscripciones/membresía (mod.subscriptions). Si no se configura, el tenant hereda el
          Stripe global del host (si el operador lo expuso por env).
        </CardDescription>
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
              Clave secreta{dto?.hasSecretKey ? ' (opcional)' : ''}
            </Label>
            <Input
              id="stripe-secret-key"
              required={!dto?.hasSecretKey}
              type="password"
              autoComplete="off"
              value={form.secretKey}
              onChange={(e) => setForm({ ...form, secretKey: e.target.value })}
              placeholder={
                dto?.hasSecretKey
                  ? '•••••• (déjalo vacío para mantener la actual)'
                  : 'sk_test_… o sk_live_…'
              }
              className="font-mono"
            />
            <p className="text-xs text-text-subtle">
              Panel de Stripe → Desarrolladores → Claves de API → Clave secreta.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stripe-webhook-secret">
              Secreto del webhook{dto?.hasWebhookSecret ? ' (opcional)' : ''}
            </Label>
            <Input
              id="stripe-webhook-secret"
              required={!dto?.hasWebhookSecret}
              type="password"
              autoComplete="off"
              value={form.webhookSecret}
              onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
              placeholder={dto?.hasWebhookSecret ? '•••••• (mantener el actual)' : 'whsec_…'}
              className="font-mono"
            />
            <p className="break-all text-xs text-text-subtle">
              Endpoint de cursos sueltos: <code>{origin}/api/v1/modules/billing/webhook</code>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stripe-subs-webhook-secret">
              Secreto del webhook de suscripciones (opcional)
            </Label>
            <Input
              id="stripe-subs-webhook-secret"
              type="password"
              autoComplete="off"
              value={form.subscriptionsWebhookSecret}
              onChange={(e) => setForm({ ...form, subscriptionsWebhookSecret: e.target.value })}
              placeholder={
                dto?.hasSubscriptionsWebhookSecret
                  ? '•••••• (mantener el actual)'
                  : 'whsec_… (si lo dejas vacío, se usa el mismo de arriba)'
              }
              className="font-mono"
            />
            <p className="break-all text-xs text-text-subtle">
              Endpoint de suscripciones: <code>{origin}/api/v1/modules/subscriptions/webhook</code>
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
                {saving ? 'Guardando…' : 'Guardar'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!dto?.hasTenantConfig || testing}
                onClick={() => void handleTest()}
              >
                {testing ? 'Probando…' : 'Probar conexión'}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={!dto?.hasTenantConfig}
              onClick={() => setDeleteDialogOpen(true)}
              className="text-danger-700 hover:bg-danger-50"
            >
              Eliminar configuración
            </Button>
          </div>
        </form>
      </CardContent>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar configuración de Stripe</DialogTitle>
            <DialogDescription>
              Vas a borrar las credenciales guardadas para este tenant. Si el host tiene un Stripe
              global expuesto por env, el tenant cae a ese fallback; si no, la venta de cursos y las
              suscripciones dejan de funcionar hasta que guardes una nueva configuración.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? 'Eliminando…' : 'Eliminar'}
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
  const status = deriveStripeStatus(dto);
  const modeLabel =
    dto.mode === 'live' ? ' (modo LIVE)' : dto.mode === 'test' ? ' (modo test)' : '';

  if (status === 'verified') {
    const date = dto.verifiedAt
      ? new Date(dto.verifiedAt).toLocaleString('es-ES', {
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
          <strong>Verificado</strong> el {date}
          {modeLabel}.
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
        <span>
          Configurado pero sin verificar — usa el botón <em>Probar conexión</em> para confirmar que
          las claves son válidas.
        </span>
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
        <span>
          Usando Stripe global del host (fallback). Si quieres cobrar en tu propia cuenta, guarda
          una configuración de tenant.
        </span>
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
      <span>
        Sin Stripe configurado — la venta de cursos sueltos y las suscripciones/membresía no
        funcionan.
      </span>
    </div>
  );
}

function StripeStatusBannerSkeleton(): React.JSX.Element {
  return <div className="h-10 w-full animate-pulse rounded-lg bg-surface-2" aria-hidden="true" />;
}
