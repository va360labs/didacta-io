'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Ir al alta alojada de Stripe desde UN botón, con el estado de carga a la vista.
 *
 * Crear la cuenta conectada y su enlace de alta tarda varios segundos (prueba
 * real del 14-nov-2026: 8 s de «Abriendo Stripe…» sin más señal, y el creador
 * volvió a pulsar). Mientras tanto:
 *
 *  - el botón se apaga y enseña un indicador que gira;
 *  - debajo, un aviso (`role="status"`) de que puede tardar unos segundos;
 *  - un segundo clic NO hace otra petición. El cerrojo es una ref y no el
 *    estado: dos clics en el mismo fotograma leen el estado de antes de pintar.
 *
 * Al recibir la URL se navega y el botón se queda apagado (la página se va).
 * Si falla, se suelta y se devuelve el error para que quien lo pinta lo cuente.
 */

import { useCallback, useRef, useState } from 'react';
import { payoutsApi, type PayoutsEntityType } from '@/lib/payouts';

/** Navegación a Stripe. Un objeto para poder sustituirla en las pruebas (jsdom no navega). */
export const payoutsNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};

/**
 * - `redirected`: saliendo hacia Stripe.
 * - `ready`: la cuenta ya estaba lista, no hay alta que abrir.
 * - `ignored`: ya había una petición en vuelo (doble clic).
 * - `failed`: con el error tal cual (quien lo pinta decide el texto).
 */
export type PayoutsRedirectOutcome =
  | { readonly kind: 'redirected' | 'ready' | 'ignored' }
  | { readonly kind: 'failed'; readonly error: unknown };

export interface PayoutsRedirect {
  /** Hay una petición en vuelo (o ya se está saliendo hacia Stripe). */
  busy: boolean;
  /** El último error (`null` sin error o al reintentar). */
  error: unknown;
  /** «Conectar cobros»: crea (o reutiliza) la cuenta y abre su alta. */
  connect(country: string, entityType: PayoutsEntityType): Promise<PayoutsRedirectOutcome>;
  /** «Seguir con el alta»: enlace nuevo a la misma cuenta. */
  finish(): Promise<PayoutsRedirectOutcome>;
}

export function usePayoutsRedirect(
  api: Pick<typeof payoutsApi, 'connect' | 'onboardingLink'> = payoutsApi,
): PayoutsRedirect {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (getUrl: () => Promise<string | null>): Promise<PayoutsRedirectOutcome> => {
      if (inFlight.current) return { kind: 'ignored' };
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const url = await getUrl();
        if (url) {
          payoutsNavigation.go(url);
          return { kind: 'redirected' };
        }
        inFlight.current = false;
        setBusy(false);
        return { kind: 'ready' };
      } catch (err) {
        inFlight.current = false;
        setBusy(false);
        setError(err);
        return { kind: 'failed', error: err };
      }
    },
    [],
  );

  const connect = useCallback(
    (country: string, entityType: PayoutsEntityType) =>
      run(async () => (await api.connect(country, entityType)).onboardingUrl),
    [api, run],
  );
  const finish = useCallback(() => run(async () => (await api.onboardingLink()).url), [api, run]);

  return { busy, error, connect, finish };
}

/** Indicador de «trabajando» para dentro de un botón. Quieto si se pide menos movimiento. */
export function ButtonSpinner(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="payouts-spinner"
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}
