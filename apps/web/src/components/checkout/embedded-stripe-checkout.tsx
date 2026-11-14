'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El formulario de pago de Stripe pintado DENTRO de la página del aula.
 *
 * Debajo no hay ningún campo nuestro: es la Checkout Session de siempre con
 * `ui_mode: 'embedded'`, en un iframe de Stripe. Los datos de la tarjeta nunca
 * tocan nuestro dominio (el alcance PCI es el mismo que con el redirect) y la
 * entrega cuelga del mismo `checkout.session.completed`. Al completarse, Stripe
 * lleva al comprador a la `return_url` (la pantalla de gracias), que PREGUNTA
 * si se cobró antes de decir nada.
 *
 * Stripe.js se carga bajo demanda (`import()` dentro del efecto): pesa, y no
 * tiene por qué cargarse en la ficha de quien todavía no ha decidido comprar.
 * Stripe solo admite un pago embebido a la vez: el anterior se destruye antes
 * de montar otro (el doble montaje de desarrollo, o volver y pagar otra vez).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';

interface Props {
  clientSecret: string;
  publishableKey: string;
  /**
   * El pago no se puede pintar aquí (Stripe.js bloqueado, sin red…): la página
   * ofrece abrirlo en la página de Stripe.
   */
  onUnavailable?: () => void;
}

interface Mounted {
  destroy(): void;
}

/** El pago embebido vivo (Stripe no admite dos a la vez). */
let live: Promise<Mounted | null> = Promise.resolve(null);

type State = 'loading' | 'ready' | 'error';

export function EmbeddedStripeCheckout({ clientSecret, publishableKey, onUnavailable }: Props) {
  const t = useTranslations('publicSite.pago');
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const previous = live;
    const mounting: Promise<Mounted | null> = (async () => {
      (await previous)?.destroy();
      if (cancelled) return null;
      try {
        const { loadStripe } = await import('@stripe/stripe-js');
        const stripe = await loadStripe(publishableKey);
        if (!stripe) throw new Error('Stripe.js no cargó');
        const checkout = await stripe.createEmbeddedCheckoutPage({ clientSecret });
        if (cancelled || !host.current) {
          checkout.destroy();
          return null;
        }
        checkout.mount(host.current);
        setState('ready');
        return checkout;
      } catch {
        if (!cancelled) setState('error');
        return null;
      }
    })();
    live = mounting;
    return () => {
      cancelled = true;
      void mounting.then((checkout) => checkout?.destroy());
    };
  }, [clientSecret, publishableKey]);

  return (
    <div
      data-testid="pago-embebido"
      data-state={state}
      className={state === 'loading' ? 'relative min-h-[420px]' : 'relative'}
    >
      {state === 'loading' ? (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface text-sm text-text-muted"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="h-6 w-6 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600"
          />
          {t('loading')}
        </div>
      ) : null}
      {state === 'error' ? (
        <div
          role="alert"
          className="flex min-h-[240px] flex-col items-start justify-center gap-3 rounded-xl border border-danger-500/30 bg-danger-50 p-5 text-sm text-danger-700"
          data-testid="pago-embebido-error"
        >
          <span className="inline-flex items-center gap-2 font-semibold">
            <Icon name="alert" size={16} />
            {t('loadError')}
          </span>
          {onUnavailable ? (
            <button
              type="button"
              onClick={onUnavailable}
              className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 font-semibold text-white hover:bg-brand-700"
            >
              {t('openInStripe')}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Stripe monta aquí su iframe; mientras carga lo tapa el aviso de arriba. */}
      <div ref={host} className={state === 'error' ? 'hidden' : ''} />
    </div>
  );
}
