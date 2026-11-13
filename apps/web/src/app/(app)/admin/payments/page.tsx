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
 * Debajo, «Tus datos fiscales» (factura y DAC7), «Tus ventas» (cada venta
 * con lo que te llega y cuándo, y el resumen por moneda) y «Tus facturas» (la
 * factura mensual de la comisión).
 */

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PaymentsConnectCard } from '@/components/admin/payments-connect-card';
import { PayoutsInvoicesSection } from '@/components/admin/payouts-invoices-section';
import { PayoutsSalesSection } from '@/components/admin/payouts-sales-section';
import { PayoutsTaxProfileCard } from '@/components/admin/payouts-tax-profile-card';
import { SimpleSales } from '@/components/simple-ventas/simple-sales';
import { useSimpleMode } from '@/lib/simple-mode';

/**
 * Modo sencillo: «Ventas» (lo vendido, el enlace, el precio y los referidos).
 * La vista de siempre sigue en la misma ruta con `?completo=1`, y es la única
 * en modo completo.
 */
export default function CobrosPage(): React.JSX.Element | null {
  const simple = useSimpleMode();
  const router = useRouter();
  const searchParams = useSearchParams();
  const clearQuery = useCallback(() => {
    router.replace('/admin/payments');
  }, [router]);
  if (simple === null) return null;
  if (simple && searchParams?.get('completo') !== '1') {
    const returnAction =
      searchParams?.get('vuelta') === '1'
        ? 'sync'
        : searchParams?.get('renovar') === '1'
          ? 'renew'
          : null;
    return (
      <SimpleSales
        mode="platform"
        completeHref="/admin/payments?completo=1"
        returnAction={returnAction}
        onReturnHandled={clearQuery}
      />
    );
  }
  return <CobrosCompleto />;
}

function CobrosCompleto(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnAction =
    searchParams?.get('vuelta') === '1'
      ? 'sync'
      : searchParams?.get('renovar') === '1'
        ? 'renew'
        : null;

  const toLegacyPayments = useCallback(() => {
    router.replace('/admin/settings?tab=pagos');
  }, [router]);
  const clearQuery = useCallback(() => {
    router.replace('/admin/payments');
  }, [router]);
  // Al guardar los datos fiscales se liberan ventas retenidas y pueden salir
  // facturas que los sustituyen: se recargan las dos secciones.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

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
      <div className="max-w-3xl">
        <PayoutsTaxProfileCard onSaved={refresh} />
      </div>
      <PayoutsSalesSection key={`ventas-${refreshKey}`} />
      <PayoutsInvoicesSection refreshKey={refreshKey} />
    </div>
  );
}
