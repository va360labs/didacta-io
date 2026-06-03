'use client';

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
          err instanceof ApiHttpError
            ? err.message
            : 'No pudimos cargar la configuración SMTP. Reintentá.',
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
        message: firstIssue?.message ?? 'Revisá los campos del formulario.',
      });
      return;
    }
    // Si NO hay password guardado y el campo está vacío → required.
    if (!dto?.hasPassword && !parsed.data.password) {
      setToast({ variant: 'error', message: 'Contraseña requerida (no hay una guardada).' });
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
      setToast({
        variant: 'success',
        message: 'Configuración guardada. Mandá un email de prueba para verificar que llega bien.',
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? err.message : 'No pudimos guardar la configuración.',
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
        message: `Email de prueba enviado a ${result.sentTo}. Revisá tu bandeja.`,
      });
      setTestDialogOpen(false);
    } catch (err) {
      // El backend devuelve 400 con el mensaje del MTA (auth failed, conexión
      // rechazada, etc.). Lo mostramos textual para que el admin diagnostique.
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? err.message : 'No pudimos enviar el email de prueba.',
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
          ? 'Configuración eliminada. El tenant ahora usa el SMTP global del host.'
          : 'Configuración eliminada. Sin SMTP no se envían emails — guardá una nueva.',
      });
      setDeleteDialogOpen(false);
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? err.message : 'No pudimos eliminar la configuración.',
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notificaciones · SMTP</CardTitle>
        <CardDescription>
          Servidor saliente para enviar emails transaccionales (activación de cuenta, reset de
          contraseña, notificaciones de cursos). Si no se configura, el tenant hereda el SMTP global
          del host (si el operador lo expuso por env).
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

        {dto ? <StatusBanner dto={dto} /> : <StatusBannerSkeleton />}

        <form onSubmit={handleSubmit} aria-busy={saving} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host">Host</Label>
            <Input
              id="smtp-host"
              required
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="smtp-relay.brevo.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-port">Puerto</Label>
            <Input
              id="smtp-port"
              required
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              placeholder="587"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2/40 p-3 sm:col-span-2">
            <div>
              <Label htmlFor="smtp-secure" className="text-sm font-medium">
                Conexión segura (TLS)
              </Label>
              <p className="text-xs text-text-subtle">
                Activá si tu provider usa STARTTLS/SSL. Por defecto ON; los puertos 25 y 587 sin
                cifrado quedan deshabilitados.
              </p>
            </div>
            <Switch
              id="smtp-secure"
              checked={form.secure}
              onCheckedChange={(checked) => setForm({ ...form, secure: checked })}
              label="Activar TLS"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-username">Usuario</Label>
            <Input
              id="smtp-username"
              required
              autoComplete="off"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="apikey, postmaster@dominio, etc."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-password">Contraseña{dto?.hasPassword ? ' (opcional)' : ''}</Label>
            <Input
              id="smtp-password"
              required={!dto?.hasPassword}
              type="password"
              autoComplete="new-password"
              value={form.password ?? ''}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder={
                dto?.hasPassword
                  ? '•••••• (déjalo vacío para mantener el actual)'
                  : 'API key / SMTP password'
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from-email">From email</Label>
            <Input
              id="smtp-from-email"
              required
              type="email"
              value={form.fromEmail}
              onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
              placeholder="noreply@tu-dominio.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from-name">From name (opcional)</Label>
            <Input
              id="smtp-from-name"
              value={form.fromName ?? ''}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              placeholder="Equipo Didacta"
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
                {saving ? 'Guardando…' : 'Guardar'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!dto?.hasTenantConfig}
                onClick={() => setTestDialogOpen(true)}
              >
                Enviar email de prueba
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

      {/* Modal de envío de prueba. Prellena con el email del admin actual
          y dispara POST /admin/tenant-settings/smtp/test. */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar email de prueba</DialogTitle>
            <DialogDescription>
              Vamos a usar la configuración guardada para mandar un correo a la dirección que
              indiques. Si llega, marcamos la config como verificada.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="smtp-test-email">Destinatario</Label>
            <Input
              id="smtp-test-email"
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="tu-email@dominio.com"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setTestDialogOpen(false)}
              disabled={sendingTest}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void handleSendTest()}
              disabled={sendingTest || !testEmail}
            >
              {sendingTest ? 'Enviando…' : 'Enviar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar configuración SMTP</DialogTitle>
            <DialogDescription>
              Vas a borrar las credenciales guardadas para este tenant. Si el host tiene un SMTP
              global expuesto por env, el tenant cae a ese fallback; si no, los emails dejan de
              enviarse hasta que guardes una nueva configuración.
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
 * Banner superior con el estado actual del SMTP. Se renderiza siempre, con
 * uno de 4 estilos según `deriveSmtpStatus(dto)`. Las cuatro variantes están
 * exportadas para los snapshot tests.
 */
export function StatusBanner({ dto }: { dto: AdminSmtpDto }): React.JSX.Element {
  const status = deriveSmtpStatus(dto);

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
        data-testid="smtp-banner-verified"
        className="flex items-center gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700"
      >
        <span aria-hidden="true">●</span>
        <span>
          <strong>Verificado</strong> el {date}.
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
          Configurado pero sin verificar — usá el botón <em>Enviar email de prueba</em> para
          confirmar que llega.
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
        <span>
          Usando SMTP global del host (fallback). Si querés un remitente propio, guardá una
          configuración de tenant.
        </span>
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
      <span>
        Sin SMTP configurado — los emails (activación, reset de contraseña, notificaciones) no se
        envían.
      </span>
    </div>
  );
}

function StatusBannerSkeleton(): React.JSX.Element {
  return <div className="h-10 w-full animate-pulse rounded-lg bg-surface-2" aria-hidden="true" />;
}
