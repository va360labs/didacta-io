/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  RLPT_ANTELACION_MINIMA_DIAS,
  type CreateRlptNoticeDto,
  type RlptNoticeType,
  type RlptNoticeView,
} from './rlpt.dto.js';
import {
  CompanyNotFoundError,
  RlptNotFoundError,
  RlptNotificacionInicialMissingError,
  RlptPlazoNoCumplidoError,
} from './errors.js';

/**
 * Service de notificaciones RLPT (LMS-80).
 *
 * Contratos clave:
 *   - `upload` recibe el buffer del PDF/escaneo y lo persiste en Evidence
 *     Vault con hash SHA-256, luego crea la fila apuntando al entry.
 *   - `assertGroupCanStart` lo usa el hook `fundae.group.before-start`
 *     para validar que la empresa cumple los plazos antes de iniciar
 *     un grupo bonificable. Reglas:
 *       * Tiene que existir al menos una `NOTIFICACION_INICIAL` viva
 *         para la empresa.
 *       * Su `plazoVencimientoAt` tiene que estar en el pasado (`now() >=`).
 *       * Si existe `ACTA_DISCREPANCIA`, se permite avanzar igualmente
 *         (la traza queda documentada, decisión de negocio explícita).
 */
export class FundaeRlptService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async upload(args: {
    tenantId: string;
    companyId: string;
    actorId: string | null;
    dto: CreateRlptNoticeDto;
    blob: Buffer;
    contentType?: string;
  }): Promise<RlptNoticeView> {
    const company = await this.prisma.modFundaeCompany.findFirst({
      where: { tenantId: args.tenantId, id: args.companyId, deletedAt: null },
      select: { id: true },
    });
    if (!company) throw new CompanyNotFoundError(args.companyId);

    // Persistir blob en Evidence Vault. El service de vault deduplica
    // por (tenantId, resourceType, resourceId, hash) — si el admin sube
    // el mismo PDF dos veces sale el mismo entryId y la fila RLPT
    // referencia el mismo blob (no se cobra storage doble).
    const stored = await this.ctx.evidenceVault.store({
      tenantId: args.tenantId,
      resourceType: 'fundae.rlpt',
      resourceId: args.companyId,
      data: args.blob,
      contentType: args.contentType ?? 'application/pdf',
    });

    const fechaNotificacionAt = args.dto.fechaNotificacionAt
      ? new Date(args.dto.fechaNotificacionAt)
      : new Date();
    const plazoVencimientoAt = args.dto.plazoVencimientoAt
      ? new Date(args.dto.plazoVencimientoAt)
      : computeDefaultPlazo(fechaNotificacionAt, args.dto.tipo);

    const created = await this.prisma.modFundaeRlptNotice.create({
      data: {
        id: randomUUID(),
        tenantId: args.tenantId,
        companyId: args.companyId,
        tipo: args.dto.tipo,
        fechaNotificacionAt,
        plazoVencimientoAt,
        evidenceEntryId: stored.id,
        observaciones: args.dto.observaciones ?? null,
      },
    });

    await this.publish(args.tenantId, args.actorId, 'fundae.rlpt.notice.created', {
      noticeId: created.id,
      companyId: args.companyId,
      tipo: args.dto.tipo,
    });
    this.ctx.logger.info('mod.fundae: rlpt notice uploaded', {
      tenantId: args.tenantId,
      companyId: args.companyId,
      noticeId: created.id,
    });

    return this.toView({
      ...created,
      evidence: { hash: stored.hash, size: BigInt(args.blob.length) },
    });
  }

  async listByCompany(tenantId: string, companyId: string): Promise<RlptNoticeView[]> {
    const rows = await this.prisma.modFundaeRlptNotice.findMany({
      where: { tenantId, companyId, deletedAt: null },
      include: { evidence: { select: { hash: true, size: true } } },
      orderBy: { fechaNotificacionAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(tenantId: string, id: string): Promise<RlptNoticeView> {
    const row = await this.prisma.modFundaeRlptNotice.findFirst({
      where: { tenantId, id },
      include: { evidence: { select: { hash: true, size: true } } },
    });
    if (!row) throw new RlptNotFoundError(id);
    return this.toView(row);
  }

  async softDelete(tenantId: string, actorId: string | null, id: string): Promise<RlptNoticeView> {
    const existing = await this.prisma.modFundaeRlptNotice.findFirst({
      where: { tenantId, id },
      include: { evidence: { select: { hash: true, size: true } } },
    });
    if (!existing) throw new RlptNotFoundError(id);
    if (existing.deletedAt) return this.toView(existing);

    const updated = await this.prisma.modFundaeRlptNotice.update({
      where: { id },
      data: { deletedAt: new Date() },
      include: { evidence: { select: { hash: true, size: true } } },
    });
    await this.publish(tenantId, actorId, 'fundae.rlpt.notice.deleted', {
      noticeId: id,
      companyId: existing.companyId,
    });
    return this.toView(updated);
  }

  /**
   * Reglas del hook `fundae.group.before-start`. Lanza error tipado si
   * el inicio no se autoriza, devuelve void si todo OK. Diseñado para
   * llamarse desde el handler del hook al implementarse LMS-81.
   */
  async assertGroupCanStart(args: {
    tenantId: string;
    companyId: string;
    /** Fecha desde la que se evalúa el cumplimiento. Default `new Date()`. */
    referenceDate?: Date;
  }): Promise<void> {
    const reference = args.referenceDate ?? new Date();
    const notices = await this.prisma.modFundaeRlptNotice.findMany({
      where: { tenantId: args.tenantId, companyId: args.companyId, deletedAt: null },
      orderBy: { fechaNotificacionAt: 'desc' },
    });

    // Si hay acta de discrepancia, se permite avanzar con traza.
    const hasDiscrepancia = notices.some((n) => n.tipo === 'ACTA_DISCREPANCIA');
    if (hasDiscrepancia) return;

    const inicial = notices.find((n) => n.tipo === 'NOTIFICACION_INICIAL');
    if (!inicial) {
      throw new RlptNotificacionInicialMissingError(args.companyId);
    }
    if (reference.getTime() < inicial.plazoVencimientoAt.getTime()) {
      throw new RlptPlazoNoCumplidoError(args.companyId, inicial.plazoVencimientoAt.toISOString());
    }
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

  private toView(row: {
    id: string;
    tenantId: string;
    companyId: string;
    tipo: string;
    fechaNotificacionAt: Date;
    plazoVencimientoAt: Date;
    evidenceEntryId: string;
    observaciones: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    evidence: { hash: string; size: bigint } | null;
  }): RlptNoticeView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      companyId: row.companyId,
      tipo: row.tipo as RlptNoticeType,
      fechaNotificacionAt: row.fechaNotificacionAt.toISOString(),
      plazoVencimientoAt: row.plazoVencimientoAt.toISOString(),
      evidenceEntryId: row.evidenceEntryId,
      evidenceHash: row.evidence?.hash ?? '',
      evidenceSize: row.evidence ? Number(row.evidence.size) : 0,
      observaciones: row.observaciones,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    };
  }
}

/**
 * Calcula el plazo de vencimiento por defecto según el tipo:
 *  - NOTIFICACION_INICIAL: fecha + 15 días naturales (RD 694/2017).
 *  - ACUSE_RECIBO / ACTA_DISCREPANCIA: misma fecha (no aplican plazo
 *    legal, son evidencias documentales).
 */
function computeDefaultPlazo(fecha: Date, tipo: RlptNoticeType): Date {
  if (tipo !== 'NOTIFICACION_INICIAL') return new Date(fecha);
  const target = new Date(fecha);
  target.setDate(target.getDate() + RLPT_ANTELACION_MINIMA_DIAS);
  return target;
}
