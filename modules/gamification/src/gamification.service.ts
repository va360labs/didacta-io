import type { Prisma, PrismaClient } from '@didacta/database';
import {
  GamificationAlreadyReviewedError,
  GamificationAlreadySubmittedError,
  GamificationChallengeClosedError,
  GamificationConflictError,
  GamificationNotFoundError,
  GamificationValidationError,
} from './errors.js';

/**
 * mod.gamification — dominio puro (sin NestJS).
 *
 * Dos capas deliberadamente distintas:
 *   · ACTIVIDAD — asientos automáticos disparados por eventos del bus, con
 *     pesos bajos y techo diario. Premian constancia, no volumen.
 *   · HITOS — retos con prueba obligatoria y revisión humana, con pesos altos.
 *     Es donde vive la intención de negocio (documentar el caso de éxito).
 *
 * El catálogo lo define el operador: los NIVELES y los RETOS nacen vacíos a
 * propósito (sus nombres y premios son decisiones de marca, no datos que pueda
 * inventar el sistema). Lo único que se siembra en runtime son las REGLAS, con
 * los pesos que ya usaba el ranking anterior para que la migración no altere
 * la clasificación existente.
 */

export interface GamificationEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export const GAMIFICATION_EVENT = {
  POINTS_AWARDED: 'gamification.points.awarded',
  POINTS_REVOKED: 'gamification.points.revoked',
  LEVEL_CHANGED: 'gamification.level.changed',
  CHALLENGE_SUBMITTED: 'gamification.challenge.submitted',
  CHALLENGE_REVIEWED: 'gamification.challenge.reviewed',
} as const;

/**
 * Reglas de actividad. Las dos primeras conservan los pesos del ranking
 * anterior (post × 10, comentario × 5) para que el traspaso no mueva a nadie
 * de puesto; el resto son señales que ya existían en el bus y nadie escuchaba.
 * Todo esto es editable por el operador en /admin/gamificacion.
 */
export const DEFAULT_RULES: ReadonlyArray<{
  key: string;
  points: number;
  dailyCap: number;
}> = [
  { key: 'community.post', points: 10, dailyCap: 3 },
  { key: 'community.comment', points: 5, dailyCap: 10 },
  { key: 'resources.shared', points: 25, dailyCap: 3 },
  { key: 'learning.course', points: 50, dailyCap: 0 },
  { key: 'referrals.converted', points: 50, dailyCap: 0 },
];

/** Regla de los retos: sus puntos salen del propio reto, no del catálogo. */
export const CHALLENGE_RULE_KEY = 'challenge';

export type LeaderboardRange = 'week' | 'month' | 'all';

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const NAME_MAX = 80;
const TITLE_MIN = 3;
const TITLE_MAX = 160;
const TEXT_MAX = 2000;
const NOTE_MAX = 1000;
const LIST_LIMIT = 200;
const LEADERBOARD_LIMIT = 50;
/** Tope de la fotografía en memoria para calcular puesto y percentil. */
const RANKING_SCAN_LIMIT = 5000;

export interface AwardResult {
  awarded: boolean;
  /** Por qué no se acreditó, cuando `awarded` es false. */
  reason?: 'duplicate' | 'rule_disabled' | 'daily_cap' | 'zero_points';
  points?: number;
  lifetimePoints?: number;
  levelChange?: { from: string | null; to: string } | null;
}

export interface LeaderboardRow {
  userId: string;
  points: number;
  rank: number;
}

export interface RuleView {
  key: string;
  points: number;
  dailyCap: number;
  enabled: boolean;
}

export interface LevelView {
  id: string;
  key: string;
  name: string;
  minPoints: number;
  benefitText: string | null;
  benefitKind: 'NONE' | 'ACCESS_GROUP';
  accessGroupId: string | null;
  memberCount?: number;
}

export interface ChallengeView {
  id: string;
  title: string;
  description: string | null;
  points: number;
  proofRequired: boolean;
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  startsAt: Date | null;
  endsAt: Date | null;
  submissionCount?: number;
  /** Estado de la entrega del que consulta, si la hay. */
  mySubmission?: { id: string; status: string; reviewNote: string | null } | null;
}

export interface SubmissionView {
  id: string;
  challengeId: string;
  challengeTitle: string;
  userId: string;
  proofUrl: string | null;
  proofName: string | null;
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function validateKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!KEY_PATTERN.test(key)) {
    throw new GamificationValidationError(
      'La clave solo admite minúsculas, números, punto, guion y guion bajo (2-64 caracteres).',
    );
  }
  return key;
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length < 2 || name.length > NAME_MAX) {
    throw new GamificationValidationError(`El nombre debe tener entre 2 y ${NAME_MAX} caracteres.`);
  }
  return name;
}

function validateTitle(raw: string): string {
  const title = raw.trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    throw new GamificationValidationError(
      `El título debe tener entre ${TITLE_MIN} y ${TITLE_MAX} caracteres.`,
    );
  }
  return title;
}

function validateText(raw: string | null | undefined, max = TEXT_MAX): string | null {
  const text = raw?.trim() || null;
  if (text && text.length > max) {
    throw new GamificationValidationError(`El texto no puede superar ${max} caracteres.`);
  }
  return text;
}

function validatePoints(raw: number, { allowZero = false } = {}): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > 100_000) {
    throw new GamificationValidationError('Los puntos deben ser un entero entre 0 y 100.000.');
  }
  if (!allowZero && raw === 0) {
    throw new GamificationValidationError('Los puntos deben ser mayores que cero.');
  }
  return raw;
}

/** Único prefijo local admitido para la prueba: storage del propio tenant. */
const LOCAL_STORAGE_PREFIX = '/api/v1/storage/file/';

function validateProofUrl(raw: string): string {
  const url = raw.trim();
  if (url.startsWith('/')) {
    if (url.startsWith(LOCAL_STORAGE_PREFIX)) return url;
    throw new GamificationValidationError('La URL de la prueba no es válida.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GamificationValidationError('La URL de la prueba no es válida.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GamificationValidationError('La URL de la prueba debe ser http(s).');
  }
  return url;
}

/**
 * Inicio del rango, en UTC. Conserva la semántica de ventana móvil del ranking
 * anterior (7 días / 1 mes hacia atrás) pero corrige su cálculo: el controller
 * viejo usaba la hora LOCAL del servidor, incoherente con el resto de métricas.
 */
export function rangeStartUtc(range: LeaderboardRange, now: Date): Date | undefined {
  if (range === 'all') return undefined;
  if (range === 'week') {
    return new Date(now.getTime() - 7 * 24 * 3_600_000);
  }
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d;
}

/** Comienzo del día UTC de una fecha (para el techo diario por regla). */
export function dayStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export class GamificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: GamificationEventPublisher,
  ) {}

  // ── Ledger ─────────────────────────────────────────────────────────────────

  /**
   * Acredita puntos por un HECHO. Es idempotente por (tenant, usuario,
   * `sourceKey`): el bus entrega al menos una vez y su `idempotencyKey` lleva
   * Date.now(), así que la única defensa real contra el doble cobro es esta
   * unique. Reintentar la misma llamada devuelve `awarded: false`.
   *
   * Si no se pasan `points`, se toman de la regla del catálogo (y se aplica su
   * techo diario). Con `points` explícitos —retos, ajustes— no hay techo.
   */
  async award(args: {
    tenantId: string;
    userId: string;
    ruleKey: string;
    sourceKey: string;
    occurredAt?: Date;
    points?: number;
    meta?: Record<string, unknown>;
    /**
     * Ignora el techo diario. Lo usa el relleno del histórico: el techo es una
     * regla nueva y aplicarla hacia atrás castigaría a quien publicó cuando no
     * existía, además de mover el ranking que se está migrando.
     */
    skipDailyCap?: boolean;
  }): Promise<AwardResult> {
    const occurredAt = args.occurredAt ?? new Date();
    let points = args.points;
    let dailyCap = 0;

    if (points === undefined) {
      const rule = await this.prisma.modGamificationRule.findUnique({
        where: { tenantId_key: { tenantId: args.tenantId, key: args.ruleKey } },
      });
      // Sin fila todavía (tenant que no ha abierto el panel): se usa el default.
      const fallback = DEFAULT_RULES.find((r) => r.key === args.ruleKey);
      if (!rule && !fallback) return { awarded: false, reason: 'rule_disabled' };
      if (rule && !rule.enabled) return { awarded: false, reason: 'rule_disabled' };
      points = rule ? rule.points : fallback!.points;
      dailyCap = args.skipDailyCap ? 0 : rule ? rule.dailyCap : fallback!.dailyCap;
    }

    if (points <= 0) return { awarded: false, reason: 'zero_points' };

    let result: AwardResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        if (dailyCap > 0) {
          const sameDay = await tx.modGamificationLedgerEntry.count({
            where: {
              tenantId: args.tenantId,
              userId: args.userId,
              ruleKey: args.ruleKey,
              revokedAt: null,
              occurredAt: { gte: dayStartUtc(occurredAt) },
            },
          });
          if (sameDay >= dailyCap) {
            return { awarded: false, reason: 'daily_cap' as const };
          }
        }

        await tx.modGamificationLedgerEntry.create({
          data: {
            tenantId: args.tenantId,
            userId: args.userId,
            ruleKey: args.ruleKey,
            points: points!,
            sourceKey: args.sourceKey,
            occurredAt,
            meta: (args.meta ?? undefined) as never,
          },
        });

        const profile = await tx.modGamificationProfile.upsert({
          where: { tenantId_userId: { tenantId: args.tenantId, userId: args.userId } },
          update: { lifetimePoints: { increment: points! } },
          create: {
            tenantId: args.tenantId,
            userId: args.userId,
            lifetimePoints: points!,
          },
        });

        const levelChange = await this.applyLevel(
          tx,
          args.tenantId,
          args.userId,
          profile.lifetimePoints,
          profile.levelKey,
        );

        return {
          awarded: true,
          points: points!,
          lifetimePoints: profile.lifetimePoints,
          levelChange,
        };
      });
    } catch (e) {
      // Ya estaba acreditado: reintento del bus o doble emisión del módulo.
      if (isUniqueViolation(e)) return { awarded: false, reason: 'duplicate' };
      throw e;
    }

    if (result.awarded) {
      await this.publisher.publish(args.tenantId, args.userId, GAMIFICATION_EVENT.POINTS_AWARDED, {
        userId: args.userId,
        ruleKey: args.ruleKey,
        points: result.points,
        sourceKey: args.sourceKey,
      });
      if (result.levelChange) {
        await this.publisher.publish(args.tenantId, args.userId, GAMIFICATION_EVENT.LEVEL_CHANGED, {
          userId: args.userId,
          from: result.levelChange.from,
          to: result.levelChange.to,
        });
      }
    }
    return result;
  }

  /**
   * Revoca los asientos de un hecho (contenido borrado u ocultado). No borra la
   * fila: la marca, para que el histórico siga siendo auditable. El nivel NO
   * baja aunque bajen los puntos — quitarle un nivel a alguien por moderar un
   * post viejo sería peor que el problema que resuelve.
   */
  async revoke(args: {
    tenantId: string;
    sourceKey: string;
    reason: string;
  }): Promise<{ revoked: number }> {
    const entries = await this.prisma.modGamificationLedgerEntry.findMany({
      where: { tenantId: args.tenantId, sourceKey: args.sourceKey, revokedAt: null },
      select: { id: true, userId: true, points: true },
    });
    if (entries.length === 0) return { revoked: 0 };

    await this.prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        const { count } = await tx.modGamificationLedgerEntry.updateMany({
          where: { id: entry.id, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: args.reason.slice(0, 300) },
        });
        // Otra pasada ya lo revocó: no descontar dos veces.
        if (count !== 1) continue;
        await tx.modGamificationProfile.updateMany({
          where: { tenantId: args.tenantId, userId: entry.userId },
          data: { lifetimePoints: { decrement: entry.points } },
        });
      }
    });

    for (const entry of entries) {
      await this.publisher.publish(args.tenantId, null, GAMIFICATION_EVENT.POINTS_REVOKED, {
        userId: entry.userId,
        points: entry.points,
        sourceKey: args.sourceKey,
      });
    }
    return { revoked: entries.length };
  }

  /**
   * Sube de nivel si toca. Solo hacia arriba: los puntos de por vida pueden
   * bajar por una revocación, pero el nivel alcanzado no se retira.
   */
  private async applyLevel(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    lifetimePoints: number,
    currentKey: string | null,
  ): Promise<{ from: string | null; to: string } | null> {
    const target = await tx.modGamificationLevel.findFirst({
      where: { tenantId, minPoints: { lte: lifetimePoints } },
      orderBy: { minPoints: 'desc' },
    });
    if (!target || target.key === currentKey) return null;

    if (currentKey) {
      const current = await tx.modGamificationLevel.findUnique({
        where: { tenantId_key: { tenantId, key: currentKey } },
      });
      if (current && current.minPoints >= target.minPoints) return null;
    }

    await tx.modGamificationProfile.updateMany({
      where: { tenantId, userId },
      data: { levelKey: target.key, levelReachedAt: new Date() },
    });
    return { from: currentKey, to: target.key };
  }

  // ── Ranking ────────────────────────────────────────────────────────────────

  /**
   * Ranking del tenant. Suma el ledger por usuario en el rango (por `occurredAt`,
   * así el histórico relleno cae en su fecha real) y descarta los revocados.
   * Devuelve también el total de clasificados: el percentil «Top X%» del perfil
   * se calculaba antes contra la lista truncada a 50 y salía mal.
   */
  async leaderboard(
    tenantId: string,
    range: LeaderboardRange,
    limit = LEADERBOARD_LIMIT,
    now = new Date(),
  ): Promise<{ rows: LeaderboardRow[]; total: number }> {
    const since = rangeStartUtc(range, now);
    const grouped = await this.prisma.modGamificationLedgerEntry.groupBy({
      by: ['userId'],
      where: {
        tenantId,
        revokedAt: null,
        ...(since ? { occurredAt: { gte: since } } : {}),
      },
      _sum: { points: true },
      orderBy: { _sum: { points: 'desc' } },
      take: RANKING_SCAN_LIMIT,
    });

    const ranked = grouped
      .map((g) => ({ userId: g.userId, points: g._sum.points ?? 0 }))
      .filter((r) => r.points > 0)
      .sort((a, b) =>
        b.points === a.points ? a.userId.localeCompare(b.userId) : b.points - a.points,
      );

    return {
      total: ranked.length,
      rows: ranked
        .slice(0, Math.min(limit, LEADERBOARD_LIMIT))
        .map((r, i) => ({ ...r, rank: i + 1 })),
    };
  }

  /** Puesto y saldo de una persona, para su perfil. */
  async standing(
    tenantId: string,
    userId: string,
    range: LeaderboardRange = 'all',
    now = new Date(),
  ): Promise<{
    points: number;
    rank: number | null;
    total: number;
    lifetimePoints: number;
    levelKey: string | null;
    levelName: string | null;
  }> {
    const [board, profile] = await Promise.all([
      this.leaderboard(tenantId, range, LEADERBOARD_LIMIT, now),
      this.prisma.modGamificationProfile.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
      }),
    ]);

    // El puesto se busca sobre el conjunto completo, no sobre el top 50.
    const since = rangeStartUtc(range, now);
    const mine = await this.prisma.modGamificationLedgerEntry.aggregate({
      where: {
        tenantId,
        userId,
        revokedAt: null,
        ...(since ? { occurredAt: { gte: since } } : {}),
      },
      _sum: { points: true },
    });
    const points = mine._sum.points ?? 0;

    let rank: number | null = null;
    if (points > 0) {
      const ahead = await this.prisma.modGamificationLedgerEntry.groupBy({
        by: ['userId'],
        where: {
          tenantId,
          revokedAt: null,
          ...(since ? { occurredAt: { gte: since } } : {}),
        },
        _sum: { points: true },
        orderBy: { _sum: { points: 'desc' } },
        take: RANKING_SCAN_LIMIT,
      });
      rank = ahead.filter((g) => (g._sum.points ?? 0) > points).length + 1;
    }

    let levelName: string | null = null;
    if (profile?.levelKey) {
      const level = await this.prisma.modGamificationLevel.findUnique({
        where: { tenantId_key: { tenantId, key: profile.levelKey } },
      });
      levelName = level?.name ?? null;
    }

    return {
      points,
      rank,
      total: board.total,
      lifetimePoints: profile?.lifetimePoints ?? 0,
      levelKey: profile?.levelKey ?? null,
      levelName,
    };
  }

  /** Últimos asientos de una persona, para poder explicarle sus puntos. */
  async myHistory(tenantId: string, userId: string, limit = 50) {
    const entries = await this.prisma.modGamificationLedgerEntry.findMany({
      where: { tenantId, userId },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(limit, LIST_LIMIT),
    });
    return entries.map((e) => ({
      id: e.id,
      ruleKey: e.ruleKey,
      points: e.points,
      occurredAt: e.occurredAt,
      revoked: e.revokedAt !== null,
    }));
  }

  // ── Reglas ─────────────────────────────────────────────────────────────────

  /** Catálogo de reglas; siembra los valores por defecto en el primer listado. */
  async listRules(tenantId: string): Promise<RuleView[]> {
    let rules = await this.prisma.modGamificationRule.findMany({
      where: { tenantId },
      orderBy: { key: 'asc' },
    });
    if (rules.length === 0) {
      await this.seedRules(tenantId);
      rules = await this.prisma.modGamificationRule.findMany({
        where: { tenantId },
        orderBy: { key: 'asc' },
      });
    }
    return rules.map((r) => ({
      key: r.key,
      points: r.points,
      dailyCap: r.dailyCap,
      enabled: r.enabled,
    }));
  }

  /** Idempotente: la unique (tenant, key) absorbe la carrera entre dos listados. */
  private async seedRules(tenantId: string): Promise<void> {
    for (const rule of DEFAULT_RULES) {
      try {
        await this.prisma.modGamificationRule.create({
          data: {
            tenantId,
            key: rule.key,
            points: rule.points,
            dailyCap: rule.dailyCap,
          },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
  }

  async updateRule(
    tenantId: string,
    key: string,
    patch: { points?: number; dailyCap?: number; enabled?: boolean },
  ): Promise<RuleView> {
    await this.listRules(tenantId);
    const data: Record<string, unknown> = {};
    if (patch.points !== undefined)
      data['points'] = validatePoints(patch.points, { allowZero: true });
    if (patch.dailyCap !== undefined) {
      if (!Number.isInteger(patch.dailyCap) || patch.dailyCap < 0 || patch.dailyCap > 1000) {
        throw new GamificationValidationError('El techo diario debe estar entre 0 y 1000.');
      }
      data['dailyCap'] = patch.dailyCap;
    }
    if (patch.enabled !== undefined) data['enabled'] = patch.enabled;

    const { count } = await this.prisma.modGamificationRule.updateMany({
      where: { tenantId, key },
      data,
    });
    if (count === 0) throw new GamificationNotFoundError('Regla no encontrada.');

    const updated = await this.prisma.modGamificationRule.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    return {
      key: updated!.key,
      points: updated!.points,
      dailyCap: updated!.dailyCap,
      enabled: updated!.enabled,
    };
  }

  // ── Niveles (los define el operador) ───────────────────────────────────────

  async listLevels(tenantId: string): Promise<LevelView[]> {
    const levels = await this.prisma.modGamificationLevel.findMany({
      where: { tenantId },
      orderBy: { minPoints: 'asc' },
      take: LIST_LIMIT,
    });
    return levels.map((l) => ({
      id: l.id,
      key: l.key,
      name: l.name,
      minPoints: l.minPoints,
      benefitText: l.benefitText,
      benefitKind: l.benefitKind as 'NONE' | 'ACCESS_GROUP',
      accessGroupId: l.accessGroupId,
    }));
  }

  async createLevel(args: {
    tenantId: string;
    key: string;
    name: string;
    minPoints: number;
    benefitText?: string | null;
    benefitKind?: 'NONE' | 'ACCESS_GROUP';
    accessGroupId?: string | null;
  }): Promise<LevelView> {
    const key = validateKey(args.key);
    const name = validateName(args.name);
    const minPoints = validatePoints(args.minPoints, { allowZero: true });
    const benefitKind = args.benefitKind ?? 'NONE';
    if (benefitKind === 'ACCESS_GROUP' && !args.accessGroupId) {
      throw new GamificationValidationError(
        'Elige el grupo de acceso al que entra quien alcance el nivel.',
      );
    }
    try {
      const level = await this.prisma.modGamificationLevel.create({
        data: {
          tenantId: args.tenantId,
          key,
          name,
          minPoints,
          benefitText: validateText(args.benefitText),
          benefitKind,
          accessGroupId: benefitKind === 'ACCESS_GROUP' ? args.accessGroupId! : null,
        },
      });
      await this.recomputeLevels(args.tenantId);
      return {
        id: level.id,
        key: level.key,
        name: level.name,
        minPoints: level.minPoints,
        benefitText: level.benefitText,
        benefitKind: level.benefitKind as 'NONE' | 'ACCESS_GROUP',
        accessGroupId: level.accessGroupId,
      };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new GamificationConflictError(
          'Ya existe un nivel con esa clave o con ese mínimo de puntos.',
        );
      }
      throw e;
    }
  }

  async updateLevel(
    tenantId: string,
    id: string,
    patch: {
      name?: string;
      minPoints?: number;
      benefitText?: string | null;
      benefitKind?: 'NONE' | 'ACCESS_GROUP';
      accessGroupId?: string | null;
    },
  ): Promise<LevelView> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data['name'] = validateName(patch.name);
    if (patch.minPoints !== undefined) {
      data['minPoints'] = validatePoints(patch.minPoints, { allowZero: true });
    }
    if (patch.benefitText !== undefined) data['benefitText'] = validateText(patch.benefitText);
    if (patch.benefitKind !== undefined) {
      data['benefitKind'] = patch.benefitKind;
      if (patch.benefitKind === 'NONE') data['accessGroupId'] = null;
    }
    if (patch.accessGroupId !== undefined && patch.benefitKind !== 'NONE') {
      data['accessGroupId'] = patch.accessGroupId;
    }

    try {
      const { count } = await this.prisma.modGamificationLevel.updateMany({
        where: { id, tenantId },
        data,
      });
      if (count === 0) throw new GamificationNotFoundError('Nivel no encontrado.');
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new GamificationConflictError('Ya hay otro nivel con ese mínimo de puntos.');
      }
      throw e;
    }

    await this.recomputeLevels(tenantId);
    const level = await this.prisma.modGamificationLevel.findFirst({ where: { id, tenantId } });
    return {
      id: level!.id,
      key: level!.key,
      name: level!.name,
      minPoints: level!.minPoints,
      benefitText: level!.benefitText,
      benefitKind: level!.benefitKind as 'NONE' | 'ACCESS_GROUP',
      accessGroupId: level!.accessGroupId,
    };
  }

  async deleteLevel(tenantId: string, id: string): Promise<void> {
    const { count } = await this.prisma.modGamificationLevel.deleteMany({
      where: { id, tenantId },
    });
    if (count === 0) throw new GamificationNotFoundError('Nivel no encontrado.');
    await this.recomputeLevels(tenantId);
  }

  /**
   * Reasigna el nivel de todos los perfiles tras tocar el catálogo. Son tantas
   * consultas como niveles (no como usuarios), y solo escribe en las filas que
   * cambian de verdad, así que `levelReachedAt` no se falsea.
   */
  async recomputeLevels(tenantId: string): Promise<void> {
    const levels = await this.prisma.modGamificationLevel.findMany({
      where: { tenantId },
      orderBy: { minPoints: 'asc' },
      take: LIST_LIMIT,
    });
    const now = new Date();

    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i]!;
      const next = levels[i + 1];
      await this.prisma.modGamificationProfile.updateMany({
        where: {
          tenantId,
          lifetimePoints: {
            gte: level.minPoints,
            ...(next ? { lt: next.minPoints } : {}),
          },
          OR: [{ levelKey: null }, { levelKey: { not: level.key } }],
        },
        data: { levelKey: level.key, levelReachedAt: now },
      });
    }

    const lowest = levels[0]?.minPoints;
    await this.prisma.modGamificationProfile.updateMany({
      where: {
        tenantId,
        ...(lowest !== undefined ? { lifetimePoints: { lt: lowest } } : {}),
        NOT: { levelKey: null },
      },
      data: { levelKey: null, levelReachedAt: null },
    });
  }

  // ── Retos (los define el operador) ─────────────────────────────────────────

  /** Retos visibles para un alumno: solo los abiertos y dentro de fechas. */
  async listOpenChallenges(
    tenantId: string,
    userId: string,
    now = new Date(),
  ): Promise<ChallengeView[]> {
    const challenges = await this.prisma.modGamificationChallenge.findMany({
      where: { tenantId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    const visible = challenges.filter((c) => this.isWithinWindow(c.startsAt, c.endsAt, now));
    if (visible.length === 0) return [];

    const mine = await this.prisma.modGamificationSubmission.findMany({
      where: { tenantId, userId, challengeId: { in: visible.map((c) => c.id) } },
    });
    const byChallenge = new Map(mine.map((s) => [s.challengeId, s]));

    return visible.map((c) => {
      const submission = byChallenge.get(c.id);
      return {
        id: c.id,
        title: c.title,
        description: c.description,
        points: c.points,
        proofRequired: c.proofRequired,
        status: c.status as 'DRAFT' | 'OPEN' | 'CLOSED',
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        mySubmission: submission
          ? { id: submission.id, status: submission.status, reviewNote: submission.reviewNote }
          : null,
      };
    });
  }

  /** Todos los retos con su recuento de entregas (panel del operador). */
  async listChallengesForAdmin(tenantId: string): Promise<ChallengeView[]> {
    const challenges = await this.prisma.modGamificationChallenge.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { _count: { select: { submissions: true } } },
    });
    return challenges.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      points: c.points,
      proofRequired: c.proofRequired,
      status: c.status as 'DRAFT' | 'OPEN' | 'CLOSED',
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      submissionCount: c._count.submissions,
    }));
  }

  async createChallenge(args: {
    tenantId: string;
    createdById: string;
    title: string;
    description?: string | null;
    points: number;
    proofRequired?: boolean;
    status?: 'DRAFT' | 'OPEN' | 'CLOSED';
    startsAt?: Date | null;
    endsAt?: Date | null;
  }): Promise<ChallengeView> {
    const title = validateTitle(args.title);
    const points = validatePoints(args.points);
    this.assertWindow(args.startsAt ?? null, args.endsAt ?? null);

    const challenge = await this.prisma.modGamificationChallenge.create({
      data: {
        tenantId: args.tenantId,
        createdById: args.createdById,
        title,
        description: validateText(args.description),
        points,
        proofRequired: args.proofRequired ?? true,
        status: args.status ?? 'DRAFT',
        startsAt: args.startsAt ?? null,
        endsAt: args.endsAt ?? null,
      },
    });
    return {
      id: challenge.id,
      title: challenge.title,
      description: challenge.description,
      points: challenge.points,
      proofRequired: challenge.proofRequired,
      status: challenge.status as 'DRAFT' | 'OPEN' | 'CLOSED',
      startsAt: challenge.startsAt,
      endsAt: challenge.endsAt,
      submissionCount: 0,
    };
  }

  async updateChallenge(
    tenantId: string,
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      points?: number;
      proofRequired?: boolean;
      status?: 'DRAFT' | 'OPEN' | 'CLOSED';
      startsAt?: Date | null;
      endsAt?: Date | null;
    },
  ): Promise<void> {
    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) data['title'] = validateTitle(patch.title);
    if (patch.description !== undefined) data['description'] = validateText(patch.description);
    if (patch.points !== undefined) data['points'] = validatePoints(patch.points);
    if (patch.proofRequired !== undefined) data['proofRequired'] = patch.proofRequired;
    if (patch.status !== undefined) data['status'] = patch.status;
    if (patch.startsAt !== undefined) data['startsAt'] = patch.startsAt;
    if (patch.endsAt !== undefined) data['endsAt'] = patch.endsAt;
    if (patch.startsAt !== undefined || patch.endsAt !== undefined) {
      const current = await this.prisma.modGamificationChallenge.findFirst({
        where: { id, tenantId },
      });
      if (!current) throw new GamificationNotFoundError('Reto no encontrado.');
      this.assertWindow(
        patch.startsAt !== undefined ? patch.startsAt : current.startsAt,
        patch.endsAt !== undefined ? patch.endsAt : current.endsAt,
      );
    }

    const { count } = await this.prisma.modGamificationChallenge.updateMany({
      where: { id, tenantId },
      data,
    });
    if (count === 0) throw new GamificationNotFoundError('Reto no encontrado.');
  }

  /**
   * Borra un reto. Las entregas caen en cascada, pero los puntos ya acreditados
   * NO se revocan: se ganaron y el asiento sigue explicando por qué.
   */
  async deleteChallenge(tenantId: string, id: string): Promise<void> {
    const { count } = await this.prisma.modGamificationChallenge.deleteMany({
      where: { id, tenantId },
    });
    if (count === 0) throw new GamificationNotFoundError('Reto no encontrado.');
  }

  // ── Entregas ───────────────────────────────────────────────────────────────

  /** Entrega del alumno. Una por reto y persona: la unique corta el reenvío. */
  async submitChallenge(args: {
    tenantId: string;
    userId: string;
    challengeId: string;
    proofUrl?: string | null;
    proofName?: string | null;
    note?: string | null;
    now?: Date;
  }): Promise<{ id: string; status: string }> {
    const now = args.now ?? new Date();
    const challenge = await this.prisma.modGamificationChallenge.findFirst({
      where: { id: args.challengeId, tenantId: args.tenantId },
    });
    if (!challenge) throw new GamificationNotFoundError('Reto no encontrado.');
    if (
      challenge.status !== 'OPEN' ||
      !this.isWithinWindow(challenge.startsAt, challenge.endsAt, now)
    ) {
      throw new GamificationChallengeClosedError();
    }

    const proofUrl = args.proofUrl?.trim() ? validateProofUrl(args.proofUrl) : null;
    if (challenge.proofRequired && !proofUrl) {
      throw new GamificationValidationError(
        'Este reto exige adjuntar la prueba: sube el archivo o pega el enlace.',
      );
    }

    try {
      const submission = await this.prisma.modGamificationSubmission.create({
        data: {
          tenantId: args.tenantId,
          challengeId: args.challengeId,
          userId: args.userId,
          proofUrl,
          proofName: validateText(args.proofName, 200),
          note: validateText(args.note, NOTE_MAX),
        },
      });
      await this.publisher.publish(
        args.tenantId,
        args.userId,
        GAMIFICATION_EVENT.CHALLENGE_SUBMITTED,
        { submissionId: submission.id, challengeId: args.challengeId, userId: args.userId },
      );
      return { id: submission.id, status: submission.status };
    } catch (e) {
      if (isUniqueViolation(e)) throw new GamificationAlreadySubmittedError();
      throw e;
    }
  }

  async listSubmissions(
    tenantId: string,
    filter: { status?: 'PENDING' | 'APPROVED' | 'REJECTED'; challengeId?: string } = {},
  ): Promise<SubmissionView[]> {
    const submissions = await this.prisma.modGamificationSubmission.findMany({
      where: {
        tenantId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.challengeId ? { challengeId: filter.challengeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { challenge: { select: { title: true } } },
    });
    return submissions.map((s) => ({
      id: s.id,
      challengeId: s.challengeId,
      challengeTitle: s.challenge.title,
      userId: s.userId,
      proofUrl: s.proofUrl,
      proofName: s.proofName,
      note: s.note,
      status: s.status as 'PENDING' | 'APPROVED' | 'REJECTED',
      reviewNote: s.reviewNote,
      reviewedAt: s.reviewedAt,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Revisión del staff. Aprobar acredita los puntos del reto con `sourceKey`
   * derivado de la entrega, así que una doble revisión no paga dos veces: la
   * transición PENDING→revisado es un updateMany condicionado y solo gana uno.
   */
  async reviewSubmission(args: {
    tenantId: string;
    submissionId: string;
    reviewerId: string;
    approve: boolean;
    reviewNote?: string | null;
  }): Promise<{ status: 'APPROVED' | 'REJECTED'; awarded: boolean }> {
    const submission = await this.prisma.modGamificationSubmission.findFirst({
      where: { id: args.submissionId, tenantId: args.tenantId },
      include: { challenge: { select: { points: true, title: true } } },
    });
    if (!submission) throw new GamificationNotFoundError('Entrega no encontrada.');
    if (submission.status !== 'PENDING') throw new GamificationAlreadyReviewedError();

    const status = args.approve ? 'APPROVED' : 'REJECTED';
    const { count } = await this.prisma.modGamificationSubmission.updateMany({
      where: { id: args.submissionId, tenantId: args.tenantId, status: 'PENDING' },
      data: {
        status,
        reviewedById: args.reviewerId,
        reviewedAt: new Date(),
        reviewNote: validateText(args.reviewNote, NOTE_MAX),
      },
    });
    if (count !== 1) throw new GamificationAlreadyReviewedError();

    let awarded = false;
    if (args.approve) {
      const result = await this.award({
        tenantId: args.tenantId,
        userId: submission.userId,
        ruleKey: CHALLENGE_RULE_KEY,
        sourceKey: `${CHALLENGE_RULE_KEY}:${submission.id}`,
        points: submission.challenge.points,
        meta: { challengeId: submission.challengeId, title: submission.challenge.title },
      });
      awarded = result.awarded;
    }

    await this.publisher.publish(
      args.tenantId,
      args.reviewerId,
      GAMIFICATION_EVENT.CHALLENGE_REVIEWED,
      {
        submissionId: submission.id,
        challengeId: submission.challengeId,
        userId: submission.userId,
        status,
      },
    );
    return { status, awarded };
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────

  private isWithinWindow(startsAt: Date | null, endsAt: Date | null, now: Date): boolean {
    if (startsAt && now < startsAt) return false;
    if (endsAt && now > endsAt) return false;
    return true;
  }

  private assertWindow(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new GamificationValidationError(
        'La fecha de cierre debe ser posterior a la de apertura.',
      );
    }
  }
}
