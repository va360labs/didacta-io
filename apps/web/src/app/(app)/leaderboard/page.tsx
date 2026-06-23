'use client';

import { useEffect, useState } from 'react';
import { leaderboardApi, type LeaderboardEntry, type LeaderboardRange } from '@/lib/leaderboard';

const RANGE_LABELS: { label: string; value: LeaderboardRange }[] = [
  { label: 'Este mes', value: 'month' },
  { label: 'Esta semana', value: 'week' },
  { label: 'Global', value: 'all' },
];

const RANK_STYLE: Record<number, string> = {
  1: 'bg-(--didacta-gold)/10 text-(--didacta-gold) font-bold',
  2: 'bg-bg-subtle text-text-muted font-semibold',
  3: 'bg-(--didacta-coral)/10 text-(--didacta-coral) font-semibold',
};

export default function LeaderboardPage() {
  const [range, setRange] = useState<LeaderboardRange>('month');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    leaderboardApi
      .get(range)
      .then((data) => {
        if (!cancelled) {
          setEntries(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('No se pudo cargar el leaderboard.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">Leaderboard</h1>
        <p className="mt-1 text-sm text-text-muted">Clasificación de la comunidad</p>
      </div>

      <div className="flex gap-2">
        {RANGE_LABELS.map(({ label, value }) => (
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
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Cargando ranking…</p>
      ) : error ? (
        <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-base font-semibold text-text">Aún no hay actividad registrada</p>
          <p className="mt-1 text-sm text-text-muted">
            El ranking aparecerá cuando los miembros publiquen y comenten en la comunidad.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="grid grid-cols-[auto_1fr_auto] gap-x-4 border-b border-border px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            <span>#</span>
            <span>Miembro</span>
            <span>Puntos</span>
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
              <div className="flex items-center gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-(--didacta-trust)/10 text-xs font-bold text-(--didacta-trust)">
                  {e.displayName.slice(0, 1).toUpperCase()}
                </div>
                <span className="text-sm font-medium text-text">{e.displayName}</span>
              </div>
              <span className="text-sm font-semibold text-text">
                {e.points.toLocaleString('es-ES')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
