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
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import type { TranslatorLike } from '@/lib/i18n/labels';
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
function modeDescription(form: FormState, t: TranslatorLike): string {
  if (!form.enabled) {
    return t('registration.modeClosed');
  }
  if (form.requireTelegram && form.requireOtp) {
    return t('registration.modeBoth');
  }
  if (form.requireTelegram) {
    return t('registration.modeTelegram');
  }
  if (form.requireOtp) {
    return t('registration.modeOtp');
  }
  return t('registration.modeFree');
}

export function MemberRegistrationSettingsCard(): React.JSX.Element {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');
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
        throw new Error(t('registration.telegramConfigRequired'));
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
      setError(apiErrorMessage(err, tErrors));
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
          <CardTitle>{t('registration.title')}</CardTitle>
          {form.enabled ? (
            <Badge variant="success">{t('registration.open')}</Badge>
          ) : (
            <Badge variant="muted">{t('registration.closed')}</Badge>
          )}
        </div>
        <CardDescription>
          {t.rich('registration.description', {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5">
          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft bg-surface-2 px-3 py-2.5">
            <span className="text-sm font-medium text-text">{t('registration.enabledLabel')}</span>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              label={t('registration.enabledSwitch')}
            />
          </label>

          <fieldset className="space-y-2" disabled={!form.enabled}>
            <legend className="text-sm font-semibold text-text">
              {t('registration.verifiersLegend')}
            </legend>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2.5">
              <span className="text-sm text-text">{t('registration.telegramOption')}</span>
              <Switch
                checked={form.requireTelegram}
                onCheckedChange={(v) => setForm((f) => ({ ...f, requireTelegram: v }))}
                label={t('registration.telegramSwitch')}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2.5">
              <span className="text-sm text-text">{t('registration.otpOption')}</span>
              <Switch
                checked={form.requireOtp}
                onCheckedChange={(v) => setForm((f) => ({ ...f, requireOtp: v }))}
                label={t('registration.otpSwitch')}
              />
            </label>
          </fieldset>

          <p className="rounded-lg border border-border-soft bg-surface-2 p-3 text-sm text-text-muted">
            {modeDescription(form, t)}
          </p>

          {form.requireTelegram ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mr-bot-username">{t('registration.botUsernameLabel')}</Label>
                <Input
                  id="mr-bot-username"
                  value={form.botUsername}
                  onChange={(e) => setForm((f) => ({ ...f, botUsername: e.target.value }))}
                  placeholder={t('registration.botUsernamePlaceholder')}
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">{t('registration.botUsernameHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mr-group-id">{t('registration.groupIdLabel')}</Label>
                <Input
                  id="mr-group-id"
                  value={form.groupId}
                  onChange={(e) => setForm((f) => ({ ...f, groupId: e.target.value }))}
                  placeholder="-1001234567890"
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">{t('registration.groupIdHint')}</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mr-bot-token">{t('registration.tokenLabel')}</Label>
                <Input
                  id="mr-bot-token"
                  type="password"
                  value={form.botToken}
                  onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))}
                  placeholder={
                    hasStoredToken ? t('registration.tokenKeepPlaceholder') : '123456:ABC-DEF…'
                  }
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">{t('registration.tokenHint')}</p>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="mr-approver">{t('registration.approverLabel')}</Label>
            <Input
              id="mr-approver"
              type="email"
              value={form.approverEmail}
              onChange={(e) => setForm((f) => ({ ...f, approverEmail: e.target.value }))}
              placeholder={t('registration.approverPlaceholder')}
            />
            <p className="text-xs text-text-subtle">{t('registration.approverHint')}</p>
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
            <p className="text-sm text-success-700">{t('registration.saved')}</p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? t('registration.saving') : t('registration.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
