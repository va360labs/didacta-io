import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  ActionStatus,
  ActionView,
  CreateActionDto,
  Modalidad,
  UpdateActionDto,
} from './dto.js';
import {
  ActionNotFoundError,
  CodigoDuplicadoError,
  CourseNotInTenantError,
  FechasInvalidasError,
} from './errors.js';
import { buildActionXml, type ParticipantSnapshot } from './xml-export.js';

export class FundaeService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async list(
    tenantId: string,
    opts: { courseId?: string; status?: ActionStatus } = {},
  ): Promise<ActionView[]> {
    const rows = await this.prisma.modFundaeAction.findMany({
      where: {
        tenantId,
        ...(opts.courseId ? { courseId: opts.courseId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { fechaInicio: 'desc' },
    });
    return rows.map(toView);
  }

  async get(tenantId: string, id: string): Promise<ActionView> {
    const row = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id },
    });
    if (!row) throw new ActionNotFoundError(id);
    return toView(row);
  }

  async create(
    tenantId: string,
    actorId: string | null,
    dto: CreateActionDto,
  ): Promise<ActionView> {
    if (dto.fechaInicio > dto.fechaFin) throw new FechasInvalidasError();

    if (dto.courseId) {
      const course = await this.prisma.modCoursesCourse.findFirst({
        where: { id: dto.courseId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!course) throw new CourseNotInTenantError(dto.courseId);
    }

    const dup = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, codigoAccion: dto.codigoAccion },
      select: { id: true },
    });
    if (dup) throw new CodigoDuplicadoError(dto.codigoAccion);

    const created = await this.prisma.modFundaeAction.create({
      data: {
        id: randomUUID(),
        tenantId,
        courseId: dto.courseId ?? null,
        codigoAccion: dto.codigoAccion,
        nombre: dto.nombre,
        modalidad: dto.modalidad,
        horasFormacion: dto.horasFormacion,
        fechaInicio: dto.fechaInicio,
        fechaFin: dto.fechaFin,
        lugar: dto.lugar ?? null,
        cifCentro: dto.cifCentro ?? null,
        notas: dto.notas ?? null,
        status: 'DRAFT',
      },
    });

    await this.publish(tenantId, actorId, 'fundae.action.created', {
      actionId: created.id,
      codigoAccion: created.codigoAccion,
    });
    this.ctx.logger.info('mod.fundae: action created', {
      tenantId,
      actionId: created.id,
    });
    return toView(created);
  }

  async update(
    tenantId: string,
    actorId: string | null,
    id: string,
    dto: UpdateActionDto,
  ): Promise<ActionView> {
    const existing = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id },
    });
    if (!existing) throw new ActionNotFoundError(id);

    const fechaInicio = dto.fechaInicio ?? existing.fechaInicio;
    const fechaFin = dto.fechaFin ?? existing.fechaFin;
    if (fechaInicio > fechaFin) throw new FechasInvalidasError();

    if (dto.codigoAccion && dto.codigoAccion !== existing.codigoAccion) {
      const dup = await this.prisma.modFundaeAction.findFirst({
        where: { tenantId, codigoAccion: dto.codigoAccion, NOT: { id } },
        select: { id: true },
      });
      if (dup) throw new CodigoDuplicadoError(dto.codigoAccion);
    }

    const updated = await this.prisma.modFundaeAction.update({
      where: { id },
      data: {
        ...(dto.codigoAccion !== undefined ? { codigoAccion: dto.codigoAccion } : {}),
        ...(dto.nombre !== undefined ? { nombre: dto.nombre } : {}),
        ...(dto.modalidad !== undefined ? { modalidad: dto.modalidad } : {}),
        ...(dto.horasFormacion !== undefined ? { horasFormacion: dto.horasFormacion } : {}),
        ...(dto.fechaInicio !== undefined ? { fechaInicio: dto.fechaInicio } : {}),
        ...(dto.fechaFin !== undefined ? { fechaFin: dto.fechaFin } : {}),
        ...(dto.lugar !== undefined ? { lugar: dto.lugar ?? null } : {}),
        ...(dto.cifCentro !== undefined ? { cifCentro: dto.cifCentro ?? null } : {}),
        ...(dto.notas !== undefined ? { notas: dto.notas ?? null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.courseId !== undefined ? { courseId: dto.courseId ?? null } : {}),
      },
    });

    await this.publish(tenantId, actorId, 'fundae.action.updated', { actionId: id });
    return toView(updated);
  }

  async archive(tenantId: string, actorId: string | null, id: string): Promise<void> {
    const existing = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id },
    });
    if (!existing) throw new ActionNotFoundError(id);
    if (existing.status === 'ARCHIVED') return; // idempotente

    await this.prisma.modFundaeAction.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
    await this.publish(tenantId, actorId, 'fundae.action.archived', { actionId: id });
  }

  /**
   * Genera el XML del reporte para una acción formativa. El consumidor
   * (controller) lo devuelve con Content-Type `application/xml`.
   */
  async generateXml(tenantId: string, actorId: string | null, id: string): Promise<string> {
    const action = await this.get(tenantId, id);
    const participants = action.courseId
      ? await this.collectParticipants(tenantId, action.courseId, action.horasFormacion)
      : [];
    const xml = buildActionXml(action, participants);
    await this.publish(tenantId, actorId, 'fundae.export.generated', {
      actionId: action.id,
      participantsCount: participants.length,
      bytes: Buffer.byteLength(xml, 'utf8'),
    });
    return xml;
  }

  /**
   * Cuenta participantes (matriculaciones activas) del curso vinculado a una
   * acción. Devuelve solo el total para uso del UI; el detalle completo se
   * consigue vía `collectParticipants` durante el export.
   */
  async countParticipants(tenantId: string, actionId: string): Promise<number> {
    const action = await this.get(tenantId, actionId);
    if (!action.courseId) return 0;
    return this.prisma.modLearningEnrollment.count({
      where: { tenantId, courseId: action.courseId, status: { not: 'CANCELLED' } },
    });
  }

  /**
   * Resuelve los participantes de una acción Fundae a partir del curso
   * vinculado:
   *  - Lista enrollments NO cancelados.
   *  - Hace JOIN con `User` para obtener nombre + email + DNI futuro.
   *  - Mapea `progressPercent` y `status` a horas asistidas y resultado.
   *
   * El cálculo de horas asistidas es una **estimación**: hours × progressPct/100.
   * Cuando tengamos `mod_learning_session_log` con minutos reales por sesión,
   * podremos sustituir esto por la suma exacta. El admin puede corregir
   * manualmente en el XML antes de subir.
   */
  private async collectParticipants(
    tenantId: string,
    courseId: string,
    totalHours: number,
  ): Promise<ParticipantSnapshot[]> {
    const enrollments = await this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, courseId, status: { not: 'CANCELLED' } },
      orderBy: { enrolledAt: 'asc' },
    });
    if (enrollments.length === 0) return [];

    const userIds = enrollments.map((e) => e.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return enrollments.map((e) => {
      const user = userById.get(e.userId);
      const horasAsistidas = roundHours((totalHours * (e.progressPercent ?? 0)) / 100);
      const passed = e.completedAt !== null && (e.progressPercent ?? 0) >= e.completionThreshold;
      const failed = e.status === 'CANCELLED' || (e.completedAt !== null && !passed);
      const resultado: ParticipantSnapshot['resultado'] = passed
        ? 'APTO'
        : failed
          ? 'NO_APTO'
          : 'EN_CURSO';
      return {
        userId: e.userId,
        nombre: user?.name ?? null,
        email: user?.email ?? '',
        dni: null, // futuro: campo del perfil del usuario
        horasAsistidas,
        resultado,
        enrolledAt: e.enrolledAt.toISOString(),
        completedAt: e.completedAt?.toISOString() ?? null,
      };
    });
  }

  // ------------------- helpers -------------------

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

/**
 * Redondea horas a 0.5 más cercano. Fundae acepta decimales pero el formato
 * habitual es de media hora.
 */
function roundHours(value: number): number {
  return Math.round(value * 2) / 2;
}

function toView(row: {
  id: string;
  tenantId: string;
  courseId: string | null;
  codigoAccion: string;
  nombre: string;
  modalidad: string;
  horasFormacion: number;
  fechaInicio: string;
  fechaFin: string;
  lugar: string | null;
  cifCentro: string | null;
  notas: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): ActionView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    courseId: row.courseId,
    codigoAccion: row.codigoAccion,
    nombre: row.nombre,
    modalidad: row.modalidad as Modalidad,
    horasFormacion: row.horasFormacion,
    fechaInicio: row.fechaInicio,
    fechaFin: row.fechaFin,
    lugar: row.lugar,
    cifCentro: row.cifCentro,
    notas: row.notas,
    status: row.status as ActionStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
