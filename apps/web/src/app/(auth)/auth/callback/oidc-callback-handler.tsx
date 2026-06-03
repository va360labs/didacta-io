'use client';

/**
 * Cliente que cierra el flow OIDC en el browser. Lee tokens + datos del user
 * del query string y los persiste vía authStorage (mismo storage que el flow
 * password-based).
 *
 * Por qué pasamos los datos por query string:
 *   El backend NO puede setear localStorage (vive en el navegador del usuario).
 *   La alternativa sería cookies httpOnly, pero el resto del cliente HTTP de
 *   Didacta usa Bearer tokens en headers (apiFetch) — usar cookies aquí
 *   forzaría una rama distinta. El query string queda en la barra del navegador
 *   por una fracción de segundo, pero (a) usamos history.replaceState para
 *   limpiarlo de inmediato, (b) el accessToken es de corta duración, (c) email
 *   ya queda en navegación normal cuando uno hace signin.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { authStorage } from '@/lib/auth-storage';

export function OidcCallbackHandler() {
  const router = useRouter();
  const params = useSearchParams();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken');
    const userId = params.get('userId');
    const email = params.get('email');
    const tenantId = params.get('tenantId');
    const tenantSlug = params.get('tenantSlug');
    const rolesCsv = params.get('roles');
    const name = params.get('name');
    const mfaEnabledRaw = params.get('mfaEnabled');

    if (!accessToken || !refreshToken || !userId || !email || !tenantId || !tenantSlug) {
      setErrorMessage('Faltan datos en el callback. Reintenta iniciar sesión.');
      router.replace('/auth/error?reason=missing_tokens');
      return;
    }

    // Guardamos tokens.
    authStorage.saveTokens(accessToken, refreshToken);

    // Reconstruimos StoredSession con el shape que usa el resto del cliente.
    authStorage.saveSession({
      user: {
        id: userId,
        email,
        name: name && name.trim().length > 0 ? name : null,
        tenantId,
        tenantSlug,
        roles: rolesCsv ? rolesCsv.split(',').filter((r) => r.length > 0) : [],
        mfaEnabled: mfaEnabledRaw === 'true',
      },
      // SSO ya pasó MFA en el IdP — no exigimos paso adicional.
      mfaRequired: false,
    });

    // Limpiamos los datos sensibles de la barra de URL antes de redirigir.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/auth/callback');
    }

    router.replace('/');
  }, [params, router]);

  if (errorMessage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">No pudimos completar el inicio</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-danger-700">{errorMessage}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Iniciando sesión…</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
          <p className="text-sm text-text-muted">
            Recibimos tu autorización del IdP, ya casi estás dentro.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
