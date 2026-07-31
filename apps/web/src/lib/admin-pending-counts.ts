'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Contadores de "cosas que esperan al admin", para los badges del sidebar del
 * área de administración.
 *
 * Sin esto el sidebar es un índice: hay que entrar en cada pantalla para
 * descubrir si hay algo que hacer. Con el badge, el menú se mira.
 *
 * Ambos números salen de endpoints que YA existen y que las propias pantallas
 * consumen — no hay backend nuevo ni conteo inventado:
 *   - Solicitudes: `GET /api/v1/inscripcion-admin/requests` devuelve solo las
 *     PENDING, así que el badge es su longitud.
 *   - Impagos: `GET /api/v1/inscripcion/payment-flags?delinquentOnly=true`.
 *
 * Los fallos se tragan a propósito: un badge es información accesoria y no debe
 * romper la navegación si el módulo está apagado para el tenant (404) o el
 * token acaba de expirar (401). Sin dato → sin badge.
 */

import { useEffect, useState } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { listMemberRequests } from '@/lib/inscripcion';
import { paymentFlagsApi } from '@/lib/payment-flags';

export interface AdminPendingCounts {
  /** Solicitudes de inscripción esperando aprobación manual. */
  memberRequests: number;
  /** Miembros marcados como impagos ahora mismo. */
  arrears: number;
}

const EMPTY: AdminPendingCounts = { memberRequests: 0, arrears: 0 };

/**
 * Refresco cada 2 minutos: son cifras de trabajo pendiente, no un tiempo real.
 * Un intervalo más corto añadiría dos llamadas por minuto a cada admin sin que
 * el número cambie casi nunca.
 */
const REFRESH_MS = 120_000;

/**
 * @param enabled Solo se consulta dentro del área admin. Fuera de ahí estos
 *   badges no se pintan, así que pedirlos sería gasto puro.
 */
export function useAdminPendingCounts(enabled: boolean): AdminPendingCounts {
  const [counts, setCounts] = useState<AdminPendingCounts>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setCounts(EMPTY);
      return;
    }
    let cancelled = false;

    async function load(): Promise<void> {
      const token = authStorage.getAccessToken();
      if (!token) return;

      const [requests, arrears] = await Promise.all([
        listMemberRequests(token)
          .then((r) => r.length)
          .catch(() => null),
        paymentFlagsApi
          .list(token, { delinquentOnly: true })
          .then((r) => r.length)
          .catch(() => null),
      ]);
      if (cancelled) return;
      // `null` = la llamada falló: conservamos el valor anterior en vez de
      // pintar un 0 que diría "no hay nada pendiente" sin saberlo.
      setCounts((prev) => ({
        memberRequests: requests ?? prev.memberRequests,
        arrears: arrears ?? prev.arrears,
      }));
    }

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return counts;
}
