'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Botón promo del programa de referidos en la cabecera del shell.
///
/// Dorado con borde de brillo giratorio (ver .referral-promo-ring en
/// globals.css). Solo se muestra si el programa está ACTIVO para el tenant y
/// el % que anuncia es el REAL de la config (regla #3: cero datos inventados).
/// Enlaza al área del miembro /referidos.

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { referralsApi } from '@/lib/referrals';

export function ReferralsPromoButton() {
  const t = useTranslations('cuentaComponentes');
  const [percent, setPercent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    try {
      referralsApi
        .myStats()
        .then((s) => {
          if (cancelled || !s.programActive) return;
          setPercent((s.commissionBps / 100).toFixed(s.commissionBps % 100 === 0 ? 0 : 2));
        })
        .catch(() => {
          // Programa no disponible / sin permiso: la cabecera queda como está.
        });
    } catch {
      // Sin sesión (withAuth lanza síncrono): sin botón.
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (percent === null) return null;

  return (
    <Link
      href="/referidos"
      data-testid="referrals-promo-button"
      className="referral-promo-ring hidden shrink-0 sm:inline-flex"
      aria-label={t('referrals.promoAria', { percent })}
    >
      <span className="referral-promo-core">{t('referrals.promoCta', { percent })}</span>
    </Link>
  );
}
