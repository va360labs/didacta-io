'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { completeSignIn, signInWithPassword } from '@/lib/complete-signin';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { rememberIntendedPath, sanitizeInternalPath } from '@/lib/post-login-redirect';

/** Estado del enlace según la API (`POST /auth/reset-password/status`). */
type LinkStatus = 'checking' | 'valid' | 'expired' | 'used' | 'invalid';

interface ResetResponse {
  ok: boolean;
  message: string;
  /** Correo GUARDADO de la cuenta: con él se entra sin volver a escribirlo. */
  email?: string;
  tenantSlug?: string | null;
}

/**
 * «Elige tu contraseña»: el enlace de primer acceso (bienvenida de la creadora,
 * alta tras compra, invitación) y el de restablecer.
 *
 *  - Al abrirse pregunta si el enlace sigue vivo: con uno caducado no se hace
 *    teclear una contraseña para nada, y se ofrece otro con un clic.
 *  - Al guardar ENTRA sola con la contraseña recién elegida (antes mandaba a
 *    «Bienvenido de nuevo» con el correo en blanco), y si el enlace traía
 *    destino (`?next=`, el curso que se acaba de comprar) acaba ahí.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const searchParams = useSearchParams();
  const token = searchParams?.get('token') ?? '';
  const rawNext = searchParams?.get('next') ?? null;
  const [status, setStatus] = useState<LinkStatus>(token ? 'checking' : 'invalid');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [resend, setResend] = useState<'idle' | 'pending' | 'done'>('idle');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<{ status: Exclude<LinkStatus, 'checking'> }>('/api/v1/auth/reset-password/status', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((r) => !cancelled && setStatus(r.status))
      // Si la comprobación falla (red), se deja intentar: el guardado dirá
      // lo que pase con el enlace.
      .catch(() => !cancelled && setStatus('valid'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <div role="alert" className="rounded-lg border border-danger-100 bg-danger-50 p-4">
        <h4 className="font-semibold text-danger-700">{t('reset.missingTokenTitle')}</h4>
        <p className="mt-1 text-sm text-text">{t('reset.missingTokenBody')}</p>
      </div>
    );
  }

  async function requestNewLink() {
    setResend('pending');
    try {
      await apiFetch('/api/v1/auth/reset-password/resend', {
        method: 'POST',
        body: JSON.stringify({ token, ...(rawNext ? { next: rawNext } : {}) }),
      });
    } catch {
      /* respuesta genérica: se dice lo mismo pase lo que pase */
    }
    setResend('done');
  }

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);

    const newPassword = String(form.get('newPassword'));
    const confirm = String(form.get('confirm'));

    if (newPassword !== confirm) {
      setError(t('reset.passwordsMismatch'));
      setPending(false);
      return;
    }
    if (newPassword.length < 12) {
      setError(t('reset.passwordTooShort'));
      setPending(false);
      return;
    }

    let account: ResetResponse;
    try {
      account = await apiFetch<ResetResponse>('/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
    } catch (e) {
      if (e instanceof ApiHttpError && e.code === 'AUTH_RESET_LINK_EXPIRED') setStatus('expired');
      else if (e instanceof ApiHttpError && e.code === 'AUTH_RESET_LINK_USED') setStatus('used');
      else
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('reset.submitError'));
      setPending(false);
      return;
    }

    setDone(true);
    // Destino tras entrar (el curso comprado). Se guarda como cualquier deep
    // link: el perfil de primer acceso lo consume al terminar.
    const next = sanitizeInternalPath(rawNext);
    if (next) rememberIntendedPath(next);
    const email = account.email ?? '';
    try {
      const session = await signInWithPassword({
        tenantSlug: account.tenantSlug ?? undefined,
        email,
        password: newPassword,
      });
      router.replace(completeSignIn(session, true));
    } catch {
      // No pudo entrar sola (cuenta pendiente de aprobación, red…): al acceso
      // con el correo ya escrito.
      router.replace(email ? `/signin?email=${encodeURIComponent(email)}` : '/signin');
    }
  }

  if (done) {
    return (
      <div role="status" className="rounded-lg border border-success-200 bg-success-50 p-4">
        <h4 className="font-semibold text-success-700">{t('reset.doneTitle')}</h4>
        <p className="mt-1 text-sm text-text">{t('reset.doneSigningIn')}</p>
      </div>
    );
  }

  if (status === 'checking') {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="skeleton h-12 w-full" />
        <div className="skeleton h-12 w-full" />
        <div className="skeleton h-12 w-full" />
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-warning-200 bg-warning-50 p-4"
        data-testid="enlace-caducado"
      >
        <div>
          <h4 className="font-semibold text-warning-700">{t('reset.expiredTitle')}</h4>
          <p className="mt-1 text-sm text-text">{t('reset.expiredBody')}</p>
        </div>
        {resend === 'done' ? (
          <p role="status" className="text-sm font-semibold text-success-700">
            {t('reset.resendDone')}
          </p>
        ) : (
          <Button
            type="button"
            onClick={() => void requestNewLink()}
            disabled={resend === 'pending'}
            className="w-full"
            data-testid="pedir-enlace-nuevo"
          >
            {resend === 'pending' ? t('reset.resendPending') : t('reset.resendCta')}
          </Button>
        )}
      </div>
    );
  }

  if (status === 'used' || status === 'invalid') {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-border-soft bg-surface-2 p-4">
        <div>
          <h4 className="font-semibold text-text">
            {status === 'used' ? t('reset.usedTitle') : t('reset.invalidTitle')}
          </h4>
          <p className="mt-1 text-sm text-text-muted">
            {status === 'used' ? t('reset.usedBody') : t('reset.missingTokenBody')}
          </p>
        </div>
        {status === 'used' ? (
          <Button asChild className="w-full">
            <Link href="/signin">{t('reset.signInCta')}</Link>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="newPassword">{t('reset.newPasswordLabel')}</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="h-12"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm">{t('reset.confirmPasswordLabel')}</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="h-12"
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} size="lg" className="h-13 w-full">
        {pending ? t('reset.submitPending') : t('reset.submit')}
      </Button>
    </form>
  );
}
