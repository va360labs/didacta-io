'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta de configuración del REGISTRO DE MIEMBROS per-tenant (F2 — registro
 * componible). Gestiona las tres claves del scope `member-registration` en
 * `tenant_setting`:
 *
 *  - `verification` (plana): `{ enabled, verifiers }` — habilita el flujo y
 *    elige los verificadores exigidos (Telegram y/u OTP por email; ninguno =
 *    registro libre con aprobación manual; deshabilitado = registro cerrado).
 *  - `telegram` (SECRETA): `{ botToken, groupId, botUsername }` — el token se
 *    cifra at-rest y nunca vuelve en claro; dejar el campo vacío al guardar
 *    conserva el token anterior (merge del backend).
 *  - `approval` (plana): `{ email }` — aprobador que recibe las solicitudes.
 *
 * Sin setting guardado aplica el default legacy del despliegue: con bot de
 * Telegram en el env → Telegram+OTP; sin bot → registro cerrado. La tarjeta
 * hidrata ese estado efectivo desde el endpoint público `/modules/member-registration/config`.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { fetchInscripcionConfig, type InscripcionVerifier } from '@/lib/inscripcion';
import { tenantSettingsApi } from '@/lib/tenant-settings';

const SCOPE = 'member-registration';

interface FormState {
  enabled: boolean;
  requireTelegram: boolean;
  requireOtp: boolean;
  botUsername: string;
  groupId: string;
  botToken: string;
  approverEmail: string;
}

const EMPTY_FORM: FormState = {
  enabled: false,
  requireTelegram: false,
  requireOtp: false,
  botUsername: '',
  groupId: '',
  botToken: '',
  approverEmail: '',
};

/** Describe el modo resultante para que el admin entienda qué está eligiendo. */
function modeDescription(form: FormState): string {
  if (!form.enabled) {
    return 'Registro CERRADO: nadie puede solicitar acceso; las altas las hace el administrador.';
  }
  if (form.requireTelegram && form.requireOtp) {
    return 'El aspirante verifica su Telegram (pertenencia al grupo) y su email con un código antes de enviar la solicitud.';
  }
  if (form.requireTelegram) {
    return 'El aspirante verifica su Telegram (pertenencia al grupo); el email se pide sin verificar.';
  }
  if (form.requireOtp) {
    return 'El aspirante verifica su email con un código de 6 dígitos antes de enviar la solicitud.';
  }
  return 'Registro LIBRE: cualquiera puede enviar una solicitud; el único gate es tu aprobación manual.';
}

export function MemberRegistrationSettingsCard(): React.JSX.Element {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Cada clave puede no existir aún (404) — se trata como vacía.
      const [verification, telegram, approval, effective] = await Promise.all([
        tenantSettingsApi.get(SCOPE, 'verification').catch(() => null),
        tenantSettingsApi.get(SCOPE, 'telegram').catch(() => null),
        tenantSettingsApi.get(SCOPE, 'approval').catch(() => null),
        fetchInscripcionConfig(),
      ]);
      if (cancelled) return;

      const next: FormState = { ...EMPTY_FORM };

      const verificationValue = (verification?.value ?? null) as {
        enabled?: unknown;
        verifiers?: unknown;
      } | null;
      if (verificationValue && typeof verificationValue.enabled === 'boolean') {
        const verifiers = Array.isArray(verificationValue.verifiers)
          ? (verificationValue.verifiers as InscripcionVerifier[])
          : [];
        next.enabled = verificationValue.enabled;
        next.requireTelegram = verifiers.includes('telegram');
        next.requireOtp = verifiers.includes('otp');
      } else {
        // Sin setting explícito: reflejar el estado EFECTIVO (default legacy).
        next.enabled = effective.configured;
        next.requireTelegram = effective.verifiers.includes('telegram');
        next.requireOtp = effective.verifiers.includes('otp');
      }

      // El token nunca vuelve en claro (redactado a null); el resto hidrata.
      const telegramValue = (telegram?.value ?? null) as {
        botUsername?: unknown;
        groupId?: unknown;
      } | null;
      if (telegramValue) {
        next.botUsername =
          typeof telegramValue.botUsername === 'string' ? telegramValue.botUsername : '';
        next.groupId = typeof telegramValue.groupId === 'string' ? telegramValue.groupId : '';
      }
      setHasStoredToken(Boolean(telegram?.hasValue));

      const approvalValue = (approval?.value ?? null) as { email?: unknown } | null;
      if (approvalValue && typeof approvalValue.email === 'string') {
        next.approverEmail = approvalValue.email;
      }

      setForm(next);
      setStatus('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setError(null);
    try {
      if (form.requireTelegram && !form.groupId.trim() && form.enabled) {
        throw new Error(
          'Para exigir Telegram configura el bot (grupo y token) — sin él el flujo quedaría indisponible.',
        );
      }

      const verifiers: InscripcionVerifier[] = [
        ...(form.requireTelegram ? (['telegram'] as const) : []),
        ...(form.requireOtp ? (['otp'] as const) : []),
      ];
      await tenantSettingsApi.upsert(SCOPE, 'verification', {
        isSecret: false,
        value: { enabled: form.enabled, verifiers },
      });

      // El bot solo se escribe si el admin aportó algo: token vacío conserva
      // el guardado (merge de campos sensibles en el backend).
      if (form.groupId.trim() || form.botUsername.trim() || form.botToken.trim()) {
        await tenantSettingsApi.upsert(SCOPE, 'telegram', {
          isSecret: true,
          value: {
            botToken: form.botToken.trim(),
            groupId: form.groupId.trim(),
            botUsername: form.botUsername.trim().replace(/^@/, ''),
          },
        });
        if (form.botToken.trim()) setHasStoredToken(true);
      }

      if (form.approverEmail.trim()) {
        await tenantSettingsApi.upsert(SCOPE, 'approval', {
          isSecret: false,
          value: { email: form.approverEmail.trim() },
        });
      } else {
        // Vacío = volver al fallback global del despliegue (si existe).
        await tenantSettingsApi.remove(SCOPE, 'approval').catch(() => undefined);
      }

      setStatus('saved');
      setForm((f) => ({ ...f, botToken: '' }));
    } catch (err) {
      setStatus('error');
      setError(
        err instanceof Error ? err.message : 'No pudimos guardar la configuración del registro.',
      );
    }
  }

  if (status === 'loading') {
    return (
      <div className="space-y-2">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Registro de miembros</CardTitle>
          {form.enabled ? (
            <Badge variant="success">Abierto</Badge>
          ) : (
            <Badge variant="muted">Cerrado</Badge>
          )}
        </div>
        <CardDescription>
          Cómo entra la gente a tu comunidad por <code>/inscripcion-miembros</code>: elige qué
          verificaciones exiges antes de que te llegue cada solicitud. La aprobación final siempre
          es tuya (email de 1 click o panel de solicitudes).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5">
          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft bg-surface-2 px-3 py-2.5">
            <span className="text-sm font-medium text-text">
              Registro habilitado (los visitantes pueden solicitar acceso)
            </span>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              label="Registro habilitado"
            />
          </label>

          <fieldset className="space-y-2" disabled={!form.enabled}>
            <legend className="text-sm font-semibold text-text">Verificaciones exigidas</legend>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2.5">
              <span className="text-sm text-text">
                Pertenencia a tu grupo de Telegram (Login Widget)
              </span>
              <Switch
                checked={form.requireTelegram}
                onCheckedChange={(v) => setForm((f) => ({ ...f, requireTelegram: v }))}
                label="Exigir verificación por Telegram"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2.5">
              <span className="text-sm text-text">Email con código de 6 dígitos (OTP)</span>
              <Switch
                checked={form.requireOtp}
                onCheckedChange={(v) => setForm((f) => ({ ...f, requireOtp: v }))}
                label="Exigir verificación por email"
              />
            </label>
          </fieldset>

          <p className="rounded-lg border border-border-soft bg-surface-2 p-3 text-sm text-text-muted">
            {modeDescription(form)}
          </p>

          {form.requireTelegram ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mr-bot-username">Username del bot (sin @)</Label>
                <Input
                  id="mr-bot-username"
                  value={form.botUsername}
                  onChange={(e) => setForm((f) => ({ ...f, botUsername: e.target.value }))}
                  placeholder="mi_academia_bot"
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">
                  Necesario para mostrar el Login Widget en el formulario público.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mr-group-id">ID del grupo</Label>
                <Input
                  id="mr-group-id"
                  value={form.groupId}
                  onChange={(e) => setForm((f) => ({ ...f, groupId: e.target.value }))}
                  placeholder="-1001234567890"
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">
                  ID numérico del grupo/supergrupo (con el prefijo -100 en supergrupos).
                </p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mr-bot-token">Token del bot</Label>
                <Input
                  id="mr-bot-token"
                  type="password"
                  value={form.botToken}
                  onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))}
                  placeholder={
                    hasStoredToken ? '(dejar vacío para conservar el actual)' : '123456:ABC-DEF…'
                  }
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">
                  Se cifra con AES-256-GCM antes de persistir. La API nunca lo devuelve en claro.
                </p>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="mr-approver">Email del aprobador</Label>
            <Input
              id="mr-approver"
              type="email"
              value={form.approverEmail}
              onChange={(e) => setForm((f) => ({ ...f, approverEmail: e.target.value }))}
              placeholder="admin@tuacademia.com"
            />
            <p className="text-xs text-text-subtle">
              Recibe cada solicitud con los enlaces de aprobar/rechazar en 1 click. Vacío = usa el
              aprobador global del despliegue, si existe.
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}
          {status === 'saved' ? (
            <p className="text-sm text-success-700">Guardado correctamente.</p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? 'Guardando…' : 'Guardar configuración'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
