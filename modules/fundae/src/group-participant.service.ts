import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  BulkEnrollResult,
  EnrollParticipantDto,
  GroupParticipantView,
  ParticipantStatus,
  UpdateParticipantDto,
} from './group-participant.dto.js';
import {
  GroupCerradoError,
  GroupNotFoundError,
  GroupParticipantDuplicadoError,
  GroupParticipantNotEnrolledInCourseError,
  GroupParticipantNotFoundError,
  GroupSinCursoError,
} from './errors.js';

interface ParticipantRow {
  id: string;
  tenantId: string;
  groupId: string;
  userId: string;
  companyId: string;
  nifAlumno: string | null;
  enrolledAt: Date;
  removedAt: Date | null;
  status: string;
  /** Snapshot del cálculo de finalización (LMS-84). */
  horasAsistidas: unknown; // Prisma Decimal | null — convertimos a number en hydrate
  progressPercent: number | null;
  resultado: string | null;
  completedAt: Date | null;
  notas: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service de matriculaciones nominales en grupo bonificable Fundae
 * (LMS-82). Cada matrícula vincula un `userId` con un `groupId`. La
 * empresa se denormaliza en la propia fila para reportes agregados.
 *
 * Reglas:
 *   - El user debe estar matriculado en el curso de la acción del grupo
 *     (consistencia con catálogo).
 *   - No se puede matricular en un grupo CLOSED o CANCELLED.
 *   - El `nifAlumno` se snapshotea al matricular (Fundae exige el NIF
 *     que se comunicó originalmente).
 *   - El borrado es lógico: status=REMOVED + removedAt. Esto deja la
 *     fila para histórico Fundae.
 */
export class FundaeGroupParticipantService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async listByGroup(
    tenantId: string,
    groupId: string,
    opts: { includeRemoved?: boolean } = {},
  ): Promise<GroupParticipantView[]> {
    await this.assertGroupExists(tenantId, groupId);
    const rows = await this.prisma.modFundaeGroupParticipant.findMany({
      where: {
        tenantId,
        groupId,
        ...(opts.includeRemoved ? {} : { status: 'ENROLLED' }),
      },
      orderBy: [{ status: 'asc' }, { enrolledAt: 'asc' }],
    });
    return this.hydrate(rows);
  }

  async enroll(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    dto: EnrollParticipantDto,
  ): Promise<GroupParticipantView> {
    const group = await this.assertGroupOpen(tenantId, groupId);

    // Consistencia con catálogo: si la acción tiene curso, el user debe
    // estar matriculado allí. Si la acción NO tiene curso (legacy),
    // permitimos enrollment manual sin validación.
    const action = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id: group.actionId },
      select: { courseId: true },
    });
    if (action?.courseId) {
      const courseEnrollment = await this.prisma.modLearningEnrollment.findFirst({
        where: {
          tenantId,
          courseId: action.courseId,
          userId: dto.userId,
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      });
      if (!courseEnrollment) {
        throw new GroupParticipantNotEnrolledInCourseError(dto.userId, action.courseId);
      }
    }

    // Resolver el NIF si no llega (snapshot del User).
    let nifSnapshot = dto.nifAlumno ?? null;
    if (!nifSnapshot) {
      const user = await this.prisma.user.findFirst({
        where: { id: dto.userId },
        select: { documentId: true },
      });
      nifSnapshot = user?.documentId ?? null;
    }

    const existing = await this.prisma.modFundaeGroupParticipant.findFirst({
      where: { tenantId, groupId, userId: dto.userId },
    });
    if (existing) {
      // Si está REMOVED, lo reactivamos (UPDATE) — la UNIQUE no permite
      // INSERT duplicado. Si está ENROLLED, error de duplicado.
      if (existing.status === 'ENROLLED') {
        throw new GroupParticipantDuplicadoError(dto.userId, groupId);
      }
      const reactivated = await this.prisma.modFundaeGroupParticipant.update({
        where: { id: existing.id },
        data: {
          status: 'ENROLLED',
          enrolledAt: new Date(),
          removedAt: null,
          nifAlumno: nifSnapshot,
          notas: dto.notas ?? null,
        },
      });
      await this.publish(tenantId, actorId, 'fundae.group.participant.enrolled', {
        groupId,
        participantId: reactivated.id,
        userId: dto.userId,
      });
      const [view] = await this.hydrate([reactivated]);
      return view!;
    }

    const created = await this.prisma.modFundaeGroupParticipant.create({
      data: {
        id: randomUUID(),
        tenantId,
        groupId,
        userId: dto.userId,
        companyId: group.companyId,
        nifAlumno: nifSnapshot,
        notas: dto.notas ?? null,
      },
    });
    await this.publish(tenantId, actorId, 'fundae.group.participant.enrolled', {
      groupId,
      participantId: created.id,
      userId: dto.userId,
    });
    const [view] = await this.hydrate([created]);
    return view!;
  }

  /**
   * Bulk enroll desde el curso del catálogo: matricula a todos los users
   * que tienen enrollment activo en el `courseId` (o el override) y aún
   * no están en el grupo. Idempotente: re-ejecutar no duplica.
   */
  async bulkEnrollFromCourse(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    sourceCourseId?: string,
  ): Promise<BulkEnrollResult> {
    const group = await this.assertGroupOpen(tenantId, groupId);
    let courseId = sourceCourseId;
    if (!courseId) {
      const action = await this.prisma.modFundaeAction.findFirst({
        where: { tenantId, id: group.actionId },
        select: { courseId: true },
      });
      if (!action?.courseId) throw new GroupSinCursoError(groupId);
      courseId = action.courseId;
    }

    const enrollments = await this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, courseId, status: { not: 'CANCELLED' } },
      select: { userId: true },
    });
    if (enrollments.length === 0) {
      return { enrolled: 0, skipped: 0, total: 0 };
    }

    const userIds = enrollments.map((e) => e.userId);
    const existing = await this.prisma.modFundaeGroupParticipant.findMany({
      where: { tenantId, groupId, userId: { in: userIds }, status: 'ENROLLED' },
      select: { userId: true },
    });
    const alreadyIn = new Set(existing.map((e) => e.userId));
    const toAdd = userIds.filter((id) => !alreadyIn.has(id));

    if (toAdd.length === 0) {
      return { enrolled: 0, skipped: enrollments.length, total: enrollments.length };
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: toAdd } },
      select: { id: true, documentId: true },
    });
    const docById = new Map(users.map((u) => [u.id, u.documentId]));

    // Necesitamos diferenciar entre los que nunca existieron y los que
    // están REMOVED (para reactivar vía update). Esto importa por la UNIQUE.
    const removed = await this.prisma.modFundaeGroupParticipant.findMany({
      where: { tenantId, groupId, userId: { in: toAdd }, status: 'REMOVED' },
      select: { id: true, userId: true },
    });
    const removedById = new Map(removed.map((r) => [r.userId, r.id]));
    const newOnes = toAdd.filter((id) => !removedById.has(id));

    const now = new Date();
    await this.prisma.$transaction([
      ...(newOnes.length > 0
        ? [
            this.prisma.modFundaeGroupParticipant.createMany({
              data: newOnes.map((userId) => ({
                id: randomUUID(),
                tenantId,
                groupId,
                userId,
                companyId: group.companyId,
                nifAlumno: docById.get(userId) ?? null,
                enrolledAt: now,
                createdAt: now,
                updatedAt: now,
              })),
            }),
          ]
        : []),
      ...Array.from(removedById.entries()).map(([userId, participantId]) =>
        this.prisma.modFundaeGroupParticipant.update({
          where: { id: participantId },
          data: {
            status: 'ENROLLED',
            enrolledAt: now,
            removedAt: null,
            nifAlumno: docById.get(userId) ?? null,
          },
        }),
      ),
    ]);

    await this.publish(tenantId, actorId, 'fundae.group.participant.bulk-enrolled', {
      groupId,
      enrolled: toAdd.length,
      sourceCourseId: courseId,
    });

    return {
      enrolled: toAdd.length,
      skipped: alreadyIn.size,
      total: enrollments.length,
    };
  }

  async update(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    participantId: string,
    dto: UpdateParticipantDto,
  ): Promise<GroupParticipantView> {
    const row = await this.prisma.modFundaeGroupParticipant.findFirst({
      where: { tenantId, id: participantId, groupId },
    });
    if (!row) throw new GroupParticipantNotFoundError(participantId);
    await this.assertGroupOpen(tenantId, groupId);

    const updated = await this.prisma.modFundaeGroupParticipant.update({
      where: { id: participantId },
      data: {
        ...(dto.nifAlumno !== undefined ? { nifAlumno: dto.nifAlumno } : {}),
        ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
      },
    });
    await this.publish(tenantId, actorId, 'fundae.group.participant.updated', {
      groupId,
      participantId,
    });
    const [view] = await this.hydrate([updated]);
    return view!;
  }

  async remove(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    participantId: string,
  ): Promise<void> {
    const row = await this.prisma.modFundaeGroupParticipant.findFirst({
      where: { tenantId, id: participantId, groupId },
    });
    if (!row) throw new GroupParticipantNotFoundError(participantId);
    await this.assertGroupOpen(tenantId, groupId);
    if (row.status === 'REMOVED') return;
    await this.prisma.modFundaeGroupParticipant.update({
      where: { id: participantId },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    await this.publish(tenantId, actorId, 'fundae.group.participant.removed', {
      groupId,
      participantId,
      userId: row.userId,
    });
  }

  /** Cuenta de participantes ENROLLED de un grupo. */
  async countEnrolled(tenantId: string, groupId: string): Promise<number> {
    return this.prisma.modFundaeGroupParticipant.count({
      where: { tenantId, groupId, status: 'ENROLLED' },
    });
  }

  // -------------------- helpers --------------------

  private async assertGroupExists(
    tenantId: string,
    groupId: string,
  ): Promise<{ actionId: string; companyId: string; status: string }> {
    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      select: { actionId: true, companyId: true, status: true },
    });
    if (!group) throw new GroupNotFoundError(groupId);
    return group;
  }

  private async assertGroupOpen(
    tenantId: string,
    groupId: string,
  ): Promise<{ actionId: string; companyId: string; status: string }> {
    const group = await this.assertGroupExists(tenantId, groupId);
    if (group.status === 'CLOSED' || group.status === 'CANCELLED') {
      throw new GroupCerradoError(groupId);
    }
    return group;
  }

  private async hydrate(rows: ParticipantRow[]): Promise<GroupParticipantView[]> {
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.userId);
      const horas =
        r.horasAsistidas === null || r.horasAsistidas === undefined
          ? null
          : Number(r.horasAsistidas);
      return {
        id: r.id,
        tenantId: r.tenantId,
        groupId: r.groupId,
        userId: r.userId,
        companyId: r.companyId,
        nifAlumno: r.nifAlumno,
        enrolledAt: r.enrolledAt.toISOString(),
        removedAt: r.removedAt?.toISOString() ?? null,
        status: r.status as ParticipantStatus,
        notas: r.notas,
        horasAsistidas: horas,
        progressPercent: r.progressPercent,
        resultado: r.resultado as 'APTO' | 'NO_APTO' | 'EN_CURSO' | null,
        completedAt: r.completedAt?.toISOString() ?? null,
        userName: u?.name ?? null,
        userEmail: u?.email ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  private async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        userId: actorId ?? undefined,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}
