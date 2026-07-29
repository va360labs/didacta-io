import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';

const BATCH = 500;

export interface BackfillSummary {
  posts: number;
  comments: number;
  resources: number;
  courses: number;
  referrals: number;
  /** Asientos realmente creados (los repetidos se descartan por la unique). */
  awarded: number;
}

/**
 * Rellena el ledger con la actividad que ya existía antes de que hubiera
 * ledger, para que el ranking no arranque de cero al migrar.
 *
 * Tres decisiones que conviene tener presentes:
 *
 * · Cada asiento va con la fecha REAL del hecho (`occurredAt`), no la de la
 *   importación, así los rangos «esta semana» y «este mes» siguen dando lo
 *   mismo que antes.
 * · Se salta el techo diario: es una regla nueva y aplicarla hacia atrás
 *   castigaría a quien publicó cuando no existía.
 * · Se excluye lo que el ranking viejo contaba por error: contenido oculto por
 *   moderación y posts publicados con API key.
 *
 * Es idempotente por la unique del ledger: repetirlo no duplica nada.
 */
@Injectable()
export class GamificationBackfillService {
  private readonly logger = new Logger(GamificationBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  async run(tenantId: string): Promise<BackfillSummary> {
    const summary: BackfillSummary = {
      posts: 0,
      comments: 0,
      resources: 0,
      courses: 0,
      referrals: 0,
      awarded: 0,
    };
    // Siembra el catálogo antes de acreditar, para respetar pesos ya editados.
    await this.registry.getGamificationService().listRules(tenantId);

    summary.awarded += await this.each(
      (cursor) =>
        this.prisma.modCommunityPost.findMany({
          where: { tenantId, deletedAt: null, hiddenAt: null, NOT: { source: 'api' } },
          select: { id: true, authorId: true, createdAt: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        summary.posts += 1;
        return {
          tenantId,
          userId: row.authorId,
          ruleKey: 'community.post',
          sourceKey: `community.post:${row.id}`,
          occurredAt: row.createdAt,
          meta: { postId: row.id, backfill: true },
        };
      },
    );

    summary.awarded += await this.each(
      (cursor) =>
        this.prisma.modCommunityComment.findMany({
          where: { tenantId, deletedAt: null, hiddenAt: null },
          select: { id: true, authorId: true, createdAt: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        summary.comments += 1;
        return {
          tenantId,
          userId: row.authorId,
          ruleKey: 'community.comment',
          sourceKey: `community.comment:${row.id}`,
          occurredAt: row.createdAt,
          meta: { commentId: row.id, backfill: true },
        };
      },
    );

    summary.awarded += await this.each(
      (cursor) =>
        this.prisma.modResourcesResource.findMany({
          where: { tenantId },
          select: { id: true, createdById: true, createdAt: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        summary.resources += 1;
        return {
          tenantId,
          userId: row.createdById,
          ruleKey: 'resources.shared',
          sourceKey: `resources.shared:${row.id}`,
          occurredAt: row.createdAt,
          meta: { resourceId: row.id, backfill: true },
        };
      },
    );

    summary.awarded += await this.each(
      (cursor) =>
        this.prisma.modLearningEnrollment.findMany({
          where: { tenantId, status: 'COMPLETED', completedAt: { not: null } },
          select: { id: true, userId: true, courseId: true, completedAt: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        summary.courses += 1;
        return {
          tenantId,
          userId: row.userId,
          ruleKey: 'learning.course',
          sourceKey: `learning.course:${row.id}`,
          occurredAt: row.completedAt!,
          meta: { courseId: row.courseId, backfill: true },
        };
      },
    );

    summary.awarded += await this.each(
      (cursor) =>
        this.prisma.modReferralsReferral.findMany({
          where: { tenantId },
          select: { id: true, referrerUserId: true, attributedAt: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        summary.referrals += 1;
        return {
          tenantId,
          userId: row.referrerUserId,
          ruleKey: 'referrals.converted',
          sourceKey: `referrals.converted:${row.id}`,
          occurredAt: row.attributedAt,
          meta: { referralId: row.id, backfill: true },
        };
      },
    );

    this.logger.log(`Relleno de gamificación del tenant ${tenantId}: ${JSON.stringify(summary)}`);
    return summary;
  }

  /** Pagina por cursor y acredita cada fila. Devuelve los asientos creados. */
  private async each<T extends { id: string }>(
    page: (cursor: string | undefined) => Promise<T[]>,
    toAward: (row: T) => {
      tenantId: string;
      userId: string;
      ruleKey: string;
      sourceKey: string;
      occurredAt: Date;
      meta: Record<string, unknown>;
    },
  ): Promise<number> {
    const service = this.registry.getGamificationService();
    let cursor: string | undefined;
    let awarded = 0;

    for (;;) {
      const rows = await page(cursor);
      if (rows.length === 0) break;
      for (const row of rows) {
        const result = await service.award({ ...toAward(row), skipDailyCap: true });
        if (result.awarded) awarded += 1;
      }
      if (rows.length < BATCH) break;
      cursor = rows[rows.length - 1]!.id;
    }
    return awarded;
  }
}
