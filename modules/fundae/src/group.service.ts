/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  CostTipo,
  CostView,
  CreateCostDto,
  CreateGroupDto,
  GroupStatus,
  GroupView,
  UpdateCostDto,
  UpdateGroupDto,
} from './group.dto.js';
import {
  ActionNotFoundError,
  CompanyNotFoundError,
  CostNotFoundError,
  CreditoInsuficienteError,
  FechasInvalidasError,
  GroupCerradoError,
  GroupNotFoundError,
  GroupNumeroDuplicadoError,
  GroupTransicionInvalidaError,
} from './errors.js';
import { FundaeRlptService } from './rlpt.service.js';
import { buildGroupStartXml, type GroupParticipantSnapshot } from './group-xml-export.js';
import { buildGroupEndXml, type GroupParticipantFinalSnapshot } from './group-end-xml-export.js';
import {
  buildAuditZip,
  buildCostsCsv,
  buildParticipantsCsv,
  type CostCsvRow,
  type ParticipantCsvRow,
} from './audit-zip.js';
import { datosContactoSchema } from './company.dto.js';
import type { ActionView, Modalidad } from './dto.js';
import type { CompanyView } from './company.dto.js';

interface GroupRow {
  id: string;
  tenantId: string;
  actionId: string;
  companyId: string;
  numeroGrupo: number;
  modalidad: string;
  fechaInicioPrevista: Date;
  fechaFinPrevista: Date;
  fechaInicioReal: Date | null;
  fechaFinReal: Date | null;
  status: string;
  creditoEstimadoCents: number | null;
  umbralFinalizacionPct: number;
  notas: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CostRow {
  id: string;
  tenantId: string;
  groupId: string;
  tipo: string;
  concepto: string;
  amountCents: number;
  notas: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const VALID_TRANSITIONS: Record<GroupStatus, GroupStatus[]> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

/**
 * Service del grupo bonificable Fundae (LMS-81). Coordina:
 *   - CRUD del grupo y sus costes asociados.
 *   - Transición DRAFT → ACTIVE invocando `FundaeRlptService.assertGroupCanStart`
 *     para enforcar la antelación legal a la RLPT.
 *   - Validación de crédito Fundae al activar (no se permite arrancar
 *     un grupo si la empresa no tiene crédito disponible suficiente para
 *     el `creditoEstimadoCents` declarado).
 *   - Cierre del grupo: bloquea costes posteriores y debita el consumido
 *     real del crédito de la empresa.
 */
export class FundaeGroupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    private readonly rlpt: FundaeRlptService,
  ) {}

  async list(
    tenantId: string,
    opts: { companyId?: string; actionId?: string; status?: GroupStatus } = {},
  ): Promise<GroupView[]> {
    const rows = await this.prisma.modFundaeGroup.findMany({
      where: {
        tenantId,
        ...(opts.companyId ? { companyId: opts.companyId } : {}),
        ...(opts.actionId ? { actionId: opts.actionId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      include: { costs: true },
      orderBy: [{ status: 'asc' }, { fechaInicioPrevista: 'desc' }],
    });
    return rows.map((r) => this.toView(r, r.costs));
  }

  async get(tenantId: string, id: string): Promise<GroupView> {
    const row = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id },
      include: { costs: true },
    });
    if (!row) throw new GroupNotFoundError(id);
    return this.toView(row, row.costs);
  }

  async create(tenantId: string, actorId: string | null, dto: CreateGroupDto): Promise<GroupView> {
    if (new Date(dto.fechaInicioPrevista) > new Date(dto.fechaFinPrevista)) {
      throw new FechasInvalidasError();
    }

    // Validar referencias.
    const action = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id: dto.actionId },
      select: { id: true },
    });
    if (!action) throw new ActionNotFoundError(dto.actionId);
    const company = await this.prisma.modFundaeCompany.findFirst({
      where: { tenantId, id: dto.companyId, deletedAt: null },
      select: { id: true },
    });
    if (!company) throw new CompanyNotFoundError(dto.companyId);

    const numeroGrupo = dto.numeroGrupo ?? (await this.nextNumero(tenantId, dto.actionId));
    if (dto.numeroGrupo) {
      const dup = await this.prisma.modFundaeGroup.findFirst({
        where: { tenantId, actionId: dto.actionId, numeroGrupo: dto.numeroGrupo },
        select: { id: true },
      });
      if (dup) throw new GroupNumeroDuplicadoError(dto.numeroGrupo);
    }

    const created = await this.prisma.modFundaeGroup.create({
      data: {
        id: randomUUID(),
        tenantId,
        actionId: dto.actionId,
        companyId: dto.companyId,
        numeroGrupo,
        modalidad: dto.modalidad,
        fechaInicioPrevista: new Date(dto.fechaInicioPrevista),
        fechaFinPrevista: new Date(dto.fechaFinPrevista),
        creditoEstimadoCents: dto.creditoEstimadoCents ?? null,
        notas: dto.notas ?? null,
      },
      include: { costs: true },
    });
    await this.publish(tenantId, actorId, 'fundae.group.created', {
      groupId: created.id,
      companyId: dto.companyId,
      actionId: dto.actionId,
    });
    this.ctx.logger.info('mod.fundae: group created', {
      tenantId,
      groupId: created.id,
    });
    return this.toView(created, created.costs);
  }

  async update(
    tenantId: string,
    actorId: string | null,
    id: string,
    dto: UpdateGroupDto,
  ): Promise<GroupView> {
    const existing = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id },
    });
    if (!existing) throw new GroupNotFoundError(id);
    if (existing.status === 'CLOSED' || existing.status === 'CANCELLED') {
      throw new GroupCerradoError(id);
    }
    const fechaInicio = dto.fechaInicioPrevista
      ? new Date(dto.fechaInicioPrevista)
      : existing.fechaInicioPrevista;
    const fechaFin = dto.fechaFinPrevista
      ? new Date(dto.fechaFinPrevista)
      : existing.fechaFinPrevista;
    if (fechaInicio > fechaFin) throw new FechasInvalidasError();

    const updated = await this.prisma.modFundaeGroup.update({
      where: { id },
      data: {
        ...(dto.modalidad !== undefined ? { modalidad: dto.modalidad } : {}),
        ...(dto.fechaInicioPrevista !== undefined ? { fechaInicioPrevista: fechaInicio } : {}),
        ...(dto.fechaFinPrevista !== undefined ? { fechaFinPrevista: fechaFin } : {}),
        ...(dto.creditoEstimadoCents !== undefined
          ? { creditoEstimadoCents: dto.creditoEstimadoCents }
          : {}),
        ...(dto.umbralFinalizacionPct !== undefined
          ? { umbralFinalizacionPct: dto.umbralFinalizacionPct }
          : {}),
        ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
      },
      include: { costs: true },
    });
    await this.publish(tenantId, actorId, 'fundae.group.updated', { groupId: id });
    return this.toView(updated, updated.costs);
  }

  /**
   * Transición DRAFT → ACTIVE. Llama al hook RLPT y valida crédito
   * disponible de la empresa (si la empresa declaró total).
   */
  async start(
    tenantId: string,
    actorId: string | null,
    id: string,
    referenceDate: Date = new Date(),
  ): Promise<GroupView> {
    const existing = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id },
      include: { costs: true },
    });
    if (!existing) throw new GroupNotFoundError(id);
    this.assertTransition(existing.status as GroupStatus, 'ACTIVE');

    // Hook fundae.group.before-start (LMS-80).
    await this.rlpt.assertGroupCanStart({
      tenantId,
      companyId: existing.companyId,
      referenceDate,
    });

    // Validación de crédito disponible si la empresa declaró total.
    if (existing.creditoEstimadoCents && existing.creditoEstimadoCents > 0) {
      const company = await this.prisma.modFundaeCompany.findFirst({
        where: { tenantId, id: existing.companyId },
        select: { creditoTotalCents: true, creditoUsadoCents: true },
      });
      if (company?.creditoTotalCents !== null && company?.creditoTotalCents !== undefined) {
        const disponible = company.creditoTotalCents - company.creditoUsadoCents;
        if (disponible < existing.creditoEstimadoCents) {
          throw new CreditoInsuficienteError(disponible, existing.creditoEstimadoCents);
        }
      }
    }

    const updated = await this.prisma.modFundaeGroup.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        fechaInicioReal: referenceDate,
      },
      include: { costs: true },
    });
    await this.publish(tenantId, actorId, 'fundae.group.started', {
      groupId: id,
      companyId: existing.companyId,
    });
    return this.toView(updated, updated.costs);
  }

  /**
   * Cierra el grupo. Suma todos los costes registrados, los acumula al
   * `creditoUsadoCents` de la empresa y bloquea cambios futuros.
   */
  async close(
    tenantId: string,
    actorId: string | null,
    id: string,
    referenceDate: Date = new Date(),
  ): Promise<GroupView> {
    const existing = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id },
      include: { costs: true },
    });
    if (!existing) throw new GroupNotFoundError(id);
    this.assertTransition(existing.status as GroupStatus, 'CLOSED');

    const totalCents = existing.costs.reduce((acc, c) => acc + c.amountCents, 0);

    // El cierre lleva su propio compare-and-swap: `assertTransition` de arriba
    // decide en MEMORIA sobre una lectura anterior, así que un doble clic en
    // "cerrar" pasaba las dos veces y las dos hacían `increment` del crédito
    // consumido de la empresa — doble débito de dinero real de la bonificación.
    // El `status: 'ABIERTO'` en el `where` hace que solo una gane.
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.modFundaeGroup.updateMany({
        where: { id, tenantId, status: existing.status },
        data: { status: 'CLOSED', fechaFinReal: referenceDate },
      });
      // Otro lo cerró entre medias: se reusa el error de transición inválida,
      // que es exactamente lo que ha pasado (CLOSED → CLOSED no vale).
      if (count === 0)
        throw new GroupTransicionInvalidaError(existing.status as GroupStatus, 'CLOSED');

      await tx.modFundaeCompany.update({
        where: { id: existing.companyId },
        data: { creditoUsadoCents: { increment: totalCents } },
      });

      return tx.modFundaeGroup.findFirstOrThrow({
        where: { id, tenantId },
        include: { costs: true },
      });
    });

    await this.publish(tenantId, actorId, 'fundae.group.closed', {
      groupId: id,
      companyId: existing.companyId,
      creditoConsumidoCents: totalCents,
    });
    return this.toView(updated, updated.costs);
  }

  async cancel(tenantId: string, actorId: string | null, id: string): Promise<GroupView> {
    const existing = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id },
      include: { costs: true },
    });
    if (!existing) throw new GroupNotFoundError(id);
    this.assertTransition(existing.status as GroupStatus, 'CANCELLED');
    const updated = await this.prisma.modFundaeGroup.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: { costs: true },
    });
    await this.publish(tenantId, actorId, 'fundae.group.cancelled', { groupId: id });
    return this.toView(updated, updated.costs);
  }

  // -------------------- FINALIZACIÓN (LMS-84) --------------------

  /**
   * Calcula el resultado APTO/NO_APTO/EN_CURSO de cada participante del
   * grupo basado en el progreso de su enrollment del curso de la acción.
   *
   *   - Si la acción no tiene `courseId`: todos los participantes quedan
   *     como EN_CURSO con 0 horas (no podemos inferir progreso).
   *   - Si el participante tiene status REMOVED: queda como NO_APTO.
   *   - Si el progress del enrollment >= umbral: APTO.
   *   - Si no: NO_APTO si el enrollment está completado o el grupo cerrado;
   *     EN_CURSO si todavía está en marcha.
   *
   * Modo `preview=true`: calcula sin persistir (útil para mostrar en UI
   * antes de confirmar). Modo `preview=false`: persiste los snapshots
   * en `mod_fundae_group_participant.{horasAsistidas,progressPercent,resultado,completedAt}`.
   *
   * Nota: NO transiciona el grupo a CLOSED — esa transición sigue siendo
   * explícita vía `close()` (que debita crédito). Aquí sólo se snapshotea
   * el resultado por participante.
   */
  async computeCompletion(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    opts: { umbralOverride?: number; preview?: boolean } = {},
  ): Promise<import('./group.dto.js').GroupCompletionResult> {
    const groupRow = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
    });
    if (!groupRow) throw new GroupNotFoundError(groupId);

    const umbralAplicadoPct = opts.umbralOverride ?? groupRow.umbralFinalizacionPct;
    const preview = opts.preview ?? false;

    const action = await this.prisma.modFundaeAction.findFirst({
      where: { tenantId, id: groupRow.actionId },
      select: { courseId: true, horasFormacion: true },
    });
    if (!action) throw new ActionNotFoundError(groupRow.actionId);

    const participants = await this.prisma.modFundaeGroupParticipant.findMany({
      where: { tenantId, groupId },
      orderBy: { enrolledAt: 'asc' },
    });
    if (participants.length === 0) {
      return {
        groupId,
        umbralAplicadoPct,
        totalParticipantes: 0,
        aptos: 0,
        noAptos: 0,
        enCurso: 0,
        preview,
        participants: [],
      };
    }

    // Resolver enrollments + users en lote.
    const userIds = participants.map((p) => p.userId);
    const [users, enrollments] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      }),
      action.courseId
        ? this.prisma.modLearningEnrollment.findMany({
            where: { tenantId, courseId: action.courseId, userId: { in: userIds } },
            select: { userId: true, progressPercent: true, status: true, completedAt: true },
          })
        : Promise.resolve(
            [] as Array<{
              userId: string;
              progressPercent: number | null;
              status: string;
              completedAt: Date | null;
            }>,
          ),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const enrollByUser = new Map(enrollments.map((e) => [e.userId, e]));

    const groupClosed = groupRow.status === 'CLOSED' || groupRow.status === 'CANCELLED';

    const computed = participants.map((p) => {
      const u = userById.get(p.userId);
      const enrollment = enrollByUser.get(p.userId);
      const progress = enrollment?.progressPercent ?? 0;
      const horas = (action.horasFormacion * progress) / 100;

      let resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO';
      if (p.status === 'REMOVED') {
        resultado = 'NO_APTO';
      } else if (progress >= umbralAplicadoPct) {
        resultado = 'APTO';
      } else if (groupClosed || enrollment?.completedAt) {
        resultado = 'NO_APTO';
      } else {
        resultado = 'EN_CURSO';
      }

      return {
        participantId: p.id,
        userId: p.userId,
        userName: u?.name ?? null,
        userEmail: u?.email ?? null,
        nifAlumno: p.nifAlumno,
        horasAsistidas: roundTwo(horas),
        progressPercent: progress,
        resultado,
      };
    });

    if (!preview) {
      const now = new Date();
      await this.prisma.$transaction(
        computed.map((c) =>
          this.prisma.modFundaeGroupParticipant.update({
            where: { id: c.participantId },
            data: {
              horasAsistidas: c.horasAsistidas,
              progressPercent: c.progressPercent,
              resultado: c.resultado,
              completedAt: now,
            },
          }),
        ),
      );
      await this.publish(tenantId, actorId, 'fundae.group.completion-computed', {
        groupId,
        umbralAplicadoPct,
        totalParticipantes: computed.length,
      });
    }

    const aptos = computed.filter((c) => c.resultado === 'APTO').length;
    const noAptos = computed.filter((c) => c.resultado === 'NO_APTO').length;
    const enCurso = computed.filter((c) => c.resultado === 'EN_CURSO').length;

    return {
      groupId,
      umbralAplicadoPct,
      totalParticipantes: computed.length,
      aptos,
      noAptos,
      enCurso,
      preview,
      participants: computed.map((c) => ({
        ...c,
        completedAt: preview ? null : new Date().toISOString(),
      })),
    };
  }

  // -------------------- XML INICIO (LMS-83) --------------------

  /**
   * Genera el XML de "Comunicación de inicio de grupo" Fundae a partir
   * de las filas actuales de DB. Lee acción, empresa y participantes
   * activos del grupo, los hidrata y delega al builder puro.
   *
   * El service NO valida estado del grupo (DRAFT/ACTIVE/CLOSED) — el
   * caller decide cuándo descargarlo. Conformidad Fundae: lo normal es
   * descargarlo justo antes del start o tras él.
   */
  async generateStartXml(tenantId: string, groupId: string): Promise<string> {
    const groupRow = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      include: { costs: true },
    });
    if (!groupRow) throw new GroupNotFoundError(groupId);
    const groupView = this.toView(groupRow, groupRow.costs);

    const [actionRow, companyRow, participantRows] = await Promise.all([
      this.prisma.modFundaeAction.findFirst({ where: { tenantId, id: groupRow.actionId } }),
      this.prisma.modFundaeCompany.findFirst({ where: { tenantId, id: groupRow.companyId } }),
      this.prisma.modFundaeGroupParticipant.findMany({
        where: { tenantId, groupId, status: 'ENROLLED' },
        orderBy: { enrolledAt: 'asc' },
      }),
    ]);
    if (!actionRow) throw new ActionNotFoundError(groupRow.actionId);
    if (!companyRow) throw new CompanyNotFoundError(groupRow.companyId);

    const actionView: ActionView = {
      id: actionRow.id,
      tenantId: actionRow.tenantId,
      courseId: actionRow.courseId,
      codigoAccion: actionRow.codigoAccion,
      nombre: actionRow.nombre,
      modalidad: actionRow.modalidad as Modalidad,
      horasFormacion: actionRow.horasFormacion,
      fechaInicio: actionRow.fechaInicio,
      fechaFin: actionRow.fechaFin,
      lugar: actionRow.lugar,
      cifCentro: actionRow.cifCentro,
      notas: actionRow.notas,
      status: actionRow.status as ActionView['status'],
      createdAt: actionRow.createdAt.toISOString(),
      updatedAt: actionRow.updatedAt.toISOString(),
    };

    const parsedContacto = datosContactoSchema.safeParse(companyRow.datosContacto ?? {});
    const companyView: CompanyView = {
      id: companyRow.id,
      tenantId: companyRow.tenantId,
      nif: companyRow.nif,
      razonSocial: companyRow.razonSocial,
      cccPrincipal: companyRow.cccPrincipal,
      plantilla: companyRow.plantilla,
      creditoTotalCents: companyRow.creditoTotalCents,
      creditoUsadoCents: companyRow.creditoUsadoCents,
      creditoDisponibleCents:
        companyRow.creditoTotalCents === null
          ? null
          : companyRow.creditoTotalCents - companyRow.creditoUsadoCents,
      datosContacto: parsedContacto.success ? parsedContacto.data : {},
      notas: companyRow.notas,
      createdAt: companyRow.createdAt.toISOString(),
      updatedAt: companyRow.updatedAt.toISOString(),
      deletedAt: companyRow.deletedAt?.toISOString() ?? null,
    };

    const userIds = participantRows.map((p) => p.userId);
    const users =
      userIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          });
    const userById = new Map(users.map((u) => [u.id, u]));

    const participants: GroupParticipantSnapshot[] = participantRows.map((p) => {
      const u = userById.get(p.userId);
      return {
        userId: p.userId,
        nombre: u?.name ?? null,
        email: u?.email ?? '',
        nifAlumno: p.nifAlumno,
        enrolledAt: p.enrolledAt.toISOString(),
      };
    });

    const xml = buildGroupStartXml({
      group: groupView,
      action: actionView,
      company: companyView,
      participants,
    });

    await this.publish(tenantId, null, 'fundae.group.start-xml.generated', {
      groupId,
      participantsCount: participants.length,
      bytes: Buffer.byteLength(xml, 'utf8'),
    });

    return xml;
  }

  /**
   * Genera el XML de "Comunicación de finalización de grupo" Fundae
   * (LMS-85). Lee acción, empresa, participantes (ENROLLED + REMOVED
   * para que el listado nominal sea completo, Fundae lo exige) y costes.
   *
   * Los participantes deben tener `resultado` snapshoteado (vía
   * `computeCompletion` LMS-84) para que el XML tenga sentido. Si no
   * lo tienen, se reportan como NO_APTO con horas=0.
   */
  async generateEndXml(tenantId: string, groupId: string): Promise<string> {
    const groupRow = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      include: { costs: true },
    });
    if (!groupRow) throw new GroupNotFoundError(groupId);
    const groupView = this.toView(groupRow, groupRow.costs);

    const [actionRow, companyRow, participantRows] = await Promise.all([
      this.prisma.modFundaeAction.findFirst({ where: { tenantId, id: groupRow.actionId } }),
      this.prisma.modFundaeCompany.findFirst({ where: { tenantId, id: groupRow.companyId } }),
      // Para finalización incluimos también REMOVED — Fundae exige el
      // listado completo de matriculaciones.
      this.prisma.modFundaeGroupParticipant.findMany({
        where: { tenantId, groupId },
        orderBy: { enrolledAt: 'asc' },
      }),
    ]);
    if (!actionRow) throw new ActionNotFoundError(groupRow.actionId);
    if (!companyRow) throw new CompanyNotFoundError(groupRow.companyId);

    const actionView: ActionView = {
      id: actionRow.id,
      tenantId: actionRow.tenantId,
      courseId: actionRow.courseId,
      codigoAccion: actionRow.codigoAccion,
      nombre: actionRow.nombre,
      modalidad: actionRow.modalidad as Modalidad,
      horasFormacion: actionRow.horasFormacion,
      fechaInicio: actionRow.fechaInicio,
      fechaFin: actionRow.fechaFin,
      lugar: actionRow.lugar,
      cifCentro: actionRow.cifCentro,
      notas: actionRow.notas,
      status: actionRow.status as ActionView['status'],
      createdAt: actionRow.createdAt.toISOString(),
      updatedAt: actionRow.updatedAt.toISOString(),
    };

    const parsedContacto = datosContactoSchema.safeParse(companyRow.datosContacto ?? {});
    const companyView: CompanyView = {
      id: companyRow.id,
      tenantId: companyRow.tenantId,
      nif: companyRow.nif,
      razonSocial: companyRow.razonSocial,
      cccPrincipal: companyRow.cccPrincipal,
      plantilla: companyRow.plantilla,
      creditoTotalCents: companyRow.creditoTotalCents,
      creditoUsadoCents: companyRow.creditoUsadoCents,
      creditoDisponibleCents:
        companyRow.creditoTotalCents === null
          ? null
          : companyRow.creditoTotalCents - companyRow.creditoUsadoCents,
      datosContacto: parsedContacto.success ? parsedContacto.data : {},
      notas: companyRow.notas,
      createdAt: companyRow.createdAt.toISOString(),
      updatedAt: companyRow.updatedAt.toISOString(),
      deletedAt: companyRow.deletedAt?.toISOString() ?? null,
    };

    const userIds = participantRows.map((p) => p.userId);
    const users =
      userIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          });
    const userById = new Map(users.map((u) => [u.id, u]));

    const participants: GroupParticipantFinalSnapshot[] = participantRows.map((p) => {
      const u = userById.get(p.userId);
      const horas =
        p.horasAsistidas === null || p.horasAsistidas === undefined ? 0 : Number(p.horasAsistidas);
      const resultado = (p.resultado ?? 'NO_APTO') as 'APTO' | 'NO_APTO' | 'EN_CURSO';
      return {
        userId: p.userId,
        nombre: u?.name ?? null,
        email: u?.email ?? '',
        nifAlumno: p.nifAlumno,
        enrolledAt: p.enrolledAt.toISOString(),
        horasAsistidas: horas,
        progressPercent: p.progressPercent ?? 0,
        resultado: p.status === 'REMOVED' ? 'NO_APTO' : resultado,
        completedAt: p.completedAt?.toISOString() ?? null,
      };
    });

    // Costes ya vienen en groupRow.costs; construimos CostView directamente.
    const costViews: CostView[] = groupRow.costs.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      groupId: c.groupId,
      tipo: c.tipo as CostTipo,
      concepto: c.concepto,
      amountCents: c.amountCents,
      notas: c.notas,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));

    const xml = buildGroupEndXml({
      group: groupView,
      action: actionView,
      company: companyView,
      participants,
      costs: costViews,
    });

    await this.publish(tenantId, null, 'fundae.group.end-xml.generated', {
      groupId,
      participantsCount: participants.length,
      costsCount: costViews.length,
      bytes: Buffer.byteLength(xml, 'utf8'),
    });

    return xml;
  }

  // -------------------- PAQUETE AUDITORÍA (LMS-86) --------------------

  /**
   * Genera el ZIP completo de auditoría para un grupo bonificable. Contiene:
   *   manifest.json (metadatos + hashes SHA-256)
   *   inicio.xml + finalizacion.xml
   *   participantes.csv + costes.csv
   *   rlpt/notificacion-N.{ext} — adjuntos descargados de Evidence Vault
   *
   * Pensado para entregar a auditor externo o a Fundae sin necesidad de
   * acceder al sistema. Los hashes en manifest.json permiten verificar
   * integridad sin recalcular.
   */
  async generateAuditZip(tenantId: string, groupId: string): Promise<Buffer> {
    const groupRow = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      include: { costs: true },
    });
    if (!groupRow) throw new GroupNotFoundError(groupId);

    const [actionRow, companyRow, participantRows, rlptNotices] = await Promise.all([
      this.prisma.modFundaeAction.findFirst({ where: { tenantId, id: groupRow.actionId } }),
      this.prisma.modFundaeCompany.findFirst({ where: { tenantId, id: groupRow.companyId } }),
      this.prisma.modFundaeGroupParticipant.findMany({
        where: { tenantId, groupId },
        orderBy: { enrolledAt: 'asc' },
      }),
      this.prisma.modFundaeRlptNotice.findMany({
        where: { tenantId, companyId: groupRow.companyId, deletedAt: null },
        orderBy: { fechaNotificacionAt: 'asc' },
      }),
    ]);
    if (!actionRow) throw new ActionNotFoundError(groupRow.actionId);
    if (!companyRow) throw new CompanyNotFoundError(groupRow.companyId);

    // XML start + end (reutiliza la lógica existente — pasamos por los métodos
    // públicos para mantener un solo path de generación XML).
    const [startXml, endXml] = await Promise.all([
      this.generateStartXml(tenantId, groupId),
      this.generateEndXml(tenantId, groupId),
    ]);

    // Hidratar usuarios para el CSV de participantes (mismas filas que
    // el endpoint de participants list).
    const userIds = participantRows.map((p) => p.userId);
    const users =
      userIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          });
    const userById = new Map(users.map((u) => [u.id, u]));

    const participantsCsv = buildParticipantsCsv(
      participantRows.map<ParticipantCsvRow>((p) => {
        const u = userById.get(p.userId);
        const horas =
          p.horasAsistidas === null || p.horasAsistidas === undefined
            ? null
            : Number(p.horasAsistidas);
        return {
          userId: p.userId,
          nifAlumno: p.nifAlumno,
          nombre: u?.name ?? null,
          email: u?.email ?? '',
          enrolledAt: p.enrolledAt.toISOString(),
          status: p.status,
          horasAsistidas: horas,
          progressPercent: p.progressPercent ?? null,
          resultado: p.resultado,
        };
      }),
    );

    const costsCsv = buildCostsCsv(
      groupRow.costs.map<CostCsvRow>((c) => ({
        tipo: c.tipo,
        concepto: c.concepto,
        importeCents: c.amountCents,
        notas: c.notas,
      })),
    );

    // Descargar blobs RLPT de storage. Si una lectura falla (storage caído,
    // entry borrado físicamente), se omite ese adjunto y se anota en notas.
    // El ZIP sigue siendo válido — el auditor verá la referencia en manifest
    // pero sin el archivo. Mejor partial export que crash.
    const rlptAttachments: Array<{ filename: string; blob: Buffer; tipo: string }> = [];
    if (rlptNotices.length > 0) {
      const evidenceIds = rlptNotices.map((n) => n.evidenceEntryId);
      const evidenceEntries = await this.prisma.evidenceVaultEntry.findMany({
        where: { id: { in: evidenceIds } },
        select: { id: true, storageKey: true, contentType: true },
      });
      const entryById = new Map(evidenceEntries.map((e) => [e.id, e]));

      for (const notice of rlptNotices) {
        const entry = entryById.get(notice.evidenceEntryId);
        if (!entry) continue;
        try {
          const blob = await this.ctx.storage.download(entry.storageKey);
          const ext = mimeToExt(entry.contentType ?? 'application/pdf');
          rlptAttachments.push({
            filename: `rlpt/notificacion-${notice.id}.${ext}`,
            blob,
            tipo: notice.tipo,
          });
        } catch (err) {
          this.ctx.logger.warn('mod.fundae: rlpt blob download failed; omitting from audit zip', {
            tenantId,
            noticeId: notice.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const zip = await buildAuditZip({
      groupId,
      numeroGrupo: groupRow.numeroGrupo,
      codigoAccion: actionRow.codigoAccion,
      empresaNif: companyRow.nif,
      generatedAt: new Date(),
      startXml,
      endXml,
      participantsCsv,
      costsCsv,
      rlptAttachments,
    });

    await this.publish(tenantId, null, 'fundae.group.audit-zip.generated', {
      groupId,
      participantsCount: participantRows.length,
      rlptAttachmentsCount: rlptAttachments.length,
      bytes: zip.length,
    });

    return zip;
  }

  // -------------------- COSTES --------------------

  async listCosts(tenantId: string, groupId: string): Promise<CostView[]> {
    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      select: { id: true },
    });
    if (!group) throw new GroupNotFoundError(groupId);
    const rows = await this.prisma.modFundaeCost.findMany({
      where: { tenantId, groupId },
      orderBy: [{ tipo: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toCostView(r));
  }

  async addCost(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    dto: CreateCostDto,
  ): Promise<CostView> {
    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      select: { id: true, status: true },
    });
    if (!group) throw new GroupNotFoundError(groupId);
    if (group.status === 'CLOSED' || group.status === 'CANCELLED') {
      throw new GroupCerradoError(groupId);
    }
    const created = await this.prisma.modFundaeCost.create({
      data: {
        id: randomUUID(),
        tenantId,
        groupId,
        tipo: dto.tipo,
        concepto: dto.concepto,
        amountCents: dto.amountCents,
        notas: dto.notas ?? null,
      },
    });
    await this.publish(tenantId, actorId, 'fundae.cost.added', {
      groupId,
      costId: created.id,
      amountCents: dto.amountCents,
    });
    return this.toCostView(created);
  }

  async updateCost(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    costId: string,
    dto: UpdateCostDto,
  ): Promise<CostView> {
    const cost = await this.prisma.modFundaeCost.findFirst({
      where: { tenantId, id: costId, groupId },
    });
    if (!cost) throw new CostNotFoundError(costId);
    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      select: { status: true },
    });
    if (group?.status === 'CLOSED' || group?.status === 'CANCELLED') {
      throw new GroupCerradoError(groupId);
    }
    const updated = await this.prisma.modFundaeCost.update({
      where: { id: costId },
      data: {
        ...(dto.tipo !== undefined ? { tipo: dto.tipo } : {}),
        ...(dto.concepto !== undefined ? { concepto: dto.concepto } : {}),
        ...(dto.amountCents !== undefined ? { amountCents: dto.amountCents } : {}),
        ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
      },
    });
    await this.publish(tenantId, actorId, 'fundae.cost.updated', { groupId, costId });
    return this.toCostView(updated);
  }

  async removeCost(
    tenantId: string,
    actorId: string | null,
    groupId: string,
    costId: string,
  ): Promise<void> {
    const cost = await this.prisma.modFundaeCost.findFirst({
      where: { tenantId, id: costId, groupId },
    });
    if (!cost) throw new CostNotFoundError(costId);
    const group = await this.prisma.modFundaeGroup.findFirst({
      where: { tenantId, id: groupId },
      select: { status: true },
    });
    if (group?.status === 'CLOSED' || group?.status === 'CANCELLED') {
      throw new GroupCerradoError(groupId);
    }
    await this.prisma.modFundaeCost.delete({ where: { id: costId } });
    await this.publish(tenantId, actorId, 'fundae.cost.removed', { groupId, costId });
  }

  /**
   * Cuenta grupos no terminados (DRAFT/ACTIVE) de una empresa. Usado
   * por `FundaeCompanyService.softDelete` para no perder trazabilidad.
   */
  async countActiveByCompany(tenantId: string, companyId: string): Promise<number> {
    return this.prisma.modFundaeGroup.count({
      where: { tenantId, companyId, status: { in: ['DRAFT', 'ACTIVE'] } },
    });
  }

  // -------------------- helpers --------------------

  private assertTransition(from: GroupStatus, to: GroupStatus): void {
    const allowed = VALID_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new GroupTransicionInvalidaError(from, to);
    }
  }

  private async nextNumero(tenantId: string, actionId: string): Promise<number> {
    const max = await this.prisma.modFundaeGroup.aggregate({
      where: { tenantId, actionId },
      _max: { numeroGrupo: true },
    });
    return (max._max.numeroGrupo ?? 0) + 1;
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

  private toView(row: GroupRow, costs: CostRow[]): GroupView {
    const costsByTipo: Record<CostTipo, number> = {
      DIRECTO: 0,
      INDIRECTO: 0,
      ORGANIZACION: 0,
    };
    let total = 0;
    for (const c of costs) {
      const t = c.tipo as CostTipo;
      costsByTipo[t] = (costsByTipo[t] ?? 0) + c.amountCents;
      total += c.amountCents;
    }
    return {
      id: row.id,
      tenantId: row.tenantId,
      actionId: row.actionId,
      companyId: row.companyId,
      numeroGrupo: row.numeroGrupo,
      modalidad: row.modalidad as 'PRESENCIAL' | 'TELEFORMACION' | 'MIXTA',
      fechaInicioPrevista: row.fechaInicioPrevista.toISOString(),
      fechaFinPrevista: row.fechaFinPrevista.toISOString(),
      fechaInicioReal: row.fechaInicioReal?.toISOString() ?? null,
      fechaFinReal: row.fechaFinReal?.toISOString() ?? null,
      status: row.status as GroupStatus,
      creditoEstimadoCents: row.creditoEstimadoCents,
      creditoConsumidoCents: total,
      costsByTipo,
      umbralFinalizacionPct: row.umbralFinalizacionPct,
      notas: row.notas,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toCostView(row: CostRow): CostView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      groupId: row.groupId,
      tipo: row.tipo as CostTipo,
      concepto: row.concepto,
      amountCents: row.amountCents,
      notas: row.notas,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function roundTwo(n: number): number {
  return Math.round(n * 100) / 100;
}

function mimeToExt(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'bin';
}
