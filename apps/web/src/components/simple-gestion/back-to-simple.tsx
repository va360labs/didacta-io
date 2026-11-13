'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { authStorage } from '@/lib/auth-storage';
import { simpleModeApi, useSimpleMode } from '@/lib/simple-mode';

const ADMIN_ROLES = ['tenant_admin', 'super_admin'];

/**
 * «Volver al modo sencillo», en la configuración del modo COMPLETO. Ajustes
 * del modo sencillo promete «puedes volver cuando quieras» al pasar al
 * completo; hasta ahora no había por dónde. Solo lo ve quien administra el aula
 * (el servidor lo exige igual: `PUT /admin/simple-mode`).
 */
export function BackToSimpleModeCard() {
  const t = useTranslations('modoSencilloGestion.ajustes');
  const simple = useSimpleMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const isAdmin = (authStorage.getSession()?.user.roles ?? []).some((r) => ADMIN_ROLES.includes(r));
  if (simple !== false || !isAdmin) return null;

  async function back() {
    setBusy(true);
    setError(false);
    try {
      await simpleModeApi.setEnabled(true);
      window.location.assign('/start');
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4"
      data-testid="volver-sencillo"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name="sparkles" size={20} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-text">{t('volverTitulo')}</p>
          <p className="mt-0.5 max-w-[62ch] text-sm text-text-muted">{t('volverTexto')}</p>
          {error ? (
            <p role="alert" className="mt-1 text-sm font-semibold text-danger-700">
              {t('error')}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void back()}
        disabled={busy}
        className="h-10 shrink-0 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? t('volverCambiando') : t('volverBoton')}
      </button>
    </div>
  );
}
