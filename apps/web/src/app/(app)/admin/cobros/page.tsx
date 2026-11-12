'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Administración → Ingresos → Cobros (solo en modo plataforma: Didacta Cloud).
 *
 * Una única puerta a los cobros por instalación, para no duplicar caminos:
 *
 *  - Modo plataforma: aquí se conectan los cobros, y la pestaña «Pagos» de
 *    Configuración (pegar claves de Stripe) desaparece y redirige aquí.
 *  - Community (sin modo plataforma): esta ruta no está en el menú y, si se
 *    abre a mano, redirige a Configuración → Pagos, que no cambia nada.
 *
 * Stripe devuelve aquí al terminar el alta (`?vuelta=1`) y cuando el enlace
 * del alta caducó (`?renovar=1`).
 *
 * Debajo, «Tus ventas»: cada venta con lo que te llega y cuándo, y el resumen
 * por moneda.
 */

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PaymentsConnectCard } from '@/components/admin/payments-connect-card';
import { PayoutsSalesSection } from '@/components/admin/payouts-sales-section';

export default function CobrosPage(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnAction =
    searchParams?.get('vuelta') === '1'
      ? 'sync'
      : searchParams?.get('renovar') === '1'
        ? 'renew'
        : null;

  const toLegacyPayments = useCallback(() => {
    router.replace('/admin/configuracion?tab=pagos');
  }, [router]);
  const clearQuery = useCallback(() => {
    router.replace('/admin/cobros');
  }, [router]);

  return (
    <div className="max-w-5xl space-y-10">
      <div className="max-w-3xl">
        <PaymentsConnectCard
          asPage
          whenPlatformOff={null}
          onPlatformUnavailable={toLegacyPayments}
          returnAction={returnAction}
          onReturnHandled={clearQuery}
        />
      </div>
      <PayoutsSalesSection />
    </div>
  );
}
