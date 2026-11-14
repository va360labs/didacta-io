'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Casilla obligatoria antes de pagar: «Quiero acceder ahora mismo. Entiendo
 * que, al empezar ya, pierdo el derecho a desistir en 14 días». Sin marcarla
 * el botón de pago no se activa, y la API tampoco deja pagar (422).
 *
 * El texto viene de la API tal cual (es el que se guarda como prueba). Si no
 * carga, no se puede comprar: se dice y se ofrece reintentar.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  getWithdrawalWaiver,
  waiverAcceptance,
  type PurchaseKind,
  type WithdrawalWaiverAcceptance,
  type WithdrawalWaiverText,
} from '@/lib/purchase-consent';

/** Carga el texto y lleva el estado de la casilla. */
export function useWithdrawalWaiver(kind: PurchaseKind): {
  waiver: WithdrawalWaiverText | null;
  failed: boolean;
  checked: boolean;
  setChecked: (value: boolean) => void;
  reload: () => void;
  acceptance: WithdrawalWaiverAcceptance | null;
} {
  const locale = useLocale();
  const [waiver, setWaiver] = useState<WithdrawalWaiverText | null>(null);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    getWithdrawalWaiver(kind, locale)
      .then((w) => {
        if (cancelled) return;
        setWaiver(w);
        // Texto nuevo (otra versión o idioma): hay que volver a marcarla.
        setChecked(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, locale, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    waiver,
    failed,
    checked,
    setChecked,
    reload,
    acceptance: waiverAcceptance(waiver, checked),
  };
}

export function WithdrawalWaiverCheckbox({
  waiver,
  failed,
  checked,
  onCheckedChange,
  onRetry,
  className,
  nudge = false,
  inputRef,
}: {
  waiver: WithdrawalWaiverText | null;
  failed: boolean;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  onRetry: () => void;
  className?: string;
  /**
   * Quien intentó pagar sin marcarla: se resalta y se dice por qué el botón no
   * avanza (el botón apagado sin explicación hizo dudar a una compradora real).
   */
  nudge?: boolean;
  /** Para llevar el foco a la casilla al pulsar «Comprar» sin marcarla. */
  inputRef?: React.Ref<HTMLInputElement>;
}): React.JSX.Element {
  const t = useTranslations('publicSite.withdrawalWaiver');
  const id = useId();

  if (failed) {
    return (
      <p
        role="alert"
        className={`rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700 ${className ?? ''}`}
      >
        {t('loadError')}{' '}
        <button type="button" className="font-semibold underline" onClick={onRetry}>
          {t('retry')}
        </button>
      </p>
    );
  }
  if (!waiver) {
    return (
      <p className={`text-xs text-text-subtle ${className ?? ''}`} aria-live="polite">
        {t('loading')}
      </p>
    );
  }
  const nudging = nudge && !checked;
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
        nudging
          ? 'border-warning-500 bg-warning-50 ring-2 ring-warning-500/40'
          : 'border-border bg-surface-2'
      } ${className ?? ''}`}
      data-testid="withdrawal-waiver"
      data-version={waiver.version}
      data-nudge={nudging ? 'true' : undefined}
    >
      <input
        id={id}
        ref={inputRef}
        type="checkbox"
        required
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        aria-describedby={`${id}-seller${checked ? '' : ` ${id}-hint`}`}
        aria-invalid={nudging || undefined}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border text-brand-600 focus:ring-brand-300"
      />
      <div className="min-w-0 text-left">
        <label htmlFor={id} className="cursor-pointer text-[13px] leading-5 text-text">
          {waiver.statement}
        </label>
        <p id={`${id}-seller`} className="mt-1 text-xs text-text-muted">
          {waiver.sellerLine}
        </p>
        {checked ? null : (
          <p
            id={`${id}-hint`}
            className={`mt-1.5 flex items-center gap-1 text-xs font-semibold ${
              nudging ? 'text-warning-700' : 'text-text-subtle'
            }`}
            data-testid="withdrawal-waiver-hint"
            aria-live="polite"
          >
            {t('mustTickToPay')}
          </p>
        )}
      </div>
    </div>
  );
}
