'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { consumeIntendedPath } from '@/lib/post-login-redirect';

interface SetupResponse {
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

interface EnableResponse {
  enabled: boolean;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

/**
 * Flujo de alta de MFA (QR + recovery codes + confirmación del código).
 * Reutilizable en dos contextos:
 *  - Página `/mfa/setup` (login forzado por rol): sin `onDone` → al activar
 *    navega a `/`.
 *  - Modal "Configurar MFA" del perfil: con `onDone` → al activar lo invoca
 *    (cerrar modal + refrescar) en vez de navegar.
 */
export function MfaSetupFlow({ onDone }: { onDone?: () => void }) {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let aborted = false;
    async function loadSetup() {
      try {
        const access = authStorage.getAccessToken();
        if (!access) {
          router.replace('/signin');
          return;
        }
        const response = await apiFetch<SetupResponse>(
          '/api/v1/auth/mfa/setup',
          { method: 'POST', body: '{}' },
          access,
        );
        if (!aborted) setSetup(response);
      } catch (e) {
        if (!aborted) {
          setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('mfa.setupError'));
        }
      }
    }
    void loadSetup();
    return () => {
      aborted = true;
    };
  }, [router]);

  async function onConfirm(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const access = authStorage.getAccessToken();
      if (!access) {
        router.replace('/signin');
        return;
      }
      const response = await apiFetch<EnableResponse>(
        '/api/v1/auth/mfa/enable',
        { method: 'POST', body: JSON.stringify({ code: String(form.get('code')) }) },
        access,
      );
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      if (onDone) onDone();
      // Rama de login (sin onDone): cierra el circuito del deep link pendiente,
      // igual que mfa-verify-form. En el modal del perfil no aplica.
      else router.push(consumeIntendedPath() ?? '/');
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('mfa.confirmError'));
    } finally {
      setPending(false);
    }
  }

  if (error && !setup) {
    return (
      <p role="alert" className="text-sm text-danger-700">
        {error}
      </p>
    );
  }

  if (!setup) {
    return <p className="text-sm text-text-subtle">{t('mfa.generating')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3">
        <Image
          src={setup.qrCodeDataUrl}
          alt={t('mfa.qrAlt')}
          width={192}
          height={192}
          unoptimized
          className="rounded-md border border-border"
        />
        <details className="text-xs text-text-subtle">
          <summary className="cursor-pointer">{t('mfa.otpauthManual')}</summary>
          <code className="mt-2 block break-all rounded bg-surface-2 p-2">{setup.otpauthUrl}</code>
        </details>
      </div>

      <div className="rounded-md border border-warning-200 bg-warning-50 p-3 text-xs text-warning-800">
        <p className="font-semibold">{t('mfa.recoveryTitle')}</p>
        <p className="mt-1">{t('mfa.recoveryDesc')}</p>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
          {setup.recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>

      <form action={onConfirm} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="code">{t('mfa.codeLabel')}</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            required
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? t('mfa.verifying') : t('mfa.confirmCta')}
        </Button>
      </form>
    </div>
  );
}
