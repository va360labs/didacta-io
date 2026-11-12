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
 */

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PaymentsConnectCard } from '@/components/admin/payments-connect-card';

export default function CobrosPage(): React.JSX.Element {
  const t = useTranslations('adminPagos.payouts');
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
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('title')}</h1>
      </header>
      <div className="max-w-3xl">
        <PaymentsConnectCard
          whenPlatformOff={null}
          onPlatformUnavailable={toLegacyPayments}
          returnAction={returnAction}
          onReturnHandled={clearQuery}
        />
      </div>
    </div>
  );
}
