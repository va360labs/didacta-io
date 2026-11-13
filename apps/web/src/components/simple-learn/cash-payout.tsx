'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ApiHttpError } from '@/lib/api-client';
import { formatCents, formatDate, regionNameFormatter } from '@/lib/i18n/format';
import {
  downloadReferralReceipt,
  referralsApi,
  type MemberReferralStats,
  type PayeeInput,
} from '@/lib/referrals';
import { cn } from '@/lib/utils';

/** Países donde se puede cobrar por IBAN (los del formato que valida la API). */
export const PAYEE_COUNTRIES = [
  'ES',
  'PT',
  'FR',
  'DE',
  'IT',
  'NL',
  'BE',
  'IE',
  'AT',
  'LU',
  'GB',
  'CH',
  'DK',
  'SE',
  'NO',
  'FI',
  'PL',
  'CZ',
  'SK',
  'SI',
  'HR',
  'HU',
  'RO',
  'BG',
  'GR',
  'CY',
  'MT',
  'EE',
  'LV',
  'LT',
  'IS',
  'LI',
  'MC',
  'AD',
  'SM',
  'GI',
] as const;

type Field = keyof PayeeInput;

/** Cobro en dinero de lo confirmado (mínimo del aula). Ver `ReferralsService.requestCashPayout`. */
export function payoutState(stats: MemberReferralStats): {
  requested: { totalCents: number; currency: string; createdAt: string } | null;
  confirmedCents: number;
  currency: string;
  canRequest: boolean;
} {
  const requested =
    stats.payouts.find((p) => p.method === 'CASH' && p.status === 'REQUESTED') ?? null;
  const confirmedCents = stats.totals.approvedCents;
  const currency = (stats.commissions[0]?.currency ?? 'eur').toUpperCase();
  return {
    requested: requested
      ? {
          totalCents: requested.totalCents,
          currency: requested.currency,
          createdAt: requested.createdAt,
        }
      : null,
    confirmedCents,
    currency,
    canRequest: !requested && confirmedCents > 0 && confirmedCents >= (stats.minPayoutCents ?? 0),
  };
}

export function CashPayoutSection({
  stats,
  academy,
  onChanged,
}: {
  stats: MemberReferralStats;
  academy: string;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations('modoSencilloAprender.referidos.cobroDinero');
  const locale = useLocale();
  const region = useMemo(() => regionNameFormatter(locale), [locale]);
  const state = payoutState(stats);
  const money = (c: number, cur = state.currency) => formatCents(c, cur.toUpperCase());
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PayeeInput>({
    fullName: stats.payee?.fullName ?? '',
    country: stats.payee?.country ?? 'ES',
    taxId: '',
    iban: '',
  });
  const [bad, setBad] = useState<Set<Field>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function request() {
    setBusy(true);
    setError(false);
    try {
      await referralsApi.requestPayout();
      await onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    setBad(new Set());
    try {
      await referralsApi.savePayee(form);
      if (state.canRequest) await referralsApi.requestPayout();
      setEditing(false);
      await onChanged();
    } catch (err) {
      if (err instanceof ApiHttpError && err.code === 'REFERRALS_PAYEE_INVALID') {
        setBad(new Set((err.detail ?? '').split(',').filter(Boolean) as Field[]));
      } else {
        setError(true);
      }
    } finally {
      setBusy(false);
    }
  }

  const input = (field: Field, label: string, extra: Record<string, string> = {}) => (
    <label className="block">
      <span className="text-sm font-semibold text-text">{label}</span>
      <input
        name={field}
        value={form[field]}
        onChange={(e) => setForm({ ...form, [field]: e.target.value })}
        aria-invalid={bad.has(field)}
        className={cn(
          'mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-[15px] text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100',
          bad.has(field) ? 'border-danger-600' : 'border-border',
        )}
        {...extra}
      />
      {bad.has(field) ? (
        <span className="mt-1 block text-xs text-danger-700">{t('campoMal')}</span>
      ) : null}
    </label>
  );

  const showForm = editing || (!stats.payee && state.canRequest);
  const cashDone = stats.payouts.filter((p) => p.method === 'CASH' && p.status === 'DONE');

  return (
    <section
      className="rounded-2xl border border-border bg-surface p-5"
      aria-labelledby="referidos-cobro"
      data-testid="referidos-cobro"
    >
      <h2 id="referidos-cobro" className="text-base font-bold text-text">
        {t('titulo')}
      </h2>
      <p className="mt-1 max-w-[60ch] text-sm text-text-muted">
        {t('texto', { academia: academy })}
      </p>

      {state.requested ? (
        <p
          className="mt-4 rounded-xl bg-brand-50 p-3 text-sm font-semibold text-brand-700"
          role="status"
        >
          {t('pedido', {
            amount: money(state.requested.totalCents, state.requested.currency),
            date: formatDate(state.requested.createdAt, { dateStyle: 'long' }),
            academia: academy,
          })}
        </p>
      ) : (
        <p className="mt-4 text-sm text-text">
          {state.confirmedCents > 0
            ? t('confirmado', { amount: money(state.confirmedCents) })
            : t('nadaConfirmado')}{' '}
          {!state.canRequest && stats.minPayoutCents > 0
            ? t('minimo', { min: money(stats.minPayoutCents) })
            : null}
        </p>
      )}

      {stats.payee && !editing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <span className="font-semibold text-text">{t('datosTitulo')}:</span>
          <span>
            {t('datosResumen', {
              name: stats.payee.fullName,
              iban: stats.payee.ibanMasked,
              taxId: stats.payee.taxIdMasked,
            })}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-semibold text-brand-600 hover:underline"
          >
            {t('cambiar')}
          </button>
        </div>
      ) : null}

      {showForm ? (
        <form
          onSubmit={(e) => void save(e)}
          className="mt-4 grid gap-3 sm:max-w-[520px]"
          data-testid="referidos-cobro-form"
        >
          {input('fullName', t('nombre'), { autoComplete: 'name' })}
          <label className="block">
            <span className="text-sm font-semibold text-text">{t('pais')}</span>
            <select
              name="country"
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
              className="mt-1 h-11 w-full rounded-xl border border-border bg-surface px-3 text-[15px] text-text"
            >
              {PAYEE_COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {region(c)}
                </option>
              ))}
            </select>
          </label>
          {input('taxId', form.country === 'ES' ? t('nif') : t('idFiscal'), {
            autoComplete: 'off',
          })}
          {input('iban', t('iban'), { autoComplete: 'off', inputMode: 'text' })}
          <p className="text-xs text-text-subtle">{t('privacidad', { academia: academy })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-11 items-center rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? t('pidiendo') : state.canRequest ? t('guardarYPedir') : t('guardar')}
            </button>
            {editing ? (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold text-text"
              >
                {t('cancelar')}
              </button>
            ) : null}
          </div>
        </form>
      ) : stats.payee && state.canRequest ? (
        <button
          type="button"
          onClick={() => void request()}
          disabled={busy}
          className="mt-4 inline-flex h-11 items-center rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="referidos-cobro-pedir"
        >
          {busy ? t('pidiendo') : t('pedir', { amount: money(state.confirmedCents) })}
        </button>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-danger-700" role="alert">
          {t('error')}
        </p>
      ) : null}

      {cashDone.length > 0 ? (
        <ul className="mt-4 border-t border-border-soft" data-testid="referidos-cobros-pagados">
          {cashDone.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-3 border-b border-border-soft py-2.5 text-sm"
            >
              <span className="font-bold text-text tabular-nums">
                {money(p.totalCents, p.currency)}
              </span>
              <span className="text-text-muted">
                {t('pagado', {
                  date: formatDate(p.paidAt ?? p.createdAt, { dateStyle: 'medium' }),
                })}
              </span>
              {p.receiptNumber ? (
                <button
                  type="button"
                  onClick={() =>
                    void downloadReferralReceipt(p.id, p.receiptNumber!).catch(() => setError(true))
                  }
                  className="font-semibold text-brand-600 hover:underline"
                  data-testid="referidos-justificante"
                >
                  {t('justificante')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
