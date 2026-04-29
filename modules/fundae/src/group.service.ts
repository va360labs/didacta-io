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

    const [updated] = await this.prisma.$transaction([
      this.prisma.modFundaeGroup.update({
        where: { id },
        data: {
          status: 'CLOSED',
          fechaFinReal: referenceDate,
        },
        include: { costs: true },
      }),
      this.prisma.modFundaeCompany.update({
        where: { id: existing.companyId },
        data: { creditoUsadoCents: { increment: totalCents } },
      }),
    ]);

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
