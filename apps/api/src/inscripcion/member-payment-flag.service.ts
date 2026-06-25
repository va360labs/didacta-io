import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../auth/client-context';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentFlagUpsertDto } from './inscripcion.dto';

// ============================================================================
// Gestión admin de impagos (tabla member_payment_flag). El flag de impago
// alimenta la validación manual del flujo de inscripción: el operador decide
// aprobar/rechazar viendo si el solicitante figura como moroso.
//
// TENANT ANÓNIMO: este service NO usa withTenant(). Cada query Prisma filtra
// SIEMPRE por `tenantId` en el `where` (el controller lo resuelve por Host y
// lo pasa explícito). Patrón idéntico a PasswordResetService/InscribeService.
// ============================================================================

/** Forma de una fila de impago tal como la consume la UI admin. */
export interface PaymentFlagItem {
  id: string;
  telegramId: string;
  name: string | null;
  isDelinquent: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class MemberPaymentFlagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Lista las filas de impago del tenant, ordenadas por última modificación.
   *
   * - `delinquentOnly`: filtra solo los marcados como morosos.
   * - `q`: búsqueda parcial por telegramId o nombre (case-insensitive en name).
   *
   * Cap de 1000 filas: el caso real es una lista acotada de morosos cargada a
   * mano o por CSV; si en el futuro crece, paginar.
   */
  async list(
    tenantId: string,
    opts?: { delinquentOnly?: boolean; q?: string },
  ): Promise<PaymentFlagItem[]> {
    const q = opts?.q?.trim();
    const rows = await this.prisma.memberPaymentFlag.findMany({
      where: {
        tenantId,
        ...(opts?.delinquentOnly ? { isDelinquent: true } : {}),
        ...(q
          ? {
              OR: [
                { telegramId: { contains: q } },
                { name: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });

    return rows.map((r) => ({
      id: r.id,
      telegramId: r.telegramId,
      name: r.name,
      isDelinquent: r.isDelinquent,
      note: r.note,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Crea o actualiza el flag de impago para un telegramId del tenant.
   * Idempotente sobre la clave compuesta (tenantId, telegramId).
   */
  async upsert(
    tenantId: string,
    dto: PaymentFlagUpsertDto,
    actorId: string,
    ctx: ClientContext,
  ): Promise<{ id: string }> {
    const flag = await this.prisma.memberPaymentFlag.upsert({
      where: { tenantId_telegramId: { tenantId, telegramId: dto.telegramId } },
      create: {
        tenantId,
        telegramId: dto.telegramId,
        name: dto.name ?? null,
        isDelinquent: dto.isDelinquent,
        note: dto.note ?? null,
      },
      update: {
        name: dto.name ?? null,
        isDelinquent: dto.isDelinquent,
        note: dto.note ?? null,
      },
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'member.payment_flag.upserted',
      resourceType: 'member_payment_flag',
      resourceId: flag.id,
      metadata: { telegramId: dto.telegramId, isDelinquent: dto.isDelinquent },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { id: flag.id };
  }

  /**
   * Elimina un flag de impago por id. SIEMPRE filtra por tenantId vía
   * `deleteMany` para no permitir borrados cruzados entre tenants.
   */
  async remove(tenantId: string, id: string, actorId: string): Promise<void> {
    await this.prisma.memberPaymentFlag.deleteMany({ where: { tenantId, id } });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'member.payment_flag.deleted',
      resourceType: 'member_payment_flag',
      resourceId: id,
    });
  }

  /**
   * Importa filas de impago en bloque (carga CSV). Hace upsert por cada fila
   * dentro de una transacción para que la importación sea atómica.
   */
  async importCsv(
    tenantId: string,
    rows: PaymentFlagUpsertDto[],
    actorId: string,
    ctx: ClientContext,
  ): Promise<{ imported: number }> {
    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.memberPaymentFlag.upsert({
          where: { tenantId_telegramId: { tenantId, telegramId: row.telegramId } },
          create: {
            tenantId,
            telegramId: row.telegramId,
            name: row.name ?? null,
            isDelinquent: row.isDelinquent,
            note: row.note ?? null,
          },
          update: {
            name: row.name ?? null,
            isDelinquent: row.isDelinquent,
            note: row.note ?? null,
          },
        }),
      ),
    );

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'member.payment_flag.imported',
      resourceType: 'member_payment_flag',
      resourceId: tenantId,
      metadata: { count: rows.length },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    this.logger.warn({ tenantId, count: rows.length }, 'member.payment_flag: importación CSV');

    return { imported: rows.length };
  }

  /**
   * Consulta el estado de impago de un telegramId concreto del tenant.
   * Devuelve null si no hay flag registrado (no se conoce su estado).
   */
  async lookup(
    tenantId: string,
    telegramId: string,
  ): Promise<{ isDelinquent: boolean; name: string | null } | null> {
    const flag = await this.prisma.memberPaymentFlag.findUnique({
      where: { tenantId_telegramId: { tenantId, telegramId } },
      select: { isDelinquent: true, name: true },
    });
    if (!flag) return null;
    return { isDelinquent: flag.isDelinquent, name: flag.name };
  }
}
