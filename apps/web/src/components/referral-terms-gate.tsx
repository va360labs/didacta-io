'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { REFERRAL_TERMS_PATH, referralsApi } from '@/lib/referrals';

/**
 * Casilla de entrada al programa: «Declaro que soy mayor de 18 años y acepto
 * las condiciones del programa», con enlace a las condiciones públicas del
 * aula. Sin marcarla el botón no se activa; al aceptar se guardan la versión y
 * la fecha (`POST /modules/referrals/me/terms`) y el alumno ya tiene enlace.
 */
export function ReferralTermsGate({
  version,
  onAccepted,
}: {
  /** Versión vigente de las condiciones (la que el alumno tiene delante). */
  version: string;
  onAccepted: () => void;
}) {
  const t = useTranslations('referidosCondiciones.casilla');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function accept() {
    if (!checked) return;
    setBusy(true);
    setError(false);
    try {
      await referralsApi.acceptTerms(version);
      onAccepted();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-5 rounded-xl border border-border bg-bg-subtle/60 p-4"
      data-testid="referidos-casilla"
    >
      <p className="text-sm text-text-muted">{t('aviso')}</p>
      <div className="mt-3 flex items-start gap-3">
        <input
          id="referidos-acepto"
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-brand-600"
        />
        <label htmlFor="referidos-acepto" className="cursor-pointer text-[15px] text-text">
          {t('texto')}{' '}
          <Link
            href={REFERRAL_TERMS_PATH}
            target="_blank"
            className="font-semibold text-brand-600 hover:underline"
          >
            {t('verCondiciones')}
          </Link>
        </label>
      </div>
      <button
        type="button"
        onClick={() => void accept()}
        disabled={!checked || busy}
        className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <Icon name="link" size={16} />
        {busy ? t('activando') : t('activar')}
      </button>
      {error ? (
        <p className="mt-2 text-sm text-danger-700" role="alert">
          {t('error')}
        </p>
      ) : null}
    </div>
  );
}
