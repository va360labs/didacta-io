'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserChip } from '@/components/user-chip';
import { formatNumber } from '@/lib/i18n/format';
import {
  gamificationApi,
  type LeaderboardEntry,
  type LeaderboardRange,
  type Standing,
} from '@/modules/gamification';

/** Rangos del selector. El `key` es del catálogo; el `value` va a la API. */
const RANGES: { key: 'rangoMes' | 'rangoSemana' | 'rangoGlobal'; value: LeaderboardRange }[] = [
  { key: 'rangoMes', value: 'month' },
  { key: 'rangoSemana', value: 'week' },
  { key: 'rangoGlobal', value: 'all' },
];

const RANK_STYLE: Record<number, string> = {
  1: 'bg-(--didacta-gold)/10 text-(--didacta-gold) font-bold',
  2: 'bg-bg-subtle text-text-muted font-semibold',
  3: 'bg-(--didacta-coral)/10 text-(--didacta-coral) font-semibold',
};

export default function LeaderboardPage() {
  const t = useTranslations('alumnoSocial');
  const [range, setRange] = useState<LeaderboardRange>('month');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([gamificationApi.leaderboard(range), gamificationApi.myStanding(range)])
      .then(([board, mine]) => {
        if (cancelled) return;
        setEntries(board.entries);
        setStanding(mine);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('leaderboard.errorCarga'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, t]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">{t('leaderboard.titulo')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('leaderboard.subtitulo')}</p>
      </div>

      {standing && standing.points > 0 ? (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-surface px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {t('leaderboard.tusPuntos')}
            </p>
            <p className="font-display text-xl font-bold text-text">
              {formatNumber(standing.points)}
            </p>
          </div>
          {standing.rank !== null ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {t('leaderboard.tuPuesto')}
              </p>
              <p className="font-display text-xl font-bold text-text">
                #{standing.rank}{' '}
                <span className="text-sm font-medium text-text-muted">
                  {t('leaderboard.deTotal', { total: standing.total })}
                </span>
              </p>
            </div>
          ) : null}
          {standing.levelName ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {t('leaderboard.tuNivel')}
              </p>
              <p className="font-display text-xl font-bold text-text">{standing.levelName}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        {RANGES.map(({ key, value }) => (
          <button
            key={value}
            type="button"
            onClick={() => setRange(value)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              range === value
                ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
                : 'border-border text-text-muted hover:text-text'
            }`}
          >
            {t(`leaderboard.${key}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">{t('leaderboard.cargando')}</p>
      ) : error ? (
        <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-base font-semibold text-text">{t('leaderboard.vacioTitulo')}</p>
          <p className="mt-1 text-sm text-text-muted">{t('leaderboard.vacioNota')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="grid grid-cols-[auto_1fr_auto] gap-x-4 border-b border-border px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            <span>#</span>
            <span>{t('leaderboard.colMiembro')}</span>
            <span>{t('leaderboard.colPuntos')}</span>
          </div>
          {entries.map((e) => (
            <div
              key={e.userId}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 border-b border-border px-5 py-3.5 last:border-b-0"
            >
              <span
                className={`grid h-7 w-7 place-items-center rounded-full text-xs ${
                  RANK_STYLE[e.rank] ?? 'bg-bg-subtle text-text-muted text-xs font-medium'
                }`}
              >
                {e.rank}
              </span>
              <UserChip
                userId={e.userId}
                name={e.displayName}
                size={32}
                nameClassName="block truncate text-sm font-medium text-text"
              />
              <span className="text-sm font-semibold text-text">{formatNumber(e.points)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
