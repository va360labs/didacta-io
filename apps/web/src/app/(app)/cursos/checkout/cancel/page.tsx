'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Página de retorno tras un Stripe Checkout cancelado.
 *
 * Stripe redirige aquí cuando el alumno cancela el pago en su hosted checkout.
 * No hubo cargo. La order quedó PENDING en mod.billing y el cron de purge la
 * cierra como CANCELLED si Stripe envía `checkout.session.expired` después.
 *
 * No mostramos errores ni alertamos: la cancelación es un acto deliberado
 * del usuario, no un fallo. Tono neutro y un CTA claro de vuelta al catálogo.
 */

import Link from 'next/link';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function CheckoutCancelPage() {
  return (
    <section className="mx-auto max-w-2xl space-y-6 py-10">
      <Card>
        <CardContent className="flex flex-col items-center gap-5 p-10 text-center">
          <span
            aria-hidden="true"
            className="grid h-16 w-16 place-items-center rounded-full"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="alert" size={32} />
          </span>
          <div className="space-y-2">
            <h1 className="font-display text-2xl font-bold tracking-tight text-text">
              Pago cancelado
            </h1>
            <p className="text-text-muted">
              No se realizó ningún cargo. Si quieres continuar, puedes volver al catálogo y
              reiniciar el pago en cualquier momento.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Button asChild size="lg">
              <Link href="/cursos">Volver al catálogo</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
