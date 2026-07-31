/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  CompanyView,
  CreateCompanyDto,
  DatosContactoDto,
  UpdateCompanyDto,
} from './company.dto.js';
import { datosContactoSchema } from './company.dto.js';
import {
  CompanyNifDuplicadoError,
  CompanyNotFoundError,
  CompanyTieneGruposActivosError,
} from './errors.js';
import { normalizeSpanishTaxId } from './spanish-tax-id.js';

/**
 * CRUD de empresas bonificadas Fundae (LMS-79). Los grupos formativos
 * (LMS-81) se vincularán por `companyId` cuando se implementen — al
 * borrar una empresa con grupos activos el service retorna un error
 * dedicado para que la UI muestre un mensaje claro.
 */
export class FundaeCompanyService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async list(
    tenantId: string,
    opts: { search?: string; includeDeleted?: boolean } = {},
  ): Promise<CompanyView[]> {
    const rows = await this.prisma.modFundaeCompany.findMany({
      where: {
        tenantId,
        ...(opts.includeDeleted ? {} : { deletedAt: null }),
        ...(opts.search
          ? {
              OR: [
                { nif: { contains: normalizeSpanishTaxId(opts.search) } },
                { razonSocial: { contains: opts.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ deletedAt: 'asc' }, { razonSocial: 'asc' }],
    });
    return rows.map(toView);
  }

  async get(tenantId: string, id: string): Promise<CompanyView> {
    const row = await this.prisma.modFundaeCompany.findFirst({
      where: { tenantId, id },
    });
    if (!row) throw new CompanyNotFoundError(id);
    return toView(row);
  }

  async create(
    tenantId: string,
    actorId: string | null,
    dto: CreateCompanyDto,
  ): Promise<CompanyView> {
    // El schema ya normalizó + validó el NIF — aquí sólo verificamos
    // que no choca con otra empresa del tenant (incluyendo soft-deleted
    // para evitar fricción si el admin reactiva).
    const dup = await this.prisma.modFundaeCompany.findFirst({
      where: { tenantId, nif: dto.nif },
      select: { id: true, deletedAt: true },
    });
    if (dup) throw new CompanyNifDuplicadoError(dto.nif);

    const created = await this.prisma.modFundaeCompany.create({
      data: {
        id: randomUUID(),
        tenantId,
        nif: dto.nif,
        razonSocial: dto.razonSocial,
        cccPrincipal: dto.cccPrincipal ?? null,
        plantilla: dto.plantilla ?? null,
        creditoTotalCents: dto.creditoTotalCents ?? null,
        creditoUsadoCents: 0,
        datosContacto: dto.datosContacto ?? {},
        notas: dto.notas ?? null,
      },
    });

    await this.publish(tenantId, actorId, 'fundae.company.created', {
      companyId: created.id,
      nif: created.nif,
    });
    this.ctx.logger.info('mod.fundae: company created', {
      tenantId,
      companyId: created.id,
    });
    return toView(created);
  }

  async update(
    tenantId: string,
    actorId: string | null,
    id: string,
    dto: UpdateCompanyDto,
  ): Promise<CompanyView> {
    const existing = await this.prisma.modFundaeCompany.findFirst({
      where: { tenantId, id },
    });
    if (!existing) throw new CompanyNotFoundError(id);

    const updated = await this.prisma.modFundaeCompany.update({
      where: { id },
      data: {
        ...(dto.razonSocial !== undefined ? { razonSocial: dto.razonSocial } : {}),
        ...(dto.cccPrincipal !== undefined ? { cccPrincipal: dto.cccPrincipal } : {}),
        ...(dto.plantilla !== undefined ? { plantilla: dto.plantilla } : {}),
        ...(dto.creditoTotalCents !== undefined
          ? { creditoTotalCents: dto.creditoTotalCents }
          : {}),
        ...(dto.datosContacto !== undefined ? { datosContacto: dto.datosContacto } : {}),
        ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
      },
    });

    await this.publish(tenantId, actorId, 'fundae.company.updated', {
      companyId: id,
    });
    return toView(updated);
  }

  /**
   * Soft-delete. La fila se conserva para que los grupos cerrados
   * sigan teniendo trazabilidad. Si todavía hay grupos activos
   * vinculados (cuando exista `mod_fundae_group`), el service rechaza
   * con `CompanyTieneGruposActivosError`.
   */
  async softDelete(tenantId: string, actorId: string | null, id: string): Promise<CompanyView> {
    const existing = await this.prisma.modFundaeCompany.findFirst({
      where: { tenantId, id },
    });
    if (!existing) throw new CompanyNotFoundError(id);
    if (existing.deletedAt) {
      // Idempotente — ya estaba borrada.
      return toView(existing);
    }

    const activos = await this.prisma.modFundaeGroup.count({
      where: { tenantId, companyId: id, status: { in: ['DRAFT', 'ACTIVE'] } },
    });
    if (activos > 0) throw new CompanyTieneGruposActivosError(id, activos);

    const updated = await this.prisma.modFundaeCompany.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.publish(tenantId, actorId, 'fundae.company.deleted', {
      companyId: id,
    });
    return toView(updated);
  }

  // -------------------- helpers --------------------

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

interface CompanyRow {
  id: string;
  tenantId: string;
  nif: string;
  razonSocial: string;
  cccPrincipal: string | null;
  plantilla: number | null;
  creditoTotalCents: number | null;
  creditoUsadoCents: number;
  datosContacto: unknown;
  notas: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function toView(row: CompanyRow): CompanyView {
  // Siempre validamos el JSON contra el schema antes de devolverlo —
  // si algún registro legacy tiene un shape sucio, mejor que se vea
  // limpio en la respuesta de la API (los campos extra se descartan).
  const parsedContacto = datosContactoSchema.safeParse(row.datosContacto ?? {});
  const datosContacto: DatosContactoDto = parsedContacto.success ? parsedContacto.data : {};

  const creditoDisponibleCents =
    row.creditoTotalCents === null ? null : row.creditoTotalCents - row.creditoUsadoCents;

  return {
    id: row.id,
    tenantId: row.tenantId,
    nif: row.nif,
    razonSocial: row.razonSocial,
    cccPrincipal: row.cccPrincipal,
    plantilla: row.plantilla,
    creditoTotalCents: row.creditoTotalCents,
    creditoUsadoCents: row.creditoUsadoCents,
    creditoDisponibleCents,
    datosContacto,
    notas: row.notas,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
