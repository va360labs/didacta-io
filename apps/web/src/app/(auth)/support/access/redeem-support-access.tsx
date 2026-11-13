'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { supportAccessApi } from '@/lib/support-access';

/**
 * Canjea el token del enlace y entra.
 *
 * Dos cosas que no son gratuitas:
 *
 * - **El canje se dispara solo, una vez.** El token es de un solo uso: un
 *   segundo intento por un re-render de React lo quemaría y dejaría fuera a
 *   quien acaba de abrirlo. De ahí el `ref`, que sobrevive al StrictMode del
 *   modo desarrollo (que monta cada efecto dos veces a propósito).
 *
 * - **La sesión va a `sessionStorage`** (`remember: false`). Un acceso de
 *   soporte dura minutos y se abre a menudo desde un portátil que no es el de
 *   uno; no tiene ningún sentido que sobreviva al cierre de la pestaña.
 */
export function RedeemSupportAccess() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [error, setError] = useState<string | null>(null);
  const yaCanjeado = useRef(false);

  useEffect(() => {
    if (!token) {
      setError(t('supportAccess.missingToken'));
      return;
    }
    if (yaCanjeado.current) return;
    yaCanjeado.current = true;

    void supportAccessApi
      .redeem(token)
      .then((res) => {
        // Sin refresh token: la sesión de soporte no se renueva. Cuando el
        // access caduca, `apiFetch` no encuentra refresh y manda a /signin,
        // que es exactamente lo que debe pasar al agotarse la ventana.
        authStorage.saveTokens(res.accessToken, '', false);
        authStorage.saveSession(
          {
            user: {
              id: res.user.id,
              email: res.user.email,
              name: res.user.name,
              tenantId: res.user.tenantId,
              tenantSlug: res.user.tenantSlug,
              roles: res.user.roles,
              mfaEnabled: false,
              // El asistente de bienvenida no puede cruzarse en mitad de un
              // incidente: el usuario de soporte nace con el onboarding hecho.
              onboardingCompletedAt: new Date().toISOString(),
            },
            mfaRequired: false,
            support: { grantId: res.grantId, reason: res.reason, expiresAt: res.expiresAt },
          },
          false,
        );
        router.replace('/home');
      })
      .catch((e: unknown) => setError(apiErrorMessage(e, tErrors)));
    // Se ejecuta una sola vez con el token de la URL; el `ref` protege del
    // doble montaje de StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
      >
        <p className="font-semibold">{t('supportAccess.failedTitle')}</p>
        <p className="mt-1">{error}</p>
      </div>
    );
  }

  return (
    <p role="status" className="text-sm text-text-muted">
      {t('supportAccess.working')}
    </p>
  );
}
