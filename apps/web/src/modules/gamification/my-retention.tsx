'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Switch } from '@/components/ui/switch';
import { formatDate, formatNumber } from '@/lib/i18n/format';
import {
  retentionApi,
  type MyRetention,
  type RewardGrant,
  type UpcomingReward,
} from './retention-client';
import { BADGE_ICON, badgeLabel } from './retention-labels';

/**
 * Lo que la retención le da a cada miembro, en /challenges: su racha, sus
 * insignias, sus premios (con el código o el enlace ya entregados) y sus dos
 * preferencias de privacidad. Sin presión: la racha no amenaza con perderse y
 * no hay contadores de «lo que te estás perdiendo».
 */
export function MyRetentionSections({
  Section,
}: {
  Section: (p: { title: string; note: string; children: ReactNode }) => ReactNode;
}) {
  const t = useTranslations('modGamification.retencion.alumno');
  const tBadge = useTranslations('modGamification.retencion.badge');
  const [data, setData] = useState<MyRetention | null>(null);
  const [rewards, setRewards] = useState<{
    earned: RewardGrant[];
    upcoming: UpcomingReward[];
  } | null>(null);

  const load = useCallback(async () => {
    const [mine, rw] = await Promise.all([retentionApi.myRetention(), retentionApi.myRewards()]);
    setData(mine);
    setRewards(rw);
  }, []);

  useEffect(() => {
    // Con los puntos apagados la API responde 403: no se pinta nada.
    load().catch(() => setData(null));
  }, [load]);

  async function setPref(p: { celebrate?: boolean; showStreak?: boolean }) {
    const prefs = await retentionApi.updatePrefs(p);
    setData((d) => (d ? { ...d, prefs } : d));
  }

  if (!data) return null;

  return (
    <>
      {data.streak ? (
        <Section title={t('rachaTitulo')} note={t('rachaNota')}>
          <div className="grid gap-4 sm:grid-cols-3" data-testid="mi-racha">
            <Stat
              icon="trending"
              value={t('dias', { count: data.streak.currentDays })}
              hint={data.streak.activeToday ? t('hoyHecho') : t('hoyPendiente')}
            />
            <Stat icon="calendar" value={t('semanas', { count: data.streak.currentWeeks })} />
            <Stat icon="award" value={t('mejor', { count: data.streak.bestDays })} />
          </div>
        </Section>
      ) : null}

      {data.settings.badgesEnabled && data.catalog.length > 0 ? (
        <Section title={t('insigniasTitulo')} note={t('insigniasNota')}>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="mis-insignias">
            {data.catalog.map((b) => {
              const earned = data.badges.find((x) => x.key === b.key);
              return (
                <li
                  key={b.key}
                  className={`flex items-center gap-3 rounded-2xl border p-4 ${
                    earned ? 'border-brand-200 bg-brand-50' : 'border-border bg-surface opacity-70'
                  }`}
                >
                  <span
                    className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${
                      earned ? 'bg-brand-600 text-white' : 'bg-bg-subtle text-text-muted'
                    }`}
                  >
                    <Icon name={earned ? (BADGE_ICON[b.kind] ?? 'award') : 'lock'} size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-text">{badgeLabel(b, tBadge)}</span>
                    <span className="block text-xs text-text-muted">
                      {earned
                        ? t('insigniaGanada', { date: formatDate(earned.awardedAt) })
                        : t('insigniaPendiente')}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {rewards && (rewards.earned.length > 0 || rewards.upcoming.length > 0) ? (
        <Section title={t('premiosTitulo')} note={t('premiosNota')}>
          <div id="rewards" className="grid gap-4 lg:grid-cols-2" data-testid="mis-premios">
            {rewards.earned.map((g) => (
              <EarnedReward key={g.id} grant={g} />
            ))}
            {rewards.upcoming.map((r) => (
              <div
                key={r.id}
                className="rounded-2xl border border-border bg-surface p-4 opacity-80"
              >
                <p className="flex items-center gap-2 font-semibold text-text">
                  <Icon name="lock" size={14} />
                  {r.title}
                </p>
                <p className="mt-1 text-sm text-text-muted">
                  {r.triggerKind === 'LEVEL'
                    ? t('premioMetaNivel', { number: r.levelNumber ?? 0, name: r.levelName ?? '—' })
                    : t('premioMetaPuntos', { points: formatNumber(r.points ?? 0) })}
                  {' · '}
                  {t('premioFalta', { count: r.pointsMissing })}
                </p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('prefsTitulo')} note={t('prefsNota')}>
        <div
          className="space-y-3 rounded-2xl border border-border bg-surface p-4"
          data-testid="mis-preferencias"
        >
          <PrefToggle
            id="pref-celebrar"
            label={t('prefsCelebrar')}
            checked={data.prefs.celebrate}
            onChange={(v) => void setPref({ celebrate: v })}
          />
          {data.settings.streaksEnabled ? (
            <PrefToggle
              id="pref-racha"
              label={t('prefsRacha')}
              checked={data.prefs.showStreak}
              onChange={(v) => void setPref({ showStreak: v })}
            />
          ) : null}
        </div>
      </Section>
    </>
  );
}

function Stat({
  icon,
  value,
  hint,
}: {
  icon: 'trending' | 'calendar' | 'award';
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
        <Icon name={icon} size={18} />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-text">{value}</span>
        {hint ? <span className="block text-xs text-text-muted">{hint}</span> : null}
      </span>
    </div>
  );
}

function EarnedReward({ grant }: { grant: RewardGrant }) {
  const t = useTranslations('modGamification.retencion.alumno');
  const [copied, setCopied] = useState(false);
  const d = grant.delivered;
  return (
    <div
      className="rounded-2xl border border-brand-200 bg-brand-50 p-4"
      data-testid="premio-recibido"
    >
      <p className="flex items-center gap-2 font-semibold text-text">
        <Icon name="award" size={16} />
        {d.title}
      </p>
      <p className="mt-0.5 text-xs text-text-muted">
        {t('premioRecibido', { date: formatDate(grant.grantedAt) })}
      </p>
      {d.message ? <p className="mt-2 whitespace-pre-line text-sm text-text">{d.message}</p> : null}
      {d.code ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-muted">{t('premioCodigo')}</span>
          <code className="rounded-lg bg-surface px-3 py-1.5 font-mono text-base font-bold text-text">
            {d.code}
          </code>
          <button
            type="button"
            className="h-8 rounded-lg border border-border bg-surface px-3 text-xs font-semibold text-text"
            onClick={() => {
              void navigator.clipboard?.writeText(d.code ?? '').then(() => setCopied(true));
            }}
          >
            {copied ? t('copiado') : t('copiar')}
          </button>
        </div>
      ) : null}
      {d.url ? (
        <a
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 underline"
        >
          {t('premioEnlace')}
          <Icon name="arrow-right" size={14} />
        </a>
      ) : null}
    </div>
  );
}

function PrefToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span id={`${id}-label`} className="text-sm font-medium text-text">
        {label}
      </span>
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}
