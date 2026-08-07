'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Página de retorno tras un Stripe Checkout exitoso.
 *
 * Stripe redirige aquí cuando configuramos `success_url` apuntando a
 * `${origin}/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}`. La
 * matriculación efectiva la hace `mod.learning` cuando recibe el evento
 * `billing.order.completed` que emite `mod.billing` desde su webhook
 * `checkout.session.completed`. Por eso aquí NO confirmamos contra el API:
 * sólo damos feedback visual y dejamos que el alumno vaya a "Mis cursos"
 * para ver el curso ya activo.
 *
 * Si la matriculación todavía no apareció (race con el webhook de Stripe),
 * la lista de "Mis cursos" la mostrará en cuanto se procese — el alumno
 * sólo tiene que refrescar.
 *
 * `session_id` lo leemos para mostrarlo discretamente como referencia de
 * soporte; no lo usamos para nada más.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

function SuccessContent() {
  const params = useSearchParams();
  const sessionId = params.get('session_id');
  const t = useTranslations('alumnoAprendizaje');

  return (
    <section className="mx-auto max-w-2xl space-y-6 py-10">
      <Card>
        <CardContent className="flex flex-col items-center gap-5 p-10 text-center">
          <span
            aria-hidden="true"
            className="grid h-16 w-16 place-items-center rounded-full"
            style={{
              background: 'var(--didacta-success-bg)',
              color: 'var(--didacta-success-fg)',
            }}
          >
            <Icon name="check" size={32} />
          </span>
          <div className="space-y-2">
            <h1 className="font-display text-2xl font-bold tracking-tight text-text">
              {t('purchaseThanks')}
            </h1>
            <p className="text-text-muted">{t('purchaseThanksBody')}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Button asChild size="lg">
              <Link href="/cursos">{t('goToMyCourses')}</Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link href="/mis-certificados">{t('viewMyCertificates')}</Link>
            </Button>
          </div>
          {sessionId ? (
            <p className="pt-4 text-xs text-text-subtle">
              {t.rich('paymentReference', {
                id: sessionId,
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

export default function CheckoutSuccessPage() {
  // Suspense necesario porque `useSearchParams` requiere boundary en App Router.
  return (
    <Suspense
      fallback={
        <section className="mx-auto max-w-2xl py-10">
          <div className="skeleton h-64 w-full" />
        </section>
      }
    >
      <SuccessContent />
    </Suspense>
  );
}
