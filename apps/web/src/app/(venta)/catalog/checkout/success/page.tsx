'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Retorno del pago de un curso suelto (comprador anónimo o con sesión), tanto
 * del redirect a Stripe como del pago embebido en la ficha.
 *
 * Pregunta a la API por la sesión (`session_id`) y enseña el resumen de la
 * compra —qué curso, cuánto, cuándo— y el siguiente paso («Entrar al curso»).
 * Solo dice «gracias» si el pago consta: con el pago embebido se vuelve aquí
 * también si un medio con redirección falla. El acceso NO se concede aquí: lo
 * hace el webhook (cuenta + matrícula vía `billing.order.completed`).
 *
 * El id de la sesión de Stripe no se enseña.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PurchaseThanks, type ThanksSummary } from '@/components/checkout/purchase-thanks';
import { authStorage } from '@/lib/auth-storage';
import {
  checkoutOutcome,
  getCourseCheckoutSession,
  isCheckoutSessionId,
  type CheckoutOutcome,
  type CourseCheckoutSessionView,
} from '@/lib/checkout';

function SuccessContent() {
  const params = useSearchParams();
  const sessionId = params.get('session_id');
  const embedded = params.get('checkout') === 'embedded';
  const signedIn = useMemo(() => authStorage.getSession() !== null, []);
  const [view, setView] = useState<CourseCheckoutSessionView | null | undefined>(undefined);

  useEffect(() => {
    if (!isCheckoutSessionId(sessionId)) {
      setView(null);
      return;
    }
    let alive = true;
    getCourseCheckoutSession(sessionId)
      .then((v) => alive && setView(v))
      .catch(() => alive && setView(null));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  let outcome: CheckoutOutcome | 'checking';
  if (view === undefined) outcome = 'checking';
  else if (view === null) {
    // Sin poder comprobarlo: con el redirect, llegar aquí ya era cobrar; con el
    // embebido no, y entonces no se afirma nada.
    outcome = embedded ? 'unknown' : 'paid';
  } else outcome = checkoutOutcome(view);

  const summary: ThanksSummary | null = view
    ? {
        kind: 'course',
        title: view.course?.title ?? null,
        imageUrl: view.course?.thumbnailUrl ?? null,
        amount: view.amount,
        currency: view.currency,
        at: view.at,
      }
    : null;
  const slug = view?.course?.slug ?? null;

  return (
    <PurchaseThanks
      outcome={outcome}
      summary={summary}
      signedIn={signedIn}
      nextPath={slug ? `/courses/${encodeURIComponent(slug)}` : '/courses'}
      retryHref={slug ? `/catalog/${encodeURIComponent(slug)}` : '/catalog'}
    />
  );
}

export default function PublicCheckoutSuccessPage() {
  // Suspense necesario porque `useSearchParams` requiere boundary en App Router.
  return (
    <Suspense fallback={<div className="skeleton mx-auto h-64 w-full max-w-xl rounded-3xl" />}>
      <SuccessContent />
    </Suspense>
  );
}
