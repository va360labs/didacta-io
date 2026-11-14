'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { retentionApi, type MemberSummary } from './retention-client';
import { BADGE_ICON, badgeLabel } from './retention-labels';

/**
 * Nivel, insignias y racha de un miembro en su perfil (`/u/[id]`). Si el aula
 * tiene los puntos apagados (403) o la persona no tiene nada aún, no ocupa
 * sitio: nada de «0 insignias» de relleno.
 */
export function MemberAchievements({ userId }: { userId: string }) {
  const t = useTranslations('modGamification.retencion.perfil');
  const [summary, setSummary] = useState<MemberSummary | null>(null);

  useEffect(() => {
    let alive = true;
    retentionApi
      .memberSummary(userId)
      .then((s) => {
        if (alive) setSummary(s);
      })
      .catch(() => {
        if (alive) setSummary(null);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  if (!summary) return null;
  const streak = summary.streak && summary.streak.currentDays > 0 ? summary.streak : null;
  if (summary.levelNumber === 0 && summary.badges.length === 0 && !streak) return null;

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4" data-testid="perfil-logros">
      <div className="flex flex-wrap items-center gap-2">
        {summary.levelNumber > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1 text-xs font-bold text-white">
            <Icon name="trophy" size={13} />
            {t('nivel', { number: summary.levelNumber, name: summary.levelName ?? '' })}
          </span>
        ) : null}
        {streak ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-bold text-brand-700"
            data-testid="perfil-racha"
          >
            <Icon name="trending" size={13} />
            {t('racha', { count: streak.currentDays })}
          </span>
        ) : null}
      </div>
      {summary.badges.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('insignias')}
          </p>
          <BadgeList summary={summary} />
        </div>
      ) : null}
    </div>
  );
}

function BadgeList({ summary, compact = false }: { summary: MemberSummary; compact?: boolean }) {
  const tBadge = useTranslations('modGamification.retencion.badge');
  return (
    <ul
      className={`flex flex-wrap gap-1.5 ${compact ? '' : 'mt-2'}`}
      data-testid="perfil-insignias"
    >
      {summary.badges.map((b) => {
        const label = badgeLabel(b, tBadge);
        return (
          <li
            key={b.key}
            title={label}
            className={
              compact
                ? 'grid h-6 w-6 place-items-center rounded-full bg-brand-50 text-brand-700'
                : 'inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800'
            }
          >
            <Icon name={BADGE_ICON[b.kind] ?? 'award'} size={compact ? 12 : 13} />
            {compact ? <span className="sr-only">{label}</span> : label}
          </li>
        );
      })}
    </ul>
  );
}

/** Resúmenes de varios miembros a la vez (tarjetas del directorio). */
export function useMemberSummaries(ids: string[]): Map<string, MemberSummary> {
  const [map, setMap] = useState<Map<string, MemberSummary>>(new Map());
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    retentionApi
      .membersSummary(key.split(','))
      .then((list) => {
        if (alive) setMap(new Map(list.map((s) => [s.userId, s])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return map;
}

/** Nivel e insignias en una tarjeta de miembro, en una línea. */
export function MemberCardAchievements({ summary }: { summary: MemberSummary | undefined }) {
  const t = useTranslations('modGamification.retencion.perfil');
  if (!summary || (summary.levelNumber === 0 && summary.badges.length === 0)) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="tarjeta-logros">
      {summary.levelNumber > 0 ? (
        <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white">
          {t('nivelCorto', { number: summary.levelNumber })}
        </span>
      ) : null}
      {summary.badges.length > 0 ? <BadgeList summary={summary} compact /> : null}
    </div>
  );
}
