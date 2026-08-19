/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  ActionStatus,
  ActionView,
  BlockView,
  CreateActionDto,
  CreateBlockDto,
  Modalidad,
  UpdateActionDto,
  UpdateBlockDto,
} from './dto.js';
import {
  ActionNotFoundError,
  ActionWithoutCourseError,
  BlockHoursExceedActionError,
  BlockNotFoundError,
  BlockOrdinalDuplicadoError,
  CodigoDuplicadoError,
  CourseNotInTenantError,
  FechasInvalidasError,
  ParticipantNotInActionError,
} from './errors.js';
import { renderEvidencePdf } from './evidence-pdf.js';
import { buildPresentationZip } from './zip-package.js';
import { buildActionXml, type ParticipantSnapshot, type BlockSnapshot } from './xml-export.js';

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
    const [participants, blocks] = await Promise.all([
      action.courseId
        ? this.collectParticipants(tenantId, action.courseId, action.horasFormacion)
        : Promise.resolve([] as ParticipantSnapshot[]),
      this.collectBlocks(tenantId, action.id),
    ]);
    const xml = buildActionXml(action, participants, blocks);
    await this.publish(tenantId, actorId, 'fundae.export.generated', {
      actionId: action.id,
      participantsCount: participants.length,
      blocksCount: blocks.length,
      bytes: Buffer.byteLength(xml, 'utf8'),
    });
    return xml;
  }

  /**
   * Genera el PDF de evidencia para un participante concreto de una
   * acción. Requiere que la acción tenga `courseId` set y que el usuario
   * tenga una matriculación NO cancelada en ese curso.
   *
   * El PDF se construye en memoria; el caller (controller) decide si lo
   * cachea en object storage o lo sirve directo.
   */
  async generateEvidencePdf(
    tenantId: string,
    actionId: string,
    userId: string,
    signer: { name: string; title?: string | null },
  ): Promise<Buffer> {
    const action = await this.get(tenantId, actionId);
    if (!action.courseId) throw new ActionWithoutCourseError(actionId);

    const enrollment = await this.prisma.modLearningEnrollment.findFirst({
      where: { tenantId, courseId: action.courseId, userId, status: { not: 'CANCELLED' } },
    });
    if (!enrollment) throw new ParticipantNotInActionError(userId);

    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, name: true, email: true, documentId: true },
    });
    if (!user) throw new ParticipantNotInActionError(userId);

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { name: true },
    });

    const horasAsistidas = roundHours(
      (action.horasFormacion * (enrollment.progressPercent ?? 0)) / 100,
    );
    const passed =
      enrollment.completedAt !== null &&
      (enrollment.progressPercent ?? 0) >= enrollment.completionThreshold;
    const failed =
      enrollment.status === 'CANCELLED' || (enrollment.completedAt !== null && !passed);
    const resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO' = passed
      ? 'APTO'
      : failed
        ? 'NO_APTO'
        : 'EN_CURSO';

    return renderEvidencePdf({
      action,
      centerName: tenant?.name ?? 'Centro impartidor',
      cifCentro: action.cifCentro,
      participantName: user.name ?? user.email,
      participantEmail: user.email,
      participantDni: user.documentId,
      horasAsistidas,
      resultado,
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt,
      signerName: signer.name,
      signerTitle: signer.title,
    });
  }

  /**
   * Empaqueta el XML de la acción + un PDF de evidencia por participante
   * en un único ZIP listo para subir a Fundae. Si la acción no tiene
   * curso vinculado, el ZIP solo contiene el XML.
   */
  async generatePresentationZip(
    tenantId: string,
    actorId: string | null,
    actionId: string,
    signer: { name: string; title?: string | null },
  ): Promise<Buffer> {
    const action = await this.get(tenantId, actionId);
    const xml = await this.generateXml(tenantId, actorId, actionId);

    const evidences: Array<{ filename: string; pdfData: Buffer }> = [];
    if (action.courseId) {
      const enrollments = await this.prisma.modLearningEnrollment.findMany({
        where: { tenantId, courseId: action.courseId, status: { not: 'CANCELLED' } },
        orderBy: { enrolledAt: 'asc' },
      });
      const userIds = enrollments.map((e) => e.userId);
      // Generamos los PDFs secuencialmente: pdfkit es CPU-bound y N suele
      // ser bajo (≤ 50). Si necesitamos más, paralelizamos con `pMap`.
      for (const userId of userIds) {
        try {
          const pdf = await this.generateEvidencePdf(tenantId, actionId, userId, signer);
          const slug = await this.evidenceFilenameFor(tenantId, userId);
          evidences.push({ filename: slug, pdfData: pdf });
        } catch (e) {
          this.ctx.logger.warn('mod.fundae: error generando evidencia, se omite del ZIP', {
            actionId,
            userId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const zip = await buildPresentationZip({
      xmlFilename: `accion-${action.codigoAccion}.xml`,
      xmlContent: xml,
      evidences,
    });

    await this.publish(tenantId, actorId, 'fundae.zip.generated', {
      actionId,
      evidencesCount: evidences.length,
      bytes: zip.byteLength,
    });
    return zip;
  }

  /**
   * Resuelve un nombre de archivo predecible para el PDF de evidencia
   * dentro del ZIP. Prefiere DNI (legible para el reviewer Fundae) y cae
   * a un slug del email si no hay DNI.
   */
  private async evidenceFilenameFor(tenantId: string, userId: string): Promise<string> {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { documentId: true, email: true },
    });
    if (u?.documentId) return `evidencia-${u.documentId}.pdf`;
    const slug = (u?.email ?? userId).split('@')[0]!.replace(/[^a-zA-Z0-9._-]/g, '_');
    // El local-part del email NO es único: `ana@empresa-a.com` y
    // `ana@empresa-b.com` daban el mismo nombre y una de las dos evidencias
    // desaparecía del ZIP que se le manda a Fundae. Se desempata con el
    // principio del id, que sigue siendo legible para el revisor.
    return `evidencia-${slug}-${userId.slice(0, 8)}.pdf`;
  }

  /**
   * Resuelve el perfil del firmante (admin) para usar en evidencias y
   * ZIP. Devuelve `null` si el usuario no existe o no pertenece al
   * tenant — el caller decide el fallback.
   */
  async resolveSignerProfile(
    tenantId: string,
    userId: string,
  ): Promise<{ name: string | null; email: string } | null> {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { name: true, email: true },
    });
    return u ?? null;
  }

  /**
   * Lista los bloques (módulos formativos) de una acción ordenados por
   * `ordinal` ascendente.
   */
  async listBlocks(tenantId: string, actionId: string): Promise<BlockView[]> {
    // get() ya valida que la acción exista y pertenezca al tenant.
    await this.get(tenantId, actionId);
    const rows = await this.prisma.modFundaeBlock.findMany({
      where: { tenantId, actionId },
      orderBy: { ordinal: 'asc' },
    });
    return rows.map(toBlockView);
  }

  async createBlock(
    tenantId: string,
    actorId: string | null,
    actionId: string,
    dto: CreateBlockDto,
  ): Promise<BlockView> {
    const action = await this.get(tenantId, actionId);
    const existing = await this.prisma.modFundaeBlock.findMany({
      where: { tenantId, actionId },
      orderBy: { ordinal: 'asc' },
    });

    // Validar que la suma de horas no supere las de la acción.
    const newTotal = existing.reduce((acc, b) => acc + b.hours, 0) + dto.hours;
    if (newTotal > action.horasFormacion + 1e-6) {
      throw new BlockHoursExceedActionError(round(newTotal), action.horasFormacion);
    }

    // Si no se provee ordinal, usar el siguiente.
    const ordinal =
      dto.ordinal ?? (existing.length === 0 ? 1 : Math.max(...existing.map((b) => b.ordinal)) + 1);
    if (existing.some((b) => b.ordinal === ordinal)) {
      throw new BlockOrdinalDuplicadoError(ordinal);
    }

    const created = await this.prisma.modFundaeBlock.create({
      data: {
        id: randomUUID(),
        tenantId,
        actionId,
        ordinal,
        title: dto.title,
        hours: dto.hours,
        modalidad: dto.modalidad,
        contenidos: dto.contenidos ?? '',
      },
    });

    await this.publish(tenantId, actorId, 'fundae.block.created', {
      actionId,
      blockId: created.id,
      ordinal,
    });
    return toBlockView(created);
  }

  async updateBlock(
    tenantId: string,
    actorId: string | null,
    actionId: string,
    blockId: string,
    dto: UpdateBlockDto,
  ): Promise<BlockView> {
    const action = await this.get(tenantId, actionId);
    const existing = await this.prisma.modFundaeBlock.findFirst({
      where: { tenantId, actionId, id: blockId },
    });
    if (!existing) throw new BlockNotFoundError(blockId);

    // Si cambia el ordinal, asegurarse de que no choca con otro bloque.
    if (dto.ordinal !== undefined && dto.ordinal !== existing.ordinal) {
      const collision = await this.prisma.modFundaeBlock.findFirst({
        where: { tenantId, actionId, ordinal: dto.ordinal, NOT: { id: blockId } },
      });
      if (collision) throw new BlockOrdinalDuplicadoError(dto.ordinal);
    }

    // Si cambian las horas, recalcular el total y validar.
    if (dto.hours !== undefined && dto.hours !== existing.hours) {
      const others = await this.prisma.modFundaeBlock.findMany({
        where: { tenantId, actionId, NOT: { id: blockId } },
        select: { hours: true },
      });
      const newTotal = others.reduce((acc, b) => acc + b.hours, 0) + dto.hours;
      if (newTotal > action.horasFormacion + 1e-6) {
        throw new BlockHoursExceedActionError(round(newTotal), action.horasFormacion);
      }
    }

    const updated = await this.prisma.modFundaeBlock.update({
      where: { id: blockId },
      data: {
        ...(dto.ordinal !== undefined ? { ordinal: dto.ordinal } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.hours !== undefined ? { hours: dto.hours } : {}),
        ...(dto.modalidad !== undefined ? { modalidad: dto.modalidad } : {}),
        ...(dto.contenidos !== undefined ? { contenidos: dto.contenidos } : {}),
      },
    });

    await this.publish(tenantId, actorId, 'fundae.block.updated', {
      actionId,
      blockId,
    });
    return toBlockView(updated);
  }

  async deleteBlock(
    tenantId: string,
    actorId: string | null,
    actionId: string,
    blockId: string,
  ): Promise<void> {
    await this.get(tenantId, actionId);
    const existing = await this.prisma.modFundaeBlock.findFirst({
      where: { tenantId, actionId, id: blockId },
    });
    if (!existing) throw new BlockNotFoundError(blockId);
    await this.prisma.modFundaeBlock.delete({ where: { id: blockId } });
    await this.publish(tenantId, actorId, 'fundae.block.deleted', { actionId, blockId });
  }

  private async collectBlocks(tenantId: string, actionId: string): Promise<BlockSnapshot[]> {
    const rows = await this.prisma.modFundaeBlock.findMany({
      where: { tenantId, actionId },
      orderBy: { ordinal: 'asc' },
    });
    return rows.map((b) => ({
      ordinal: b.ordinal,
      title: b.title,
      hours: b.hours,
      modalidad: b.modalidad as Modalidad,
      contenidos: b.contenidos,
    }));
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
   * Lista los participantes (datos del User + enrollment) de una acción
   * para uso del UI admin: permite generar evidencias PDF por persona.
   * Devuelve `[]` si la acción no tiene curso vinculado.
   */
  async listParticipants(
    tenantId: string,
    actionId: string,
  ): Promise<
    Array<{
      userId: string;
      name: string | null;
      email: string;
      documentId: string | null;
      progressPercent: number;
      enrolledAt: string;
      completedAt: string | null;
      status: 'APTO' | 'NO_APTO' | 'EN_CURSO';
    }>
  > {
    const action = await this.get(tenantId, actionId);
    if (!action.courseId) return [];
    const enrollments = await this.prisma.modLearningEnrollment.findMany({
      where: { tenantId, courseId: action.courseId, status: { not: 'CANCELLED' } },
      orderBy: { enrolledAt: 'asc' },
    });
    if (enrollments.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: enrollments.map((e) => e.userId) } },
      select: { id: true, name: true, email: true, documentId: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return enrollments.map((e) => {
      const u = byId.get(e.userId);
      const passed = e.completedAt !== null && (e.progressPercent ?? 0) >= e.completionThreshold;
      const failed = e.status === 'CANCELLED' || (e.completedAt !== null && !passed);
      const status: 'APTO' | 'NO_APTO' | 'EN_CURSO' = passed
        ? 'APTO'
        : failed
          ? 'NO_APTO'
          : 'EN_CURSO';
      return {
        userId: e.userId,
        name: u?.name ?? null,
        email: u?.email ?? '',
        documentId: u?.documentId ?? null,
        progressPercent: e.progressPercent ?? 0,
        enrolledAt: e.enrolledAt.toISOString(),
        completedAt: e.completedAt?.toISOString() ?? null,
        status,
      };
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
      select: { id: true, email: true, name: true, documentId: true },
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
        dni: user?.documentId ?? null,
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

/**
 * Redondeo defensivo a 2 decimales para mensajes de error (evita
 * "13.000000000001 supera 13").
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toBlockView(row: {
  id: string;
  actionId: string;
  ordinal: number;
  title: string;
  hours: number;
  modalidad: string;
  contenidos: string;
  createdAt: Date;
  updatedAt: Date;
}): BlockView {
  return {
    id: row.id,
    actionId: row.actionId,
    ordinal: row.ordinal,
    title: row.title,
    hours: row.hours,
    modalidad: row.modalidad as Modalidad,
    contenidos: row.contenidos,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
