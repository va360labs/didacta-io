'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatCents, formatDate } from '@/lib/i18n/format';
import { downloadReferralReceipt, referralsAdminApi, type AdminCashPayout } from '@/lib/referrals';

/** IBAN en grupos de 4, para leerlo al hacer la transferencia. */
export function groupIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/**
 * Cobros en dinero que piden los alumnos (Ventas del creador): con lo
 * necesario para pagar (nombre, NIF, IBAN) y el botón para marcarlo pagado
 * con la referencia de la transferencia.
 */
export function CashPayoutsAdmin() {
  const t = useTranslations('modoSencilloVentas.referidos.cobros');
  const [rows, setRows] = useState<AdminCashPayout[] | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await referralsAdminApi.listCashPayouts().catch(() => null);
    setRows(r?.payouts ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markPaid(id: string) {
    const ref = (refs[id] ?? '').trim();
    if (ref.length < 3) return setError(id);
    setBusy(id);
    setError(null);
    try {
      await referralsAdminApi.markCashPayoutPaid(id, ref);
      await load();
    } catch {
      setError(id);
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return null;
  const requested = rows.filter((r) => r.status === 'REQUESTED');
  const paid = rows.filter((r) => r.status === 'DONE').slice(0, 5);

  return (
    <div className="mt-6 border-t border-border pt-4" data-testid="ventas-cobros-pedidos">
      <h3 className="text-base font-bold text-text">{t('titulo')}</h3>
      <p className="mt-1 max-w-[65ch] text-sm text-text-muted">{t('texto')}</p>
      {requested.length === 0 && paid.length === 0 ? (
        <p className="mt-2 text-sm text-text-subtle">{t('vacio')}</p>
      ) : null}
      <ul className="mt-3 grid gap-3">
        {requested.map((r) => (
          <li key={r.id} className="rounded-xl border border-border p-3" data-testid="cobro-pedido">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong className="text-text">{r.payee?.fullName ?? t('sinDatos')}</strong>
              <span className="text-lg font-extrabold text-text tabular-nums">
                {formatCents(r.totalCents, r.currency.toUpperCase())}
              </span>
            </div>
            {r.payee ? (
              <dl className="mt-1 grid gap-0.5 text-sm text-text-muted">
                <div>
                  <dt className="inline font-semibold">{t('iban')}: </dt>
                  <dd className="inline font-mono">{groupIban(r.payee.iban)}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">{t('nif')}: </dt>
                  <dd className="inline font-mono">{r.payee.taxId}</dd>
                </div>
              </dl>
            ) : null}
            <p className="mt-1 text-xs text-text-subtle">
              {t('pedidoEl', { date: formatDate(r.requestedAt, { dateStyle: 'medium' }) })}
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-text">{t('referencia')}</span>
                <input
                  value={refs[r.id] ?? ''}
                  onChange={(e) => setRefs({ ...refs, [r.id]: e.target.value })}
                  className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
                />
              </label>
              <button
                type="button"
                onClick={() => void markPaid(r.id)}
                disabled={busy === r.id}
                className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy === r.id ? t('marcando') : t('marcar')}
              </button>
            </div>
            {error === r.id ? (
              <p className="mt-2 text-sm text-danger-700" role="alert">
                {t('error')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {paid.length > 0 ? (
        <ul className="mt-3" data-testid="cobros-pagados">
          {paid.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border-soft py-2 text-sm first:border-t-0"
            >
              <span className="min-w-0">
                <span className="block font-semibold text-text">
                  {r.payee?.fullName ?? t('sinDatos')} ·{' '}
                  {formatCents(r.totalCents, r.currency.toUpperCase())}
                </span>
                <span className="text-[13px] text-text-subtle">
                  {t('pagadoEl', {
                    date: formatDate(r.paidAt ?? r.requestedAt, { dateStyle: 'medium' }),
                    ref: r.externalReference ?? '',
                  })}
                </span>
              </span>
              {r.receiptNumber ? (
                <button
                  type="button"
                  onClick={() =>
                    void downloadReferralReceipt(r.id, r.receiptNumber!, true).catch(() =>
                      setError(r.id),
                    )
                  }
                  className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text hover:border-border-strong"
                  data-testid="ventas-justificante"
                >
                  {t('justificante')} {String(r.receiptNumber).padStart(4, '0')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
