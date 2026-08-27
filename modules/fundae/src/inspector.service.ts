/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import { ActionNotFoundError, GroupNotFoundError, GroupSinCursoError } from './errors.js';
import { loadLessonEvidence } from './evidence-loader.js';
import { computeParticipantEvidence } from './tracking-evidence.js';

/**
 * Acceso de SEGUIMIENTO de una acción bonificada (LMS-123).
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * La instrucción de seguimiento de Fundae dice que el seguimiento se hace
 * accediendo al curso con las claves comunicadas al inicio de la acción. Hasta
 * ahora no había forma limpia de preparar esas claves:
 *
 *   · El rol `auditor` abre el registro de auditoría de TODA la academia, pero
 *     no deja recorrer el curso ni consultar el progreso de nadie.
 *   · Un `alumno` matriculado recorre el curso, pero no ve el progreso de los
 *     demás y aparece en el listado nominal de la acción.
 *   · La única salida que quedaba era entregar una cuenta de administración,
 *     que puede escribir, borrar y ver el resto de acciones y empresas.
 *
 * ── Lo que concede este acceso ──────────────────────────────────────────────
 *
 * Exactamente dos cosas, atadas a UN grupo:
 *
 *   1. Recorrer el curso de la acción, contenido incluido. Se consigue con una
 *      matrícula `source = INSPECTION` porque el contenido se gatea por
 *      matrícula viva y no por rol; `mod.fundae` excluye esa fuente de todo lo
 *      que se comunica (ver `participant-filter.ts`), así que el inspector no
 *      se cuela en el expediente que viene a inspeccionar.
 *   2. Leer el seguimiento de los participantes DE ESE GRUPO: itinerario,
 *      primer y último acceso, tiempo registrado y qué respalda cada
 *      finalización.
 *
 * Y nada más: ni escribe, ni ve los otros grupos, ni toca la configuración. La
 * concesión y la retirada quedan en el registro de auditoría del tenant, y la
 * fila no se borra al revocar — quién pudo mirar un expediente, y cuándo, es
 * parte de lo que sostiene la propia auditoría.
 */

export interface InspectorAccessView {
  id: string;
  groupId: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  grantedAt: string;
  grantedBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Calculado: ni revocado ni caducado. Es lo que decide si abre puertas. */
  activo: boolean;
  notas: string | null;
}

/** Lo que ve el inspector de un participante. Lectura, y solo de su grupo. */
export interface InspectionParticipantView {
  userId: string;
  nombre: string | null;
  email: string | null;
  nifAlumno: string | null;
  horasAsistidas: number;
  horasSinVerificar: number;
  pctHoras: number;
  pctActividades: number;
  leccionesTotales: number;
  leccionesCompletadas: number;
  leccionesVerificadas: number;
  actividadesSuperadas: number;
  actividadesTotales: number;
  primerAccesoAt: string | null;
  ultimoAccesoAt: string | null;
  resultado: string | null;
  /** Recorrido lección a lección, en el orden del itinerario. */
  itinerario: Array<{
    orden: number;
    modulo: string;
    leccion: string;
    tipo: string;
    duracionMinutos: number | null;
    primerAccesoAt: string | null;
    ultimoAccesoAt: string | null;
    segundosRegistrados: number;
    completada: boolean;
    completadaAt: string | null;
    origenCompletado: string | null;
    verificada: boolean;
  }>;
}

export interface InspectionView {
  groupId: string;
  numeroGrupo: number;
  codigoAccion: string;
  denominacion: string;
  horasFormacion: number;
  courseId: string | null;
  fechaInicioPrevista: string;
  fechaFinPrevista: string;
  status: string;
  participants: InspectionParticipantView[];
}

export class FundaeInspectorService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  /**
   * Registra el acceso de seguimiento. NO crea la matrícula: eso lo compone la
   * capa de aplicación llamando a `mod.learning`, que es la dueña de las
   * matrículas. Aquí vive lo que Fundae necesita poder demostrar: a quién se le
   * dio, quién se lo dio, cuándo y hasta cuándo.
   *
   * Idempotente por (tenant, grupo, usuario): volver a concederlo reabre el
   * acceso revocado en lugar de duplicar la fila, y así el rastro es uno solo.
   */
  async grant(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    userId: string,
    opts: { expiresAt?: Date | null; notas?: string | null } = {},
  ): Promise<InspectorAccessView> {
    const group = await this.requireGroup(tenantId, groupId);

    const row = await this.prisma.modFundaeInspectorAccess.upsert({
      where: { tenantId_groupId_userId: { tenantId, groupId, userId } },
      create: {
        tenantId,
        groupId,
        userId,
        grantedBy: actorId,
        expiresAt: opts.expiresAt ?? null,
        notas: opts.notas ?? null,
      },
      update: {
        grantedBy: actorId,
        grantedAt: new Date(),
        expiresAt: opts.expiresAt ?? null,
        revokedAt: null,
        notas: opts.notas ?? null,
      },
    });

    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'fundae.inspector.granted',
      resourceType: 'mod_fundae_inspector_access',
      resourceId: row.id,
      metadata: { groupId, userId, numeroGrupo: group.numeroGrupo },
    });
    await this.publish(tenantId, actorId, 'fundae.inspector.granted', { groupId, userId });

    return this.toView(row, await this.lookupUser(tenantId, userId));
  }

  /**
   * Retira el acceso. La fila se marca, no se borra: el registro de quién pudo
   * mirar el expediente forma parte de la trazabilidad del propio expediente.
   */
  async revoke(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    userId: string,
  ): Promise<void> {
    const { count } = await this.prisma.modFundaeInspectorAccess.updateMany({
      where: { tenantId, groupId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return;

    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'fundae.inspector.revoked',
      resourceType: 'mod_fundae_inspector_access',
      resourceId: `${groupId}:${userId}`,
      metadata: { groupId, userId },
    });
    await this.publish(tenantId, actorId, 'fundae.inspector.revoked', { groupId, userId });
  }

  async list(tenantId: string, groupId: string): Promise<InspectorAccessView[]> {
    const rows = await this.prisma.modFundaeInspectorAccess.findMany({
      where: { tenantId, groupId },
      orderBy: { grantedAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => this.toView(r, byId.get(r.userId) ?? null));
  }

  /** Los grupos que esta persona puede inspeccionar ahora mismo. */
  async listGroupsForInspector(
    tenantId: string,
    userId: string,
  ): Promise<Array<{ groupId: string; numeroGrupo: number; codigoAccion: string }>> {
    const rows = await this.prisma.modFundaeInspectorAccess.findMany({
      where: { tenantId, userId, revokedAt: null },
      select: { groupId: true, expiresAt: true },
    });
    const now = new Date();
    const live = rows.filter((r) => r.expiresAt === null || r.expiresAt > now);
    if (live.length === 0) return [];

    const groups = await this.prisma.modFundaeGroup.findMany({
      where: { tenantId, id: { in: live.map((r) => r.groupId) } },
      select: { id: true, numeroGrupo: true, actionId: true },
    });
    const actions = await this.prisma.modFundaeAction.findMany({
      where: { tenantId, id: { in: groups.map((g) => g.actionId) } },
      select: { id: true, codigoAccion: true },
    });
    const codeById = new Map(actions.map((a) => [a.id, a.codigoAccion]));
    return groups.map((g) => ({
      groupId: g.id,
      numeroGrupo: g.numeroGrupo,
      codigoAccion: codeById.get(g.actionId) ?? '',
    }));
  }

  /**
   * ¿Puede esta persona inspeccionar este grupo AHORA? Devuelve el courseId de
   * la acción, que es lo que el llamante necesita para dar (o quitar) el acceso
   * al contenido. `null` si no.
   */
  async resolveAccess(
    tenantId: string,
    userId: string,
    groupId: string,
  ): Promise<{ courseId: string | null } | null> {
    const row = await this.prisma.modFundaeInspectorAccess.findFirst({
      where: { tenantId, groupId, userId, revokedAt: null },
      select: { expiresAt: true },
    });
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= new Date()) return null;

    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      select: { actionId: true },
    });
    if (!group) return null;
    const action = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id: group.actionId },
      select: { courseId: true },
    });
    return { courseId: action?.courseId ?? null };
  }

  /**
   * El expediente de seguimiento del grupo, en lectura: participantes del grupo
   * con sus horas defendibles y su recorrido lección a lección.
   *
   * Es la misma lectura que alimenta el `seguimiento.csv` del paquete de
   * auditoría — a propósito: lo que el inspector ve en pantalla y lo que se
   * descarga en el ZIP no pueden ser dos cifras distintas.
   */
  async getInspectionView(tenantId: string, groupId: string): Promise<InspectionView> {
    const group = await this.requireGroup(tenantId, groupId);
    const action = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id: group.actionId },
    });
    if (!action) throw new ActionNotFoundError(group.actionId);
    if (!action.courseId) throw new GroupSinCursoError(groupId);

    const participants = await this.prisma.modFundaeGroupParticipant.findMany({
      where: { tenantId, groupId },
      orderBy: { enrolledAt: 'asc' },
    });

    const userIds = participants.map((p) => p.userId);
    const [users, { lessonsByUser, progressByUser }] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([])
        : this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          }),
      loadLessonEvidence(this.prisma, tenantId, action.courseId, userIds),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      groupId: group.id,
      numeroGrupo: group.numeroGrupo,
      codigoAccion: action.codigoAccion,
      denominacion: action.nombre,
      horasFormacion: action.horasFormacion,
      courseId: action.courseId,
      fechaInicioPrevista: group.fechaInicioPrevista.toISOString(),
      fechaFinPrevista: group.fechaFinPrevista.toISOString(),
      status: group.status,
      participants: participants.map((p) => {
        const u = userById.get(p.userId);
        const lessons = lessonsByUser.get(p.userId) ?? [];
        const ev = computeParticipantEvidence(
          lessons,
          action.horasFormacion,
          progressByUser.get(p.userId) ?? 0,
        );
        return {
          userId: p.userId,
          nombre: u?.name ?? null,
          email: u?.email ?? null,
          nifAlumno: p.nifAlumno,
          horasAsistidas: ev.horasAsistidas,
          horasSinVerificar: ev.horasSinVerificar,
          pctHoras: ev.pctHoras,
          pctActividades: ev.pctActividades,
          leccionesTotales: ev.leccionesTotales,
          leccionesCompletadas: ev.leccionesCompletadas,
          leccionesVerificadas: ev.leccionesVerificadas,
          actividadesSuperadas: ev.actividadesSuperadas,
          actividadesTotales: ev.actividadesTotales,
          primerAccesoAt: ev.primerAccesoAt?.toISOString() ?? null,
          ultimoAccesoAt: ev.ultimoAccesoAt?.toISOString() ?? null,
          resultado: p.resultado,
          itinerario: lessons.map((l) => ({
            orden: l.position,
            modulo: l.moduleTitle,
            leccion: l.lessonTitle,
            tipo: l.type,
            duracionMinutos: l.durationMinutes,
            primerAccesoAt: l.firstAccessedAt?.toISOString() ?? null,
            ultimoAccesoAt: l.lastAccessedAt?.toISOString() ?? null,
            segundosRegistrados: l.watchedSeconds,
            completada: l.completed,
            completadaAt: l.completedAt?.toISOString() ?? null,
            origenCompletado: l.completionSource,
            verificada:
              l.completed && l.completionSource !== null && l.completionSource !== 'SELF',
          })),
        };
      }),
    };
  }

  // ─── privados ─────────────────────────────────────────────────────────────

  private async requireGroup(tenantId: string, groupId: string) {
    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
    });
    if (!group) throw new GroupNotFoundError(groupId);
    return group;
  }

  private async lookupUser(tenantId: string, userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, name: true, email: true },
    });
  }

  private toView(
    row: {
      id: string;
      groupId: string;
      userId: string;
      grantedAt: Date;
      grantedBy: string | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
      notas: string | null;
    },
    user: { name: string | null; email: string } | null,
  ): InspectorAccessView {
    const now = new Date();
    return {
      id: row.id,
      groupId: row.groupId,
      userId: row.userId,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      grantedAt: row.grantedAt.toISOString(),
      grantedBy: row.grantedBy,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      activo: row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now),
      notas: row.notas,
    };
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
