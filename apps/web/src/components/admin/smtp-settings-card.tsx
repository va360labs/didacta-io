'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta de configuración SMTP per-tenant. Consume el controlador dedicado
 * `/api/v1/admin/tenant-settings/smtp` (alpha.75 backend) en lugar del
 * almacenamiento genérico de `tenant_setting`. El backend devuelve un DTO
 * plano (host, port, secure, username, fromEmail, fromName) + flags de
 * estado (`hasPassword`, `verifiedAt`, `hasTenantConfig`, `hasGlobalFallback`)
 * que mapeamos a 4 estados visuales en el banner superior.
 *
 * Decisiones:
 *  - `password` se muestra como required solo cuando NO hay password
 *    guardada. Si ya existe, el campo es opcional con placeholder claro:
 *    dejarlo vacío preserva el secret previo (backend hace el merge).
 *  - `Enviar email de prueba` se habilita sólo si `hasTenantConfig` — sin
 *    credenciales propias el resolver del backend rechaza con 400 antes de
 *    intentar enviar.
 *  - `Eliminar configuración` borra las dos rows (smtp + smtp_meta) y deja
 *    al tenant cayendo al fallback global (si lo hay) o sin SMTP.
 *
 * Estilo: matchea el resto de `/admin/configuracion` (shadcn/ui Card/Input/
 * Button/Switch + paleta de tokens `brand-`, `success-`, `warning-`,
 * `danger-`).
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
import { Switch } from '@/components/ui/switch';
import {
  adminSmtpApi,
  deriveSmtpStatus,
  type AdminSmtpDto,
  type AdminSmtpUpsertPayload,
} from '@/lib/admin-smtp';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import { smtpFormSchema, type SmtpFormValues } from './smtp-form-schema';

// Re-export para que los tests existentes que ya importaban el schema desde
// este archivo no se rompan (vía path `@/components/admin/smtp-settings-card`).
export { smtpFormSchema };
export type { SmtpFormValues };

const EMPTY_FORM: SmtpFormValues = {
  host: '',
  port: 587,
  secure: true,
  username: '',
  password: '',
  fromEmail: '',
  fromName: '',
};

interface ToastState {
  variant: 'success' | 'error' | 'info';
  message: string;
}

export interface SmtpSettingsCardProps {
  /**
   * Inyectable para tests: permite pasar un cliente fake sin tocar fetch.
   * Por defecto usa `adminSmtpApi` (sessionStorage para el bearer).
   */
  api?: typeof adminSmtpApi;
  /**
   * Email del admin actual, prellenado en el modal de prueba. Por defecto
   * lo lee de `authStorage.getSession()`. Inyectable para tests.
   */
  currentAdminEmail?: string | null;
}

export function SmtpSettingsCard({
  api = adminSmtpApi,
  currentAdminEmail,
}: SmtpSettingsCardProps): React.JSX.Element {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [dto, setDto] = useState<AdminSmtpDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<SmtpFormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Carga inicial del estado guardado.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get();
        if (cancelled) return;
        setDto(data);
        setForm({
          host: data.host ?? '',
          port: data.port ?? 587,
          secure: data.secure ?? true,
          username: data.username ?? '',
          password: '',
          fromEmail: data.fromEmail ?? '',
          fromName: data.fromName ?? '',
        });
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('smtp.loadError'),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Prellenado del modal de prueba con el email del admin.
  useEffect(() => {
    if (testDialogOpen && !testEmail) {
      const email = currentAdminEmail ?? authStorage.getSession()?.user.email ?? '';
      setTestEmail(email);
    }
  }, [testDialogOpen, testEmail, currentAdminEmail]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setToast(null);
    const parsed = smtpFormSchema.safeParse(form);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      setToast({
        variant: 'error',
        // Los mensajes custom del schema son keys del grupo `validation`;
        // los defaults de Zod (sin key en el catálogo) se muestran tal cual.
        message: firstIssue
          ? labelOr(t, firstIssue.message, firstIssue.message)
          : t('smtp.formInvalid'),
      });
      return;
    }
    // Si NO hay password guardado y el campo está vacío → required.
    if (!dto?.hasPassword && !parsed.data.password) {
      setToast({ variant: 'error', message: t('smtp.passwordRequired') });
      return;
    }
    setSaving(true);
    try {
      const payload: AdminSmtpUpsertPayload = {
        host: parsed.data.host,
        port: parsed.data.port,
        secure: parsed.data.secure,
        username: parsed.data.username,
        fromEmail: parsed.data.fromEmail,
        ...(parsed.data.fromName ? { fromName: parsed.data.fromName } : {}),
        // Sólo enviamos password si el admin lo tipeó; vacío = conservar.
        ...(parsed.data.password ? { password: parsed.data.password } : {}),
      };
      const updated = await api.upsert(payload);
      setDto(updated);
      setForm((f) => ({ ...f, password: '' }));
      setToast({ variant: 'success', message: t('smtp.saved') });
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('smtp.saveError'),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest(): Promise<void> {
    setSendingTest(true);
    try {
      const result = await api.test(testEmail);
      setDto((prev) => (prev ? { ...prev, verifiedAt: result.verifiedAt } : prev));
      setToast({
        variant: 'success',
        message: t('smtp.testSent', { email: result.sentTo }),
      });
      setTestDialogOpen(false);
    } catch (err) {
      // El backend devuelve 400 con el mensaje del MTA (auth failed, conexión
      // rechazada, etc.). Lo mostramos textual para que el admin diagnostique.
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('smtp.testError'),
      });
    } finally {
      setSendingTest(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      await api.remove();
      // Re-leemos el DTO porque puede quedar en fallback si hay env globales.
      const refreshed = await api.get();
      setDto(refreshed);
      setForm({
        host: refreshed.host ?? '',
        port: refreshed.port ?? 587,
        secure: refreshed.secure ?? true,
        username: refreshed.username ?? '',
        password: '',
        fromEmail: refreshed.fromEmail ?? '',
        fromName: refreshed.fromName ?? '',
      });
      setToast({
        variant: 'success',
        message: refreshed.hasGlobalFallback
          ? t('smtp.deletedFallback')
          : t('smtp.deletedNoFallback'),
      });
      setDeleteDialogOpen(false);
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('smtp.deleteError'),
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('smtp.title')}</CardTitle>
        <CardDescription>{t('smtp.subtitle')}</CardDescription>
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

        {dto ? <StatusBanner dto={dto} /> : <StatusBannerSkeleton />}

        <form onSubmit={handleSubmit} aria-busy={saving} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host">{t('smtp.hostLabel')}</Label>
            <Input
              id="smtp-host"
              required
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder={t('smtp.hostPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-port">{t('smtp.portLabel')}</Label>
            <Input
              id="smtp-port"
              required
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              placeholder={t('smtp.portPlaceholder')}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2/40 p-3 sm:col-span-2">
            <div>
              <Label htmlFor="smtp-secure" className="text-sm font-medium">
                {t('smtp.secureLabel')}
              </Label>
              <p className="text-xs text-text-subtle">{t('smtp.secureHelp')}</p>
            </div>
            <Switch
              id="smtp-secure"
              checked={form.secure}
              onCheckedChange={(checked) => setForm({ ...form, secure: checked })}
              label={t('smtp.secureSwitchLabel')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-username">{t('smtp.usernameLabel')}</Label>
            <Input
              id="smtp-username"
              required
              autoComplete="off"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder={t('smtp.usernamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-password">
              {dto?.hasPassword ? t('smtp.passwordLabelOptional') : t('smtp.passwordLabel')}
            </Label>
            <Input
              id="smtp-password"
              required={!dto?.hasPassword}
              type="password"
              autoComplete="new-password"
              value={form.password ?? ''}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder={
                dto?.hasPassword
                  ? t('smtp.passwordUnchangedPlaceholder')
                  : t('smtp.passwordPlaceholder')
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from-email">{t('smtp.fromEmailLabel')}</Label>
            <Input
              id="smtp-from-email"
              required
              type="email"
              value={form.fromEmail}
              onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
              placeholder={t('smtp.fromEmailPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from-name">{t('smtp.fromNameLabel')}</Label>
            <Input
              id="smtp-from-name"
              value={form.fromName ?? ''}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              placeholder={t('smtp.fromNamePlaceholder')}
            />
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
              data-testid="smtp-toast"
            >
              {toast.message}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-4 sm:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? t('smtp.saving') : t('smtp.saveButton')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!dto?.hasTenantConfig}
                onClick={() => setTestDialogOpen(true)}
              >
                {t('smtp.testButton')}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={!dto?.hasTenantConfig}
              onClick={() => setDeleteDialogOpen(true)}
              className="text-danger-700 hover:bg-danger-50"
            >
              {t('smtp.deleteButton')}
            </Button>
          </div>
        </form>
      </CardContent>

      {/* Modal de envío de prueba. Prellena con el email del admin actual
          y dispara POST /admin/tenant-settings/smtp/test. */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('smtp.testButton')}</DialogTitle>
            <DialogDescription>{t('smtp.testDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="smtp-test-email">{t('smtp.testRecipientLabel')}</Label>
            <Input
              id="smtp-test-email"
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder={t('smtp.testRecipientPlaceholder')}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setTestDialogOpen(false)}
              disabled={sendingTest}
            >
              {t('smtp.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void handleSendTest()}
              disabled={sendingTest || !testEmail}
            >
              {sendingTest ? t('smtp.sending') : t('smtp.sendButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('smtp.deleteDialogTitle')}</DialogTitle>
            <DialogDescription>{t('smtp.deleteDialogDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('smtp.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? t('smtp.deleting') : t('smtp.deleteConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Banner superior con el estado actual del SMTP. Se renderiza siempre, con
 * uno de 4 estilos según `deriveSmtpStatus(dto)`. Las cuatro variantes están
 * exportadas para los snapshot tests.
 */
export function StatusBanner({ dto }: { dto: AdminSmtpDto }): React.JSX.Element {
  const t = useTranslations('adminSso');
  const status = deriveSmtpStatus(dto);

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
        data-testid="smtp-banner-verified"
        className="flex items-center gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700"
      >
        <span aria-hidden="true">●</span>
        <span>
          {t.rich('smtp.bannerVerified', {
            strong: (chunks) => <strong>{chunks}</strong>,
            date,
          })}
        </span>
      </div>
    );
  }

  if (status === 'configured-unverified') {
    return (
      <div
        role="status"
        data-testid="smtp-banner-unverified"
        className="flex items-center gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700"
      >
        <span aria-hidden="true">●</span>
        <span>
          {t.rich('smtp.bannerUnverified', {
            em: (chunks) => <em>{chunks}</em>,
          })}
        </span>
      </div>
    );
  }

  if (status === 'fallback') {
    return (
      <div
        role="status"
        data-testid="smtp-banner-fallback"
        className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-700"
      >
        <span aria-hidden="true">●</span>
        <span>{t('smtp.bannerFallback')}</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="smtp-banner-none"
      className="flex items-center gap-2 rounded-lg border border-danger-100 bg-danger-50 px-3 py-2 text-sm text-danger-700"
    >
      <span aria-hidden="true">●</span>
      <span>{t('smtp.bannerNone')}</span>
    </div>
  );
}

function StatusBannerSkeleton(): React.JSX.Element {
  return <div className="h-10 w-full animate-pulse rounded-lg bg-surface-2" aria-hidden="true" />;
}
