'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { gamificationAdminApi, gamificationApi, type LevelView } from './client';
import {
  retentionAdminApi,
  type BadgeView,
  type ContentLock,
  type LockableCourse,
  type Reward,
  type RewardGrant,
  type RetentionSettings as Settings,
} from './retention-client';
import { badgeLabel } from './retention-labels';

/**
 * «Premios y niveles»: la configuración de la retención estilo Skool en UNA
 * pantalla sencilla — niveles, contenido que se desbloquea por nivel, premios
 * automáticos, insignias, rachas y celebraciones. La usan los Ajustes del modo
 * sencillo y la pestaña del panel de Puntos y retos del modo completo.
 *
 * Todo sale de la API; si el aula tiene los puntos apagados, lo dice en vez de
 * pintar formularios que no harían nada.
 */

const INPUT =
  'h-11 w-full rounded-xl border border-border bg-surface px-3 text-[15px] text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100';
const BUTTON =
  'h-11 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50';
const GHOST =
  'h-9 rounded-lg border border-border bg-surface px-3 text-sm font-semibold text-text hover:border-border-strong disabled:opacity-50';

function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'nivel'
  );
}

export function RetentionSettings({ showLevels = true }: { showLevels?: boolean }) {
  const t = useTranslations('modGamification.retencion');
  const tErrors = useTranslations('errors');
  const [disabled, setDisabled] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [levels, setLevels] = useState<LevelView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) =>
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('seccion.error')),
    [t, tErrors],
  );

  const loadLevels = useCallback(async () => {
    setLevels([...(await gamificationApi.listLevels())].sort((a, b) => a.minPoints - b.minPoints));
  }, []);

  useEffect(() => {
    void Promise.all([retentionAdminApi.getSettings(), gamificationApi.listLevels()])
      .then(([s, l]) => {
        setSettings(s);
        setLevels([...l].sort((a, b) => a.minPoints - b.minPoints));
      })
      .catch((e: unknown) => {
        // 403/404 del interceptor de módulos: los puntos están apagados.
        if (e instanceof ApiHttpError && (e.status === 403 || e.status === 404)) setDisabled(true);
        else fail(e);
      });
  }, [fail]);

  async function patch(p: Partial<Settings>) {
    setError(null);
    try {
      setSettings(await retentionAdminApi.updateSettings(p));
    } catch (e) {
      fail(e);
    }
  }

  if (disabled) {
    return (
      <p
        className="rounded-xl bg-bg-subtle p-4 text-sm text-text-muted"
        data-testid="premios-apagado"
      >
        {t('seccion.apagado')}
      </p>
    );
  }
  if (!settings) return <p className="text-sm text-text-muted">{t('seccion.cargando')}</p>;

  return (
    <div className="space-y-6" data-testid="premios-y-niveles">
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger-700">
          {error}
        </p>
      ) : null}
      {showLevels ? <LevelsBlock levels={levels} onChange={loadLevels} onError={fail} /> : null}
      <LocksBlock levels={levels} onError={fail} />
      <RewardsBlock levels={levels} onError={fail} />
      <BadgesBlock
        enabled={settings.badgesEnabled}
        onToggle={(v) => void patch({ badgesEnabled: v })}
        onError={fail}
      />
      <Block title={t('rachas.titulo')} help={t('rachas.ayuda')}>
        <Toggle
          id="premios-rachas"
          label={t('rachas.activas')}
          checked={settings.streaksEnabled}
          onChange={(v) => void patch({ streaksEnabled: v })}
        />
      </Block>
      <Block title={t('celebraciones.titulo')} help={t('celebraciones.ayuda')}>
        <div className="space-y-3" data-testid="premios-celebraciones">
          <Toggle
            id="celebrar-cursos"
            label={t('celebraciones.cursos')}
            checked={settings.celebrateCourses}
            onChange={(v) => void patch({ celebrateCourses: v })}
          />
          <Toggle
            id="celebrar-presentaciones"
            label={t('celebraciones.intros')}
            checked={settings.celebrateIntros}
            onChange={(v) => void patch({ celebrateIntros: v })}
          />
          <Toggle
            id="celebrar-aniversarios"
            label={t('celebraciones.aniversarios')}
            checked={settings.celebrateAnniversaries}
            onChange={(v) => void patch({ celebrateAnniversaries: v })}
          />
          <Toggle
            id="celebrar-niveles"
            label={t('celebraciones.niveles')}
            checked={settings.celebrateLevels}
            onChange={(v) => void patch({ celebrateLevels: v })}
          />
        </div>
      </Block>
    </div>
  );
}

function Block({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h3 className="text-[15px] font-bold text-text">{title}</h3>
      <p className="mt-1 max-w-[65ch] text-sm text-text-muted">{help}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Toggle({
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

// ── Niveles ──────────────────────────────────────────────────────────────────

function LevelsBlock({
  levels,
  onChange,
  onError,
}: {
  levels: LevelView[];
  onChange: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const t = useTranslations('modGamification.retencion');
  const [name, setName] = useState('');
  const [points, setPoints] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    const minPoints = Number(points);
    if (name.trim().length < 2 || !Number.isInteger(minPoints) || minPoints < 0) return;
    setBusy(true);
    try {
      // La clave técnica se deriva del nombre: el creador no tiene que pensarla.
      const base = slugify(name);
      const key = levels.some((l) => l.key === base) ? `${base}-${minPoints}` : base;
      await gamificationAdminApi.createLevel({ key, name: name.trim(), minPoints });
      setName('');
      setPoints('');
      await onChange();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(level: LevelView) {
    if (!confirm(t('niveles.quitarConfirm', { name: level.name }))) return;
    try {
      await gamificationAdminApi.deleteLevel(level.id);
      await onChange();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <Block title={t('niveles.titulo')} help={t('niveles.ayuda')}>
      {levels.length === 0 ? (
        <p className="mb-3 text-sm text-text-muted">{t('niveles.vacio')}</p>
      ) : (
        <ol className="mb-4 space-y-2" data-testid="premios-niveles">
          {levels.map((l, i) => (
            <li
              key={l.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-bg-subtle px-3 py-2 text-sm"
            >
              <span className="text-text">
                {t('niveles.fila', { number: i + 1, name: l.name, points: l.minPoints })}
              </span>
              <button type="button" className={GHOST} onClick={() => void remove(l)}>
                {t('niveles.quitar')}
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end">
        <label className="block text-sm font-semibold text-text">
          {t('niveles.nombre')}
          <input
            aria-label={t('niveles.nombre')}
            className={`${INPUT} mt-1.5`}
            value={name}
            maxLength={80}
            placeholder={t('niveles.nombrePh')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm font-semibold text-text">
          {t('niveles.puntos')}
          <input
            aria-label={t('niveles.puntos')}
            className={`${INPUT} mt-1.5`}
            inputMode="numeric"
            value={points}
            onChange={(e) => setPoints(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || name.trim().length < 2 || points === ''}
          onClick={() => void add()}
        >
          {t('niveles.anadir')}
        </button>
      </div>
    </Block>
  );
}

// ── Contenido que se desbloquea por nivel ────────────────────────────────────

function LocksBlock({ levels, onError }: { levels: LevelView[]; onError: (e: unknown) => void }) {
  const t = useTranslations('modGamification.retencion');
  const [locks, setLocks] = useState<ContentLock[]>([]);
  const [courses, setCourses] = useState<LockableCourse[]>([]);
  const [courseId, setCourseId] = useState('');
  const [moduleId, setModuleId] = useState('');
  const [levelId, setLevelId] = useState('');
  const [grantPaid, setGrantPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([
      retentionAdminApi.listLocks(),
      retentionAdminApi.lockableContent(),
    ]);
    setLocks(l);
    setCourses(c);
  }, []);

  useEffect(() => {
    load().catch(onError);
  }, [load, onError]);

  const course = courses.find((c) => c.id === courseId);
  const describe = useCallback(
    (lock: ContentLock) => {
      const c = courses.find((x) => x.id === lock.courseId);
      if (lock.targetKind === 'COURSE') return c?.title ?? '—';
      const m = c?.modules.find((x) => x.id === lock.targetId);
      return t('cierres.filaSeccion', { course: c?.title ?? '—', section: m?.title ?? '—' });
    },
    [courses, t],
  );

  async function add() {
    if (!courseId || !levelId) return;
    setBusy(true);
    try {
      await retentionAdminApi.setLock(
        moduleId
          ? { targetKind: 'MODULE', targetId: moduleId, levelId }
          : {
              targetKind: 'COURSE',
              targetId: courseId,
              levelId,
              grantPaid: !!course?.paid && grantPaid,
            },
      );
      setCourseId('');
      setModuleId('');
      setGrantPaid(false);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(lock: ContentLock) {
    try {
      await retentionAdminApi.removeLock(lock.id);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <Block title={t('cierres.titulo')} help={t('cierres.ayuda')}>
      <p className="mb-4 flex gap-2 rounded-xl bg-bg-subtle p-3 text-sm text-text-muted">
        <Icon name="shield" size={16} className="mt-0.5 shrink-0" />
        <span>{t('cierres.reglaPago')}</span>
      </p>
      {locks.length === 0 ? (
        <p className="mb-3 text-sm text-text-muted">{t('cierres.vacio')}</p>
      ) : (
        <ul className="mb-4 space-y-2" data-testid="premios-cierres">
          {locks.map((lock) => {
            const paid = courses.find((c) => c.id === lock.courseId)?.paid ?? false;
            return (
              <li
                key={lock.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-subtle px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2 text-text">
                  <Icon name="lock" size={14} className="shrink-0 text-text-muted" />
                  <span className="truncate">
                    {t('cierres.fila', {
                      content: describe(lock),
                      number: lock.levelNumber,
                      name: lock.levelName,
                    })}
                  </span>
                  {paid ? (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-muted">
                      {lock.grantPaid ? t('cierres.regalado') : t('cierres.dePago')}
                    </span>
                  ) : null}
                </span>
                <button type="button" className={GHOST} onClick={() => void remove(lock)}>
                  {t('cierres.quitar')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {levels.length === 0 ? (
        <p className="text-sm font-semibold text-text-muted">{t('cierres.sinNiveles')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-text">
            {t('cierres.curso')}
            <select
              aria-label={t('cierres.curso')}
              className={`${INPUT} mt-1.5`}
              value={courseId}
              onChange={(e) => {
                setCourseId(e.target.value);
                setModuleId('');
              }}
            >
              <option value="">—</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-text">
            {t('cierres.seccion')}
            <select
              aria-label={t('cierres.seccion')}
              className={`${INPUT} mt-1.5`}
              value={moduleId}
              disabled={!course}
              onChange={(e) => setModuleId(e.target.value)}
            >
              <option value="">{t('cierres.cursoEntero')}</option>
              {(course?.modules ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-text">
            {t('cierres.nivel')}
            <select
              aria-label={t('cierres.nivel')}
              className={`${INPUT} mt-1.5`}
              value={levelId}
              onChange={(e) => setLevelId(e.target.value)}
            >
              <option value="">—</option>
              {levels.map((l, i) => (
                <option key={l.id} value={l.id}>
                  {t('cierres.nivelOpcion', { number: i + 1, name: l.name })}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col justify-end gap-3">
            {course?.paid && !moduleId ? (
              <label className="flex items-start gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={grantPaid}
                  onChange={(e) => setGrantPaid(e.target.checked)}
                />
                {t('cierres.regalar')}
              </label>
            ) : null}
            <button
              type="button"
              className={BUTTON}
              disabled={busy || !courseId || !levelId}
              onClick={() => void add()}
            >
              {t('cierres.anadir')}
            </button>
          </div>
        </div>
      )}
    </Block>
  );
}

// ── Premios automáticos ──────────────────────────────────────────────────────

function RewardsBlock({ levels, onError }: { levels: LevelView[]; onError: (e: unknown) => void }) {
  const t = useTranslations('modGamification.retencion');
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [grants, setGrants] = useState<RewardGrant[]>([]);
  const [title, setTitle] = useState('');
  const [trigger, setTrigger] = useState<'LEVEL' | 'POINTS'>('LEVEL');
  const [levelId, setLevelId] = useState('');
  const [points, setPoints] = useState('');
  const [kind, setKind] = useState<'MESSAGE' | 'CODE'>('MESSAGE');
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [r, g] = await Promise.all([
      retentionAdminApi.listRewards(),
      retentionAdminApi.listGrants(),
    ]);
    setRewards(r);
    setGrants(g);
  }, []);

  useEffect(() => {
    load().catch(onError);
  }, [load, onError]);

  const valid =
    title.trim().length >= 3 &&
    (trigger === 'LEVEL' ? !!levelId : Number(points) > 0) &&
    (kind === 'CODE'
      ? code.trim().length >= 2
      : message.trim().length > 0 || url.trim().length > 0);

  async function create() {
    if (!valid) return;
    setBusy(true);
    try {
      await retentionAdminApi.createReward({
        title: title.trim(),
        triggerKind: trigger,
        levelId: trigger === 'LEVEL' ? levelId : null,
        points: trigger === 'POINTS' ? Number(points) : null,
        kind,
        message: message.trim() || null,
        url: url.trim() || null,
        code: kind === 'CODE' ? code.trim() : null,
      });
      setTitle('');
      setPoints('');
      setMessage('');
      setUrl('');
      setCode('');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: Reward) {
    try {
      await retentionAdminApi.updateReward(r.id, { active: !r.active });
      await load();
    } catch (e) {
      onError(e);
    }
  }

  async function remove(r: Reward) {
    try {
      await retentionAdminApi.deleteReward(r.id);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <Block title={t('premios.titulo')} help={t('premios.ayuda')}>
      {rewards.length === 0 ? (
        <p className="mb-3 text-sm text-text-muted">{t('premios.vacio')}</p>
      ) : (
        <ul className="mb-4 space-y-2" data-testid="premios-lista">
          {rewards.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-subtle px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-semibold text-text">
                  <Icon name={r.kind === 'CODE' ? 'award' : 'message'} size={14} />
                  {r.title}
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-muted">
                    {r.active ? t('premios.activo') : t('premios.pausado')}
                  </span>
                </span>
                <span className="block text-xs text-text-muted">
                  {r.triggerKind === 'LEVEL'
                    ? t('premios.filaNivel', {
                        number: r.levelNumber ?? 0,
                        name: r.levelName ?? '—',
                      })
                    : t('premios.filaPuntos', { points: r.points ?? 0 })}
                  {' · '}
                  {t('premios.entregados', { count: r.grantCount })}
                </span>
              </span>
              <span className="flex gap-2">
                <button type="button" className={GHOST} onClick={() => void toggle(r)}>
                  {r.active ? t('premios.pausar') : t('premios.activar')}
                </button>
                {r.grantCount === 0 ? (
                  <button type="button" className={GHOST} onClick={() => void remove(r)}>
                    {t('premios.borrar')}
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold text-text sm:col-span-2">
          {t('premios.nombre')}
          <input
            aria-label={t('premios.nombre')}
            className={`${INPUT} mt-1.5`}
            value={title}
            maxLength={160}
            placeholder={t('premios.nombrePh')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block text-sm font-semibold text-text">
          {t('premios.cuando')}
          <select
            aria-label={t('premios.cuando')}
            className={`${INPUT} mt-1.5`}
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as 'LEVEL' | 'POINTS')}
          >
            <option value="LEVEL">{t('premios.cuandoNivel')}</option>
            <option value="POINTS">{t('premios.cuandoPuntos')}</option>
          </select>
        </label>
        {trigger === 'LEVEL' ? (
          <label className="block text-sm font-semibold text-text">
            {t('premios.nivel')}
            <select
              aria-label={t('premios.nivel')}
              className={`${INPUT} mt-1.5`}
              value={levelId}
              onChange={(e) => setLevelId(e.target.value)}
            >
              <option value="">—</option>
              {levels.map((l, i) => (
                <option key={l.id} value={l.id}>
                  {t('cierres.nivelOpcion', { number: i + 1, name: l.name })}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block text-sm font-semibold text-text">
            {t('premios.puntos')}
            <input
              aria-label={t('premios.puntos')}
              className={`${INPUT} mt-1.5`}
              inputMode="numeric"
              value={points}
              onChange={(e) => setPoints(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </label>
        )}
        <label className="block text-sm font-semibold text-text sm:col-span-2">
          {t('premios.tipo')}
          <select
            aria-label={t('premios.tipo')}
            className={`${INPUT} mt-1.5`}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'MESSAGE' | 'CODE')}
          >
            <option value="MESSAGE">{t('premios.tipoMensaje')}</option>
            <option value="CODE">{t('premios.tipoCodigo')}</option>
          </select>
        </label>
        {kind === 'CODE' ? (
          <>
            <p className="flex gap-2 rounded-xl bg-bg-subtle p-3 text-sm text-text-muted sm:col-span-2">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
              <span>{t('premios.codigoAviso')}</span>
            </p>
            <label className="block text-sm font-semibold text-text">
              {t('premios.codigo')}
              <input
                aria-label={t('premios.codigo')}
                className={`${INPUT} mt-1.5 font-mono uppercase`}
                value={code}
                maxLength={64}
                onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
              />
            </label>
          </>
        ) : null}
        <label className="block text-sm font-semibold text-text sm:col-span-2">
          {t('premios.mensaje')}
          <textarea
            aria-label={t('premios.mensaje')}
            className="mt-1.5 min-h-20 w-full rounded-xl border border-border bg-surface px-3 py-2 text-[15px] text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
            value={message}
            maxLength={2000}
            placeholder={t('premios.mensajePh')}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <label className="block text-sm font-semibold text-text sm:col-span-2">
          {t('premios.enlace')}
          <input
            aria-label={t('premios.enlace')}
            className={`${INPUT} mt-1.5`}
            type="url"
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !valid}
            onClick={() => void create()}
          >
            {t('premios.crear')}
          </button>
        </div>
      </div>

      <details className="mt-5 rounded-xl border border-border p-3" data-testid="premios-registro">
        <summary className="cursor-pointer text-sm font-semibold text-text">
          {t('premios.registro')} ({grants.length})
        </summary>
        {grants.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">{t('premios.registroVacio')}</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-text-muted">
            {grants.map((g) => (
              <li key={g.id}>
                {t('premios.registroFila', {
                  name: g.displayName ?? '—',
                  reward: g.delivered.title,
                  date: formatDate(g.grantedAt),
                })}
              </li>
            ))}
          </ul>
        )}
      </details>
    </Block>
  );
}

// ── Insignias ────────────────────────────────────────────────────────────────

function BadgesBlock({
  enabled,
  onToggle,
  onError,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onError: (e: unknown) => void;
}) {
  const t = useTranslations('modGamification.retencion');
  const [badges, setBadges] = useState<BadgeView[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const list = await retentionAdminApi.listBadges();
    setBadges(list);
    setNames(Object.fromEntries(list.map((b) => [b.key, b.name ?? ''])));
  }, []);

  useEffect(() => {
    load().catch(onError);
  }, [load, onError]);

  async function update(b: BadgeView, patch: { name?: string | null; enabled?: boolean }) {
    try {
      await retentionAdminApi.updateBadge(b.key, patch);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  const tBadges = useTranslations('modGamification.retencion.badge');
  const defaults = useMemo(
    () => Object.fromEntries(badges.map((b) => [b.key, badgeLabel({ ...b, name: null }, tBadges)])),
    [badges, tBadges],
  );

  return (
    <Block title={t('insignias.titulo')} help={t('insignias.ayuda')}>
      <Toggle
        id="premios-insignias"
        label={t('insignias.activas')}
        checked={enabled}
        onChange={onToggle}
      />
      {enabled ? (
        <ul className="mt-4 space-y-2" data-testid="premios-insignias">
          {badges.map((b) => (
            <li
              key={b.key}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-subtle px-3 py-2"
            >
              <Switch
                checked={b.enabled}
                label={defaults[b.key]}
                onCheckedChange={(v) => void update(b, { enabled: v })}
              />
              <input
                aria-label={t('insignias.renombrar')}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-sm text-text outline-none focus:border-brand-600"
                value={names[b.key] ?? ''}
                placeholder={defaults[b.key]}
                maxLength={80}
                onChange={(e) => setNames((n) => ({ ...n, [b.key]: e.target.value }))}
              />
              <button
                type="button"
                className={GHOST}
                disabled={(names[b.key] ?? '') === (b.name ?? '')}
                onClick={() => void update(b, { name: names[b.key]?.trim() || null })}
              >
                {t('insignias.guardar')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Block>
  );
}
