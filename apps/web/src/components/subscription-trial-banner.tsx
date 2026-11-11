'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Franja de la prueba gratis, arriba del todo, en todas las pantallas del aula.
///
/// Tres decisiones deliberadas:
///
/// - **Solo la ven quienes pueden decidir** (`super_admin` / `tenant_admin`). A
///   un alumno no le sirve de nada saber que la academia está en prueba, y el
///   enlace de pago no es suyo: la API ni siquiera se lo manda.
///
/// - **Tono de marca, no de aviso.** Lleva el color del aula en su versión más
///   suave, no el ámbar de las averías ni el rojo del acceso de soporte: una
///   prueba en curso no es un problema que haya que arreglar.
///
/// - **Sin variante oscura.** El shell del aula es claro aunque el sistema esté
///   en oscuro; una franja oscura en medio quedaba como un parche gris.
///
/// - **Una sola línea.** Roba alto en todas las pantallas durante siete días;
///   con el texto recortado si no cabe, y el botón siempre entero.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { authStorage } from '@/lib/auth-storage';
import {
  administraAcademia,
  fetchMyGate,
  safeActionUrl,
  trialDaysLeft,
} from '@/lib/subscription-gate';

interface Trial {
  daysLeft: number;
  actionUrl: string;
}

export function SubscriptionTrialBanner({ roles }: { roles: readonly string[] }) {
  const t = useTranslations('shell.subscriptionGate.trialBanner');
  const [trial, setTrial] = useState<Trial | null>(null);
  const puede = administraAcademia(roles);

  useEffect(() => {
    if (!puede) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    let cancelado = false;
    void fetchMyGate(token).then((gate) => {
      if (cancelado || !gate || gate.state !== 'TRIAL' || !gate.trialEndsAt) return;
      const actionUrl = safeActionUrl(gate.actionUrl);
      const daysLeft = trialDaysLeft(gate.trialEndsAt);
      // Vencida: la pausa la pinta `SubscriptionGate` en cuanto la API conteste
      // 402. Aquí no se anuncian «0 días».
      if (!actionUrl || daysLeft <= 0) return;
      setTrial({ daysLeft, actionUrl });
    });
    return () => {
      cancelado = true;
    };
  }, [puede]);

  if (!trial) return null;

  return (
    <div
      role="status"
      data-testid="subscription-trial-banner"
      className="flex items-center justify-center gap-3 border-b border-brand-100 bg-brand-50 px-4 py-1.5 text-[13px] text-brand-800"
    >
      <p className="flex min-w-0 items-center gap-2">
        <Icon name="clock" size={15} aria-hidden="true" className="shrink-0 text-brand-500" />
        <span className="truncate">
          <strong className="font-semibold">{t('label')}</strong>
          <span aria-hidden="true" className="px-1.5 text-brand-400">
            ·
          </span>
          <span className="tabular-nums">{t('daysLeft', { days: trial.daysLeft })}</span>
        </span>
      </p>
      <a
        href={trial.actionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand-300 bg-white px-2.5 py-1 font-semibold text-brand-700 transition-colors duration-150 hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-50 sm:py-0.5"
      >
        {t('cta')}
        <Icon name="arrow-right" size={13} aria-hidden="true" className="-rotate-45" />
        <span className="sr-only">{t('newTab')}</span>
      </a>
    </div>
  );
}
