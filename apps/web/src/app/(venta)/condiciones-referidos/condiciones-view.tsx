'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatCents } from '@/lib/i18n/format';
import { referralsApi, type ReferralsPublicTerms } from '@/lib/referrals';
import { useTenantDisplayName } from '@/lib/tenant-context';

const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] as const;
const SUMMARY = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] as const;

/** Valores ICU de las condiciones a partir de la configuración real del aula. */
export function termsValues(
  terms: ReferralsPublicTerms,
  academia: string,
): Record<string, string | number> {
  const alcance =
    terms.scope === 'FIRST_PAYMENT' ? 'primero' : terms.recurringMonths ? 'meses' : 'todo';
  return {
    academia,
    dias: terms.attributionWindowDays,
    garantia: terms.guaranteeDays,
    porcentaje: terms.commissionBps / 100,
    tope: terms.creditMaxSharePercent,
    alcance,
    meses: terms.recurringMonths ?? 0,
    hayMinimo: terms.minPayoutCents > 0 ? 'si' : 'no',
    // La divisa del mínimo es la del aula; el programa liquida en euros salvo
    // que el creador cobre en otra (se muestra con el formato del idioma).
    minimo: formatCents(terms.minPayoutCents, 'EUR'),
  };
}

export function CondicionesReferidosView() {
  const t = useTranslations('referidosCondiciones');
  const academia = useTenantDisplayName();
  const [terms, setTerms] = useState<ReferralsPublicTerms | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    referralsApi
      .publicTerms()
      .then(setTerms)
      .catch(() => setError(true));
  }, []);

  if (error) return <p className="mx-auto max-w-[72ch] text-text-muted">{t('error')}</p>;
  if (!terms) return <p className="mx-auto max-w-[72ch] text-text-muted">{t('cargando')}</p>;

  const v = termsValues(terms, academia);
  const tr = t as unknown as (key: string, values?: Record<string, string | number>) => string;

  return (
    <article
      className="mx-auto max-w-[72ch] rounded-2xl border border-border bg-surface p-5 md:p-8"
      data-testid="condiciones-referidos"
    >
      <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-text md:text-[32px]">
        {t('titulo')}
      </h1>
      <p className="mt-1 text-sm text-text-subtle">{t('version', { version: terms.version })}</p>
      <p className="mt-4 text-text-muted">{t('intro', { academia })}</p>
      {!terms.active ? (
        <p className="mt-3 rounded-xl bg-bg-subtle p-3 text-sm text-text-muted">
          {t('cerrado', { academia })}
        </p>
      ) : null}

      <section className="mt-6 rounded-xl border border-border bg-bg-subtle/60 p-4">
        <h2 className="text-base font-bold text-text">{t('resumenTitulo')}</h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-text">
          {SUMMARY.map((k) => (
            <li key={k}>{tr(`resumen.${k}`, v)}</li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-text-subtle">{t('resumenNota')}</p>
      </section>

      {SECTIONS.map((s) => {
        const raw = (t.raw as (key: string) => unknown)(`secciones.${s}`) as Record<string, string>;
        const paragraphs = Object.keys(raw).filter((k) => k.startsWith('p'));
        return (
          <section key={s} className="mt-6" id={s}>
            <h2 className="text-lg font-bold text-text">{tr(`secciones.${s}.titulo`)}</h2>
            {paragraphs.map((p) => (
              <p key={p} className="mt-2 leading-relaxed text-text-muted">
                {tr(`secciones.${s}.${p}`, v)}
              </p>
            ))}
          </section>
        );
      })}
    </article>
  );
}
