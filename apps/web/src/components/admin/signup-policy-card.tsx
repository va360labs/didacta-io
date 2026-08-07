'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta "Registro público" del tab Registro de `/admin/configuracion` (A3
 * de `work/migracion-env-a-panel.md`). Distinta de `MemberRegistrationSettingsCard`
 * (esa gestiona `/inscripcion-miembros` — solicitudes con aprobación manual);
 * esta gestiona si `POST /auth/signup` (alta directa, sin aprobación) está
 * abierto para ESTE tenant. `tenant_setting` scope `auth` key `signup`.
 *
 * Si el operador fijó `AUTH_SIGNUP_ENABLED=true` por env (pensado para
 * stacks de dev/E2E), el registro queda abierto para TODOS los tenants sin
 * importar este interruptor — se avisa en el texto, sin poder comprobarlo
 * dinámicamente desde aquí (es una decisión de instancia, no de tenant).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { tenantSettingsApi } from '@/lib/tenant-settings';

const SCOPE = 'auth';
const KEY = 'signup';

export function SignupPolicyCard() {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await tenantSettingsApi.get(SCOPE, KEY);
        if (cancelled) return;
        setEnabled(Boolean((detail.value as { enabled?: boolean } | null)?.enabled));
      } catch (err) {
        if (cancelled) return;
        // 404 = todavía no configurado → default cerrado, no es un error.
        if (!(err instanceof ApiHttpError && err.status === 404)) {
          setError(apiErrorMessage(err, tErrors));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleToggle(next: boolean): Promise<void> {
    const prev = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      await tenantSettingsApi.upsert(SCOPE, KEY, { value: { enabled: next }, isSecret: false });
    } catch (err) {
      setEnabled(prev);
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('signupPolicy.title')}</CardTitle>
        <CardDescription>
          {t.rich('signupPolicy.description', {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2/40 p-3">
          <div>
            <p className="text-sm font-medium">{t('signupPolicy.toggleTitle')}</p>
            <p className="text-xs text-text-subtle">
              {t.rich('signupPolicy.toggleHint', {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
          </div>
          <Switch
            id="signup-enabled"
            checked={enabled}
            onCheckedChange={(checked) => void handleToggle(checked)}
            disabled={loading || saving}
            label={t('signupPolicy.switchLabel')}
          />
        </div>
      </CardContent>
    </Card>
  );
}
