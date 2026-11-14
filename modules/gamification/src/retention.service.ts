/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import {
  GamificationCodesUnavailableError,
  GamificationConflictError,
  GamificationNotFoundError,
  GamificationValidationError,
} from './errors.js';
import type { GamificationEventPublisher } from './gamification.service.js';
import {
  CELEBRATION_KINDS,
  computeStreak,
  hasReached,
  liveStreak,
  localDay,
  numberLevels,
  pointsMissing,
  type CelebrationEntry,
  type CelebrationKind,
  type NumberedLevel,
} from './retention.logic.js';

/**
 * mod.gamification — RETENCIÓN (dominio puro, sin NestJS): lo que convierte los
 * puntos en motivos para volver, al estilo Skool.
 *
 *  · DESBLOQUEO POR NIVEL: un curso (o una sección) «se desbloquea en el nivel
 *    N». Es un FILTRO sobre el acceso que la persona ya tenga; nunca da por sí
 *    solo un curso de pago (salvo que el creador marque `grantPaid`).
 *  · RACHAS: días y semanas seguidos con actividad, en la zona horaria de cada
 *    persona y sin castigo (no se rompe hasta pasar un día entero sin nada).
 *  · INSIGNIAS por hitos, con tipos del producto que el creador activa y
 *    renombra.
 *  · PREMIOS automáticos al llegar a un nivel o a X puntos: se entregan solos
 *    y quedan registrados con copia de lo entregado.
 *  · CELEBRACIONES en la comunidad: el módulo decide QUÉ se celebra y agrupa
 *    por día; publicar el post lo hace el host con el servicio público de
 *    mod.community (este módulo no escribe tablas ajenas, ADR-016/039).
 *
 * Solo lee y escribe tablas `mod_gamification_*`. Lo que necesita de fuera
 * (zona horaria, nombre, idioma del aula, títulos de cursos) se lo pasa el host.
 */

export const RETENTION_EVENT = {
  BADGE_AWARDED: 'gamification.badge.awarded',
  REWARD_GRANTED: 'gamification.reward.granted',
  CONTENT_UNLOCKED: 'gamification.content.unlocked',
} as const;

export type LockTargetKind = 'COURSE' | 'MODULE';
export type RewardTrigger = 'LEVEL' | 'POINTS';
export type RewardKind = 'MESSAGE' | 'CODE';
export type BadgeKind = 'first_post' | 'first_comment' | 'first_course' | 'streak_days' | 'level';

const LOCK_TARGETS: readonly LockTargetKind[] = ['COURSE', 'MODULE'];
const REWARD_TRIGGERS: readonly RewardTrigger[] = ['LEVEL', 'POINTS'];
const REWARD_KINDS: readonly RewardKind[] = ['MESSAGE', 'CODE'];
const LIST_LIMIT = 200;
const TITLE_MAX = 160;
const TEXT_MAX = 2000;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
/** Ventana con la que se recalcula la racha: de sobra para cualquier racha real. */
const STREAK_SCAN_DAYS = 1000;
/** Un reclamo de post de celebración que no terminó en 5 min se da por muerto. */
const CLAIM_TTL_MS = 5 * 60_000;

/**
 * Insignias que trae el producto. Los tipos son fijos (son los hechos que el
 * sistema sabe medir); el creador puede desactivarlas o renombrarlas.
 */
export const DEFAULT_BADGES: ReadonlyArray<{ key: string; kind: BadgeKind; threshold: number }> = [
  { key: 'first_post', kind: 'first_post', threshold: 1 },
  { key: 'first_comment', kind: 'first_comment', threshold: 1 },
  { key: 'first_course', kind: 'first_course', threshold: 1 },
  { key: 'streak_7', kind: 'streak_days', threshold: 7 },
  { key: 'streak_30', kind: 'streak_days', threshold: 30 },
  { key: 'level_3', kind: 'level', threshold: 3 },
];

export interface RetentionSettings {
  streaksEnabled: boolean;
  badgesEnabled: boolean;
  celebrateCourses: boolean;
  celebrateIntros: boolean;
  celebrateAnniversaries: boolean;
  celebrateLevels: boolean;
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  streaksEnabled: true,
  badgesEnabled: true,
  // Publicar en nombre del creador es decisión suya: apagadas de serie.
  celebrateCourses: false,
  celebrateIntros: false,
  celebrateAnniversaries: false,
  celebrateLevels: false,
};

const CELEBRATION_SETTING: Record<CelebrationKind, keyof RetentionSettings> = {
  course: 'celebrateCourses',
  intro: 'celebrateIntros',
  anniversary: 'celebrateAnniversaries',
  level: 'celebrateLevels',
};

export interface MemberPrefs {
  celebrate: boolean;
  showStreak: boolean;
}

export interface ContentLockView {
  id: string;
  targetKind: LockTargetKind;
  targetId: string;
  courseId: string;
  levelId: string;
  levelName: string;
  levelNumber: number;
  minPoints: number;
  grantPaid: boolean;
}

/** Un cierre visto por una persona concreta. */
export interface LockState extends ContentLockView {
  unlocked: boolean;
  pointsMissing: number;
}

/** Lo que el gate de mod.learning necesita: solo los cierres AÚN cerrados. */
export interface CourseLevelGate {
  course: LockState | null;
  modules: Record<string, LockState>;
}

export interface UnlockedContent {
  lockId: string;
  targetKind: LockTargetKind;
  targetId: string;
  courseId: string;
  grantPaid: boolean;
  levelName: string;
}

export interface BadgeView {
  key: string;
  kind: BadgeKind;
  threshold: number;
  /** NULL = el nombre por defecto, que la interfaz traduce. */
  name: string | null;
  enabled: boolean;
}

export interface EarnedBadge {
  key: string;
  kind: BadgeKind;
  threshold: number;
  name: string | null;
  awardedAt: Date;
}

export interface StreakView {
  currentDays: number;
  bestDays: number;
  currentWeeks: number;
  bestWeeks: number;
  activeToday: boolean;
  lastDay: string | null;
}

export interface RewardInput {
  title: string;
  triggerKind: RewardTrigger;
  levelId?: string | null;
  points?: number | null;
  kind: RewardKind;
  message?: string | null;
  url?: string | null;
  code?: string | null;
  active?: boolean;
}

export interface RewardView {
  id: string;
  title: string;
  triggerKind: RewardTrigger;
  levelId: string | null;
  levelName: string | null;
  levelNumber: number | null;
  points: number | null;
  kind: RewardKind;
  message: string | null;
  url: string | null;
  code: string | null;
  active: boolean;
  grantCount: number;
}

export interface DeliveredReward {
  title: string;
  kind: RewardKind;
  message: string | null;
  url: string | null;
  code: string | null;
}

export interface RewardGrantView {
  id: string;
  rewardId: string;
  userId: string;
  grantedAt: Date;
  delivered: DeliveredReward;
}

export interface UpcomingReward {
  id: string;
  title: string;
  kind: RewardKind;
  triggerKind: RewardTrigger;
  levelName: string | null;
  levelNumber: number | null;
  points: number | null;
  pointsMissing: number;
}

export type CelebrationPlan =
  | { action: 'skip'; reason: 'disabled' | 'opted_out' | 'duplicate' }
  | {
      action: 'create' | 'update' | 'wait';
      celebrationId: string;
      postId: string | null;
      entries: CelebrationEntry[];
    };

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function isFkViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2003';
}

function cleanText(raw: string | null | undefined, max = TEXT_MAX): string | null {
  const text = raw?.trim() || null;
  if (text && text.length > max) {
    throw new GamificationValidationError(`El texto no puede superar ${max} caracteres.`);
  }
  return text;
}

function cleanTitle(raw: string): string {
  const title = raw.trim();
  if (title.length < 3 || title.length > TITLE_MAX) {
    throw new GamificationValidationError(
      `El título debe tener entre 3 y ${TITLE_MAX} caracteres.`,
    );
  }
  return title;
}

function cleanUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim() || null;
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GamificationValidationError('El enlace no es válido.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GamificationValidationError('El enlace debe empezar por http(s).');
  }
  return url;
}

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function dateDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * ¿Sirve en esta aula un código de descuento? Lo resuelve el host con el modo
 * de cobro: en el modo plataforma el checkout los rechaza. Sin cablear, sí.
 */
export type DiscountCodesCheck = (tenantId: string) => Promise<boolean>;

export class RetentionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: GamificationEventPublisher,
    private readonly discountCodesAllowed: DiscountCodesCheck = async () => true,
  ) {}

  /** ¿Puede el creador dar códigos de descuento como premio en esta aula? */
  async codesAllowed(tenantId: string): Promise<boolean> {
    return this.discountCodesAllowed(tenantId);
  }

  // ── Ajustes y preferencias ─────────────────────────────────────────────────

  async getSettings(tenantId: string): Promise<RetentionSettings> {
    const row = await this.prisma.modGamificationSettings.findUnique({ where: { tenantId } });
    if (!row) return { ...DEFAULT_RETENTION_SETTINGS };
    return {
      streaksEnabled: row.streaksEnabled,
      badgesEnabled: row.badgesEnabled,
      celebrateCourses: row.celebrateCourses,
      celebrateIntros: row.celebrateIntros,
      celebrateAnniversaries: row.celebrateAnniversaries,
      celebrateLevels: row.celebrateLevels,
    };
  }

  async updateSettings(
    tenantId: string,
    patch: Partial<RetentionSettings>,
  ): Promise<RetentionSettings> {
    const data: Partial<RetentionSettings> = {};
    for (const key of Object.keys(DEFAULT_RETENTION_SETTINGS) as (keyof RetentionSettings)[]) {
      if (typeof patch[key] === 'boolean') data[key] = patch[key];
    }
    await this.prisma.modGamificationSettings.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...DEFAULT_RETENTION_SETTINGS, ...data },
    });
    return this.getSettings(tenantId);
  }

  async getPrefs(tenantId: string, userId: string): Promise<MemberPrefs> {
    const row = await this.prisma.modGamificationMemberPrefs.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    return { celebrate: row?.celebrate ?? true, showStreak: row?.showStreak ?? true };
  }

  async updatePrefs(
    tenantId: string,
    userId: string,
    patch: Partial<MemberPrefs>,
  ): Promise<MemberPrefs> {
    const data: Partial<MemberPrefs> = {};
    if (typeof patch.celebrate === 'boolean') data.celebrate = patch.celebrate;
    if (typeof patch.showStreak === 'boolean') data.showStreak = patch.showStreak;
    await this.prisma.modGamificationMemberPrefs.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      update: data,
      create: { tenantId, userId, celebrate: true, showStreak: true, ...data },
    });
    return this.getPrefs(tenantId, userId);
  }

  // ── Niveles y progreso ─────────────────────────────────────────────────────

  private async numberedLevels(tenantId: string): Promise<NumberedLevel[]> {
    const levels = await this.prisma.modGamificationLevel.findMany({
      where: { tenantId },
      orderBy: { minPoints: 'asc' },
      take: LIST_LIMIT,
      select: { id: true, key: true, name: true, minPoints: true },
    });
    return numberLevels(levels);
  }

  private async progressOf(
    tenantId: string,
    userId: string,
    levels: readonly NumberedLevel[],
  ): Promise<{
    lifetimePoints: number;
    currentLevelMinPoints: number | null;
    levelNumber: number;
  }> {
    const profile = await this.prisma.modGamificationProfile.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { lifetimePoints: true, levelKey: true },
    });
    const current = profile?.levelKey ? levels.find((l) => l.key === profile.levelKey) : undefined;
    const progress = {
      lifetimePoints: profile?.lifetimePoints ?? 0,
      currentLevelMinPoints: current?.minPoints ?? null,
    };
    const reached = levels.filter((l) => hasReached(l, progress));
    return { ...progress, levelNumber: reached.length ? reached[reached.length - 1]!.number : 0 };
  }

  /** Número de nivel (1..N) de una persona; 0 si no ha llegado a ninguno. */
  async levelNumberOf(tenantId: string, userId: string): Promise<number> {
    const levels = await this.numberedLevels(tenantId);
    return (await this.progressOf(tenantId, userId, levels)).levelNumber;
  }

  // ── Desbloqueo de contenido por nivel ──────────────────────────────────────

  private toLockView(
    row: {
      id: string;
      targetKind: string;
      targetId: string;
      courseId: string;
      levelId: string;
      grantPaid: boolean;
    },
    levels: readonly NumberedLevel[],
  ): ContentLockView | null {
    const level = levels.find((l) => l.id === row.levelId);
    if (!level) return null;
    return {
      id: row.id,
      targetKind: row.targetKind as LockTargetKind,
      targetId: row.targetId,
      courseId: row.courseId,
      levelId: row.levelId,
      levelName: level.name,
      levelNumber: level.number,
      minPoints: level.minPoints,
      grantPaid: row.grantPaid,
    };
  }

  async listLocks(tenantId: string, courseId?: string): Promise<ContentLockView[]> {
    const [levels, rows] = await Promise.all([
      this.numberedLevels(tenantId),
      this.prisma.modGamificationContentLock.findMany({
        where: { tenantId, ...(courseId ? { courseId } : {}) },
        orderBy: { createdAt: 'asc' },
        take: LIST_LIMIT,
      }),
    ]);
    return rows
      .map((r) => this.toLockView(r, levels))
      .filter((v): v is ContentLockView => v !== null);
  }

  /**
   * Cierra un curso o una sección hasta un nivel. Si ya estaba cerrado, cambia
   * el nivel (un mismo contenido solo tiene un cierre). Que el curso o la
   * sección existan lo comprueba quien llama: son tablas de mod.courses.
   */
  async setLock(
    tenantId: string,
    input: {
      targetKind: LockTargetKind;
      targetId: string;
      courseId: string;
      levelId: string;
      grantPaid?: boolean;
    },
  ): Promise<ContentLockView> {
    if (!LOCK_TARGETS.includes(input.targetKind)) {
      throw new GamificationValidationError('Solo se puede cerrar un curso o una sección.');
    }
    if (input.targetKind === 'COURSE' && input.targetId !== input.courseId) {
      throw new GamificationValidationError('El cierre de un curso apunta al propio curso.');
    }
    const level = await this.prisma.modGamificationLevel.findFirst({
      where: { id: input.levelId, tenantId },
      select: { id: true },
    });
    if (!level) throw new GamificationNotFoundError('Nivel no encontrado.');

    // Una sección solo regala acceso si lo regala su curso: el acceso es del curso.
    const grantPaid = input.targetKind === 'COURSE' ? (input.grantPaid ?? false) : false;
    const row = await this.prisma.modGamificationContentLock.upsert({
      where: {
        tenantId_targetKind_targetId: {
          tenantId,
          targetKind: input.targetKind,
          targetId: input.targetId,
        },
      },
      update: { levelId: input.levelId, grantPaid },
      create: {
        tenantId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        courseId: input.courseId,
        levelId: input.levelId,
        grantPaid,
      },
    });
    const view = this.toLockView(row, await this.numberedLevels(tenantId));
    if (!view) throw new GamificationNotFoundError('Nivel no encontrado.');
    return view;
  }

  async removeLock(tenantId: string, id: string): Promise<void> {
    const { count } = await this.prisma.modGamificationContentLock.deleteMany({
      where: { id, tenantId },
    });
    if (count === 0) throw new GamificationNotFoundError('Cierre no encontrado.');
  }

  /** Todos los cierres del aula vistos por una persona (para el catálogo). */
  async lockStates(tenantId: string, userId: string, courseId?: string): Promise<LockState[]> {
    const levels = await this.numberedLevels(tenantId);
    if (levels.length === 0) return [];
    const [rows, progress] = await Promise.all([
      this.prisma.modGamificationContentLock.findMany({
        where: { tenantId, ...(courseId ? { courseId } : {}) },
        orderBy: { createdAt: 'asc' },
        take: LIST_LIMIT,
      }),
      this.progressOf(tenantId, userId, levels),
    ]);
    const out: LockState[] = [];
    for (const row of rows) {
      const view = this.toLockView(row, levels);
      if (!view) continue;
      out.push({
        ...view,
        unlocked: hasReached(view, progress),
        pointsMissing: pointsMissing(view, progress),
      });
    }
    return out;
  }

  /**
   * Gate de un curso para mod.learning: los cierres que siguen CERRADOS para
   * esta persona. `null` si no queda ninguno (el caso de casi todos los cursos).
   */
  async courseGate(
    tenantId: string,
    userId: string,
    courseId: string,
  ): Promise<CourseLevelGate | null> {
    const states = (await this.lockStates(tenantId, userId, courseId)).filter((s) => !s.unlocked);
    if (states.length === 0) return null;
    const gate: CourseLevelGate = { course: null, modules: {} };
    for (const s of states) {
      if (s.targetKind === 'COURSE') gate.course = s;
      else gate.modules[s.targetId] = s;
    }
    return gate;
  }

  /**
   * Abre lo que la persona acaba de alcanzar y lo deja registrado (una vez por
   * persona y cierre). Con `crossedFromMinPoints` solo cuenta lo que estaba por
   * ENCIMA del nivel anterior: un cierre que se creó cuando ya tenía el nivel
   * no se «desbloquea» con aviso, simplemente nunca estuvo cerrado para ella.
   */
  async collectUnlocks(
    tenantId: string,
    userId: string,
    crossedFromMinPoints?: number | null,
  ): Promise<UnlockedContent[]> {
    const states = await this.lockStates(tenantId, userId);
    const fresh = states.filter(
      (s) =>
        s.unlocked &&
        (crossedFromMinPoints === undefined ||
          crossedFromMinPoints === null ||
          s.minPoints > crossedFromMinPoints),
    );
    const out: UnlockedContent[] = [];
    for (const s of fresh) {
      try {
        await this.prisma.modGamificationContentUnlock.create({
          data: { tenantId, lockId: s.id, userId },
        });
      } catch (e) {
        if (isUniqueViolation(e)) continue;
        throw e;
      }
      const unlocked: UnlockedContent = {
        lockId: s.id,
        targetKind: s.targetKind,
        targetId: s.targetId,
        courseId: s.courseId,
        grantPaid: s.grantPaid,
        levelName: s.levelName,
      };
      out.push(unlocked);
      await this.publisher.publish(tenantId, userId, RETENTION_EVENT.CONTENT_UNLOCKED, {
        userId,
        ...unlocked,
      });
    }
    return out;
  }

  // ── Rachas ─────────────────────────────────────────────────────────────────

  /**
   * Anota un día con actividad (en la zona horaria de la persona) y recalcula
   * la racha desde los días guardados, así un evento que llega tarde o
   * repetido no la descuadra.
   */
  async recordActivity(
    tenantId: string,
    userId: string,
    at: Date,
    timeZone: string,
  ): Promise<{ newDay: boolean; streak: StreakView }> {
    const day = localDay(at, timeZone);
    let newDay = true;
    try {
      await this.prisma.modGamificationActivityDay.create({
        data: { tenantId, userId, day: dayDate(day) },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      newDay = false;
    }
    if (newDay) await this.recomputeStreak(tenantId, userId);
    return { newDay, streak: await this.streakOf(tenantId, userId, at, timeZone) };
  }

  private async recomputeStreak(tenantId: string, userId: string): Promise<void> {
    const rows = await this.prisma.modGamificationActivityDay.findMany({
      where: { tenantId, userId },
      orderBy: { day: 'desc' },
      take: STREAK_SCAN_DAYS,
      select: { day: true },
    });
    const counts = computeStreak(rows.map((r) => r.day.toISOString().slice(0, 10)));
    const previous = await this.prisma.modGamificationStreak.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    const data = {
      currentDays: counts.runDays,
      bestDays: Math.max(counts.bestDays, previous?.bestDays ?? 0),
      lastDay: counts.lastDay ? dayDate(counts.lastDay) : null,
      currentWeeks: counts.runWeeks,
      bestWeeks: Math.max(counts.bestWeeks, previous?.bestWeeks ?? 0),
    };
    await this.prisma.modGamificationStreak.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      update: data,
      create: { tenantId, userId, ...data },
    });
  }

  async streakOf(
    tenantId: string,
    userId: string,
    now: Date,
    timeZone: string,
  ): Promise<StreakView> {
    const row = await this.prisma.modGamificationStreak.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    const lastDay = dateDay(row?.lastDay ?? null);
    const live = liveStreak(
      { runDays: row?.currentDays ?? 0, runWeeks: row?.currentWeeks ?? 0, lastDay },
      localDay(now, timeZone),
    );
    return {
      currentDays: live.currentDays,
      bestDays: row?.bestDays ?? 0,
      currentWeeks: live.currentWeeks,
      bestWeeks: row?.bestWeeks ?? 0,
      activeToday: live.activeToday,
      lastDay,
    };
  }

  // ── Insignias ──────────────────────────────────────────────────────────────

  /** Catálogo de insignias; siembra las del producto en el primer listado. */
  async listBadges(tenantId: string): Promise<BadgeView[]> {
    let rows = await this.prisma.modGamificationBadge.findMany({ where: { tenantId } });
    const missing = DEFAULT_BADGES.filter((d) => !rows.some((r) => r.key === d.key));
    if (missing.length > 0) {
      for (const badge of missing) {
        try {
          await this.prisma.modGamificationBadge.create({ data: { tenantId, ...badge } });
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
        }
      }
      rows = await this.prisma.modGamificationBadge.findMany({ where: { tenantId } });
    }
    const order = new Map(DEFAULT_BADGES.map((b, i) => [b.key, i]));
    return rows
      .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
      .map((r) => ({
        key: r.key,
        kind: r.kind as BadgeKind,
        threshold: r.threshold,
        name: r.name,
        enabled: r.enabled,
      }));
  }

  async updateBadge(
    tenantId: string,
    key: string,
    patch: { name?: string | null; enabled?: boolean },
  ): Promise<BadgeView> {
    await this.listBadges(tenantId);
    const data: { name?: string | null; enabled?: boolean } = {};
    if (patch.name !== undefined) {
      const name = patch.name?.trim() || null;
      if (name && (name.length < 2 || name.length > 80)) {
        throw new GamificationValidationError('El nombre debe tener entre 2 y 80 caracteres.');
      }
      data.name = name;
    }
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    const { count } = await this.prisma.modGamificationBadge.updateMany({
      where: { tenantId, key },
      data,
    });
    if (count === 0) throw new GamificationNotFoundError('Insignia no encontrada.');
    const badge = (await this.listBadges(tenantId)).find((b) => b.key === key);
    return badge!;
  }

  /**
   * Revisa qué insignias le tocan a una persona con lo que el módulo ya sabe de
   * ella (su libro de puntos, su racha y su nivel) más los hechos que el host
   * acaba de ver (`seen`), y concede las que falten. Idempotente.
   */
  async evaluateBadges(
    tenantId: string,
    userId: string,
    seen: { posted?: boolean; commented?: boolean; completedCourse?: boolean } = {},
  ): Promise<EarnedBadge[]> {
    const settings = await this.getSettings(tenantId);
    if (!settings.badgesEnabled) return [];
    const catalog = (await this.listBadges(tenantId)).filter((b) => b.enabled);
    if (catalog.length === 0) return [];

    const owned = new Set(
      (
        await this.prisma.modGamificationUserBadge.findMany({
          where: { tenantId, userId },
          select: { badgeKey: true },
        })
      ).map((b) => b.badgeKey),
    );
    const pending = catalog.filter((b) => !owned.has(b.key));
    if (pending.length === 0) return [];

    const ledgerHas = async (ruleKey: string) =>
      (await this.prisma.modGamificationLedgerEntry.count({
        where: { tenantId, userId, ruleKey },
        take: 1,
      })) > 0;
    const streak = await this.prisma.modGamificationStreak.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { bestDays: true },
    });
    const levelNumber = await this.levelNumberOf(tenantId, userId);

    const out: EarnedBadge[] = [];
    for (const badge of pending) {
      let earned = false;
      switch (badge.kind) {
        case 'first_post':
          earned = seen.posted === true || (await ledgerHas('community.post'));
          break;
        case 'first_comment':
          earned = seen.commented === true || (await ledgerHas('community.comment'));
          break;
        case 'first_course':
          earned = seen.completedCourse === true || (await ledgerHas('learning.course'));
          break;
        case 'streak_days':
          earned = settings.streaksEnabled && (streak?.bestDays ?? 0) >= badge.threshold;
          break;
        case 'level':
          earned = levelNumber >= badge.threshold;
          break;
      }
      if (!earned) continue;
      try {
        const row = await this.prisma.modGamificationUserBadge.create({
          data: { tenantId, userId, badgeKey: badge.key },
        });
        const awarded: EarnedBadge = {
          key: badge.key,
          kind: badge.kind,
          threshold: badge.threshold,
          name: badge.name,
          awardedAt: row.awardedAt,
        };
        out.push(awarded);
        await this.publisher.publish(tenantId, userId, RETENTION_EVENT.BADGE_AWARDED, {
          userId,
          badgeKey: badge.key,
          kind: badge.kind,
          threshold: badge.threshold,
          name: badge.name,
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    return out;
  }

  /** Insignias ganadas que se enseñan (solo las activas del catálogo). */
  async earnedBadges(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, EarnedBadge[]>> {
    const result = new Map<string, EarnedBadge[]>(userIds.map((id) => [id, []]));
    if (userIds.length === 0) return result;
    const settings = await this.getSettings(tenantId);
    if (!settings.badgesEnabled) return result;
    const catalog = new Map(
      (await this.listBadges(tenantId)).filter((b) => b.enabled).map((b) => [b.key, b]),
    );
    const rows = await this.prisma.modGamificationUserBadge.findMany({
      where: { tenantId, userId: { in: [...new Set(userIds)] } },
      orderBy: { awardedAt: 'asc' },
    });
    for (const row of rows) {
      const badge = catalog.get(row.badgeKey);
      if (!badge) continue;
      result.get(row.userId)?.push({
        key: badge.key,
        kind: badge.kind,
        threshold: badge.threshold,
        name: badge.name,
        awardedAt: row.awardedAt,
      });
    }
    return result;
  }

  // ── Premios automáticos ────────────────────────────────────────────────────

  private validateReward(input: RewardInput) {
    if (!REWARD_TRIGGERS.includes(input.triggerKind)) {
      throw new GamificationValidationError(
        'El premio se entrega al llegar a un nivel o a unos puntos.',
      );
    }
    if (!REWARD_KINDS.includes(input.kind)) {
      throw new GamificationValidationError('El premio es un mensaje o un código de descuento.');
    }
    if (input.triggerKind === 'LEVEL' && !input.levelId) {
      throw new GamificationValidationError('Elige el nivel con el que se entrega.');
    }
    if (input.triggerKind === 'POINTS') {
      const p = input.points;
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 1_000_000) {
        throw new GamificationValidationError(
          'Los puntos deben ser un entero entre 1 y 1.000.000.',
        );
      }
    }
    const message = cleanText(input.message);
    const url = cleanUrl(input.url);
    let code: string | null = null;
    if (input.kind === 'CODE') {
      code = input.code?.trim() || null;
      if (!code || !CODE_PATTERN.test(code)) {
        throw new GamificationValidationError(
          'El código solo admite letras, números, guion y guion bajo (2-64 caracteres).',
        );
      }
    } else if (!message && !url) {
      throw new GamificationValidationError('Escribe el mensaje o pega el enlace que recibirá.');
    }
    return {
      title: cleanTitle(input.title),
      triggerKind: input.triggerKind,
      levelId: input.triggerKind === 'LEVEL' ? input.levelId! : null,
      points: input.triggerKind === 'POINTS' ? input.points! : null,
      kind: input.kind,
      message,
      url,
      code,
    };
  }

  async listRewards(tenantId: string): Promise<RewardView[]> {
    const [levels, rows] = await Promise.all([
      this.numberedLevels(tenantId),
      this.prisma.modGamificationReward.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        take: LIST_LIMIT,
        include: { _count: { select: { grants: true } } },
      }),
    ]);
    return rows.map((r) => {
      const level = r.levelId ? levels.find((l) => l.id === r.levelId) : undefined;
      return {
        id: r.id,
        title: r.title,
        triggerKind: r.triggerKind as RewardTrigger,
        levelId: r.levelId,
        levelName: level?.name ?? null,
        levelNumber: level?.number ?? null,
        points: r.points,
        kind: r.kind as RewardKind,
        message: r.message,
        url: r.url,
        code: r.code,
        active: r.active,
        grantCount: r._count.grants,
      };
    });
  }

  async createReward(tenantId: string, input: RewardInput): Promise<RewardView> {
    const data = this.validateReward(input);
    if (data.kind === 'CODE' && !(await this.discountCodesAllowed(tenantId))) {
      throw new GamificationCodesUnavailableError();
    }
    if (data.levelId) await this.requireLevel(tenantId, data.levelId);
    const row = await this.prisma.modGamificationReward.create({
      data: { tenantId, ...data, active: input.active ?? true },
    });
    return (await this.listRewards(tenantId)).find((r) => r.id === row.id)!;
  }

  async updateReward(
    tenantId: string,
    id: string,
    patch: Partial<RewardInput>,
  ): Promise<RewardView> {
    const current = (await this.listRewards(tenantId)).find((r) => r.id === id);
    if (!current) throw new GamificationNotFoundError('Premio no encontrado.');
    const merged: RewardInput = {
      title: patch.title ?? current.title,
      triggerKind: patch.triggerKind ?? current.triggerKind,
      levelId: patch.levelId !== undefined ? patch.levelId : current.levelId,
      points: patch.points !== undefined ? patch.points : current.points,
      kind: patch.kind ?? current.kind,
      message: patch.message !== undefined ? patch.message : current.message,
      url: patch.url !== undefined ? patch.url : current.url,
      code: patch.code !== undefined ? patch.code : current.code,
    };
    const data = this.validateReward(merged);
    // Solo al pasar A código: pausar o reactivar uno ya existente no se bloquea.
    if (
      data.kind === 'CODE' &&
      current.kind !== 'CODE' &&
      !(await this.discountCodesAllowed(tenantId))
    ) {
      throw new GamificationCodesUnavailableError();
    }
    if (data.levelId) await this.requireLevel(tenantId, data.levelId);
    await this.prisma.modGamificationReward.updateMany({
      where: { id, tenantId },
      data: { ...data, ...(patch.active !== undefined ? { active: patch.active } : {}) },
    });
    return (await this.listRewards(tenantId)).find((r) => r.id === id)!;
  }

  /** Un premio ya entregado no se borra: el registro tiene que seguir explicándose. */
  async deleteReward(tenantId: string, id: string): Promise<void> {
    try {
      const { count } = await this.prisma.modGamificationReward.deleteMany({
        where: { id, tenantId },
      });
      if (count === 0) throw new GamificationNotFoundError('Premio no encontrado.');
    } catch (e) {
      if (isFkViolation(e)) {
        throw new GamificationConflictError(
          'Este premio ya se ha entregado: desactívalo en lugar de borrarlo.',
        );
      }
      throw e;
    }
  }

  private async requireLevel(tenantId: string, levelId: string): Promise<void> {
    const level = await this.prisma.modGamificationLevel.findFirst({
      where: { id: levelId, tenantId },
      select: { id: true },
    });
    if (!level) throw new GamificationNotFoundError('Nivel no encontrado.');
  }

  /**
   * Entrega los premios que a la persona ya le tocan y aún no tiene. Lo llama
   * el host tras cada punto o subida de nivel: quien ya estaba por encima de un
   * premio creado después lo recibe en su siguiente actividad, sin envíos
   * masivos el día que el creador lo da de alta.
   */
  async grantDueRewards(tenantId: string, userId: string): Promise<RewardGrantView[]> {
    let rewards = await this.prisma.modGamificationReward.findMany({
      where: { tenantId, active: true },
      take: LIST_LIMIT,
    });
    if (rewards.length === 0) return [];
    // Un código creado cuando el aula cobraba con sus claves no se entrega si
    // ahora cobra en el modo plataforma: el checkout lo rechazaría.
    if (rewards.some((r) => r.kind === 'CODE') && !(await this.discountCodesAllowed(tenantId))) {
      rewards = rewards.filter((r) => r.kind !== 'CODE');
      if (rewards.length === 0) return [];
    }
    const levels = await this.numberedLevels(tenantId);
    const progress = await this.progressOf(tenantId, userId, levels);
    const owned = new Set(
      (
        await this.prisma.modGamificationRewardGrant.findMany({
          where: { tenantId, userId, rewardId: { in: rewards.map((r) => r.id) } },
          select: { rewardId: true },
        })
      ).map((g) => g.rewardId),
    );

    const out: RewardGrantView[] = [];
    for (const reward of rewards) {
      if (owned.has(reward.id)) continue;
      let due = false;
      if (reward.triggerKind === 'POINTS' && reward.points !== null) {
        due = progress.lifetimePoints >= reward.points;
      } else if (reward.triggerKind === 'LEVEL' && reward.levelId) {
        const level = levels.find((l) => l.id === reward.levelId);
        due = !!level && hasReached(level, progress);
      }
      if (!due) continue;
      const delivered: DeliveredReward = {
        title: reward.title,
        kind: reward.kind as RewardKind,
        message: reward.message,
        url: reward.url,
        code: reward.code,
      };
      try {
        const grant = await this.prisma.modGamificationRewardGrant.create({
          data: { tenantId, rewardId: reward.id, userId, delivered: delivered as never },
        });
        out.push({
          id: grant.id,
          rewardId: reward.id,
          userId,
          grantedAt: grant.grantedAt,
          delivered,
        });
        await this.publisher.publish(tenantId, userId, RETENTION_EVENT.REWARD_GRANTED, {
          userId,
          grantId: grant.id,
          rewardId: reward.id,
          title: reward.title,
          kind: reward.kind,
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    return out;
  }

  /** Lo que la persona ya ha recibido y lo que le queda por conseguir. */
  async myRewards(
    tenantId: string,
    userId: string,
  ): Promise<{ earned: RewardGrantView[]; upcoming: UpcomingReward[] }> {
    const [grants, rewards, levels] = await Promise.all([
      this.prisma.modGamificationRewardGrant.findMany({
        where: { tenantId, userId },
        orderBy: { grantedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.prisma.modGamificationReward.findMany({
        where: { tenantId, active: true },
        orderBy: { createdAt: 'asc' },
        take: LIST_LIMIT,
      }),
      this.numberedLevels(tenantId),
    ]);
    const progress = await this.progressOf(tenantId, userId, levels);
    const owned = new Set(grants.map((g) => g.rewardId));
    // Un código que no se va a entregar (modo plataforma) no se anuncia.
    const codesOk = rewards.some((r) => r.kind === 'CODE')
      ? await this.discountCodesAllowed(tenantId)
      : true;
    const upcoming: UpcomingReward[] = [];
    for (const r of rewards) {
      if (owned.has(r.id)) continue;
      if (r.kind === 'CODE' && !codesOk) continue;
      const level = r.levelId ? levels.find((l) => l.id === r.levelId) : undefined;
      const target = r.triggerKind === 'LEVEL' ? (level?.minPoints ?? null) : r.points;
      if (target === null) continue;
      // Lo que falta para conseguirlo; el CONTENIDO (código, enlace) no se
      // enseña hasta que se gana.
      upcoming.push({
        id: r.id,
        title: r.title,
        kind: r.kind as RewardKind,
        triggerKind: r.triggerKind as RewardTrigger,
        levelName: level?.name ?? null,
        levelNumber: level?.number ?? null,
        points: r.points,
        pointsMissing: level
          ? pointsMissing(level, progress)
          : Math.max(0, target - progress.lifetimePoints),
      });
    }
    upcoming.sort((a, b) => a.pointsMissing - b.pointsMissing);
    return {
      earned: grants.map((g) => ({
        id: g.id,
        rewardId: g.rewardId,
        userId: g.userId,
        grantedAt: g.grantedAt,
        delivered: g.delivered as unknown as DeliveredReward,
      })),
      upcoming,
    };
  }

  /** Registro de entregas del aula (panel del creador). */
  async listGrants(tenantId: string): Promise<RewardGrantView[]> {
    const grants = await this.prisma.modGamificationRewardGrant.findMany({
      where: { tenantId },
      orderBy: { grantedAt: 'desc' },
      take: LIST_LIMIT,
    });
    return grants.map((g) => ({
      id: g.id,
      rewardId: g.rewardId,
      userId: g.userId,
      grantedAt: g.grantedAt,
      delivered: g.delivered as unknown as DeliveredReward,
    }));
  }

  // ── Celebraciones ──────────────────────────────────────────────────────────

  /**
   * Decide si un hecho se celebra y cómo: añade a la persona al post del día
   * de ese tipo y dice al host si tiene que CREAR el post, ACTUALIZARLO o
   * ESPERAR (otro proceso lo está creando y lo repintará con todos).
   *
   * Idempotente por (tipo, `subjectKey`): el mismo hecho no se celebra dos
   * veces aunque el bus entregue el evento repetido.
   */
  async planCelebration(
    tenantId: string,
    kind: CelebrationKind,
    subjectKey: string,
    entry: CelebrationEntry,
    day: string,
    now = new Date(),
  ): Promise<CelebrationPlan> {
    if (!CELEBRATION_KINDS.includes(kind)) {
      throw new GamificationValidationError('Tipo de celebración desconocido.');
    }
    const settings = await this.getSettings(tenantId);
    if (!settings[CELEBRATION_SETTING[kind]]) return { action: 'skip', reason: 'disabled' };
    const prefs = await this.getPrefs(tenantId, entry.userId);
    if (!prefs.celebrate) return { action: 'skip', reason: 'opted_out' };

    try {
      await this.prisma.modGamificationCelebrationMark.create({
        data: { tenantId, kind, subjectKey: subjectKey.slice(0, 160) },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { action: 'skip', reason: 'duplicate' };
      throw e;
    }

    let row = await this.prisma.modGamificationCelebration.findUnique({
      where: { tenantId_kind_day: { tenantId, kind, day: dayDate(day) } },
    });
    if (!row) {
      try {
        row = await this.prisma.modGamificationCelebration.create({
          data: { tenantId, kind, day: dayDate(day), entries: [] as never },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        row = await this.prisma.modGamificationCelebration.findUnique({
          where: { tenantId_kind_day: { tenantId, kind, day: dayDate(day) } },
        });
      }
    }
    if (!row) throw new GamificationConflictError('No se pudo preparar la celebración.');

    // Añadir la entrada con concurrencia optimista (sin SQL crudo, que se
    // saltaría el contexto de tenant de RLS): si otro proceso escribió entre
    // la lectura y la escritura, se relee y se reintenta.
    let entries: CelebrationEntry[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fresh = await this.prisma.modGamificationCelebration.findFirst({
        where: { id: row.id, tenantId },
      });
      if (!fresh) throw new GamificationNotFoundError('Celebración no encontrada.');
      const current = (fresh.entries as unknown as CelebrationEntry[]) ?? [];
      entries = [
        ...current.filter((e) => e.userId !== entry.userId || e.detail !== entry.detail),
        entry,
      ];
      const { count } = await this.prisma.modGamificationCelebration.updateMany({
        where: { id: row.id, tenantId, updatedAt: fresh.updatedAt },
        data: { entries: entries as never },
      });
      if (count === 1) break;
      if (attempt === 7) throw new GamificationConflictError('Demasiadas celebraciones a la vez.');
    }

    const latest = await this.prisma.modGamificationCelebration.findFirst({
      where: { id: row.id, tenantId },
    });
    if (latest?.postId) {
      return { action: 'update', celebrationId: row.id, postId: latest.postId, entries };
    }
    const { count: claimed } = await this.prisma.modGamificationCelebration.updateMany({
      where: {
        id: row.id,
        tenantId,
        postId: null,
        OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_TTL_MS) } }],
      },
      data: { claimedAt: now },
    });
    return {
      action: claimed === 1 ? 'create' : 'wait',
      celebrationId: row.id,
      postId: null,
      entries,
    };
  }

  async attachCelebrationPost(
    tenantId: string,
    celebrationId: string,
    postId: string,
  ): Promise<CelebrationEntry[]> {
    await this.prisma.modGamificationCelebration.updateMany({
      where: { id: celebrationId, tenantId },
      data: { postId },
    });
    return this.celebrationEntries(tenantId, celebrationId);
  }

  /** Suelta el reclamo si publicar falló: el siguiente hecho lo reintentará. */
  async releaseCelebrationClaim(tenantId: string, celebrationId: string): Promise<void> {
    await this.prisma.modGamificationCelebration.updateMany({
      where: { id: celebrationId, tenantId, postId: null },
      data: { claimedAt: null },
    });
  }

  async celebrationEntries(tenantId: string, celebrationId: string): Promise<CelebrationEntry[]> {
    const row = await this.prisma.modGamificationCelebration.findFirst({
      where: { id: celebrationId, tenantId },
    });
    return ((row?.entries as unknown as CelebrationEntry[]) ?? []).slice();
  }

  /**
   * ¿Es la primera vez que esta persona participa en la comunidad? Es la señal
   * de «se ha presentado». Mira su libro de puntos (posts y comentarios, sin
   * contar el hecho que se está procesando): quien ya había participado antes
   * de encender las celebraciones no recibe una bienvenida a destiempo.
   */
  async isFirstParticipation(
    tenantId: string,
    userId: string,
    currentSourceKey: string,
    occurredAt: Date,
  ): Promise<boolean> {
    // Revocados incluidos: un post oculto por moderación también fue participar.
    const previous = await this.prisma.modGamificationLedgerEntry.count({
      where: {
        tenantId,
        userId,
        ruleKey: { in: ['community.post', 'community.comment'] },
        NOT: { sourceKey: currentSourceKey },
        // Solo lo ANTERIOR: dos posts seguidos no se anulan entre sí.
        occurredAt: { lt: occurredAt },
      },
    });
    return previous === 0;
  }
}
