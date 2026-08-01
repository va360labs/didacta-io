/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ClientContext } from '../../auth/client-context';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { PaymentFlagUpsertDto } from '@didacta/mod-member-registration';

// ============================================================================
// Gestión admin de impagos (tabla mod_member_registration_payment_flag). El
// flag de impago alimenta la validación manual del flujo de inscripción: el
// operador decide aprobar/rechazar viendo si el solicitante figura como moroso.
//
// Desde F2.3 la clave de negocio es el EMAIL (con user_id vinculado si el
// email corresponde a un usuario del tenant); telegram_id queda como clave
// LEGACY opcional — sigue matcheando filas históricas y permite importar
// exportaciones de Telegram. Un upsert que trae email Y telegramId "migra" la
// fila legacy que coincida por telegramId añadiéndole el email.
//
// TENANT ANÓNIMO: este service NO usa withTenant(). Cada query Prisma filtra
// SIEMPRE por `tenantId` en el `where` (el controller lo resuelve por JWT y
// lo pasa explícito). Patrón idéntico a PasswordResetService/InscribeService.
// ============================================================================

/** Forma de una fila de impago tal como la consume la UI admin. */
export interface PaymentFlagItem {
  id: string;
  email: string | null;
  userId: string | null;
  telegramId: string | null;
  name: string | null;
  isDelinquent: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Identidad con la que buscar un flag al validar una solicitud. */
export interface PaymentFlagIdentity {
  email?: string | null;
  telegramId?: string | null;
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
   * - `q`: búsqueda parcial por email, telegramId o nombre (case-insensitive
   *   en email y name).
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
                { email: { contains: q, mode: 'insensitive' as const } },
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
      email: r.email,
      userId: r.userId,
      telegramId: r.telegramId,
      name: r.name,
      isDelinquent: r.isDelinquent,
      note: r.note,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Crea o actualiza el flag de impago identificado por email (clave
   * principal) y/o telegramId (legacy). Orden de matching:
   *  1. fila con ese email → se actualiza (y adopta el telegramId si vino);
   *  2. fila con ese telegramId → se actualiza y, si vino email, la fila
   *     legacy queda "migrada" a la clave nueva;
   *  3. si nada matchea → se crea.
   * Si el email corresponde a un usuario del tenant se vincula su user_id.
   */
  async upsert(
    tenantId: string,
    dto: PaymentFlagUpsertDto,
    actorId: string,
    ctx: ClientContext,
  ): Promise<{ id: string }> {
    const flag = await this.writeFlag(this.prisma, tenantId, dto);

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'member.payment_flag.upserted',
      resourceType: 'member_payment_flag',
      resourceId: flag.id,
      metadata: {
        email: dto.email ?? null,
        telegramId: dto.telegramId ?? null,
        isDelinquent: dto.isDelinquent,
      },
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
   * Importa filas de impago en bloque (carga CSV: lista de emails o export de
   * Telegram). Aplica la misma lógica de matching que `upsert` fila a fila,
   * dentro de una transacción para que la importación sea atómica.
   */
  async importCsv(
    tenantId: string,
    rows: PaymentFlagUpsertDto[],
    actorId: string,
    ctx: ClientContext,
  ): Promise<{ imported: number }> {
    await this.prisma.$transaction(
      async (tx) => {
        for (const row of rows) {
          await this.writeFlag(tx, tenantId, row);
        }
      },
      // Import de hasta 5000 filas con lookups por fila: margen holgado sobre
      // el timeout por defecto (5s) de las transacciones interactivas.
      { timeout: 60_000 },
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
   * Consulta el estado de impago de un solicitante por su identidad: primero
   * por email (clave principal) y, si no hay fila, por telegramId (legacy).
   * Devuelve null si no hay flag registrado (no se conoce su estado).
   */
  async lookup(
    tenantId: string,
    identity: PaymentFlagIdentity,
  ): Promise<{ isDelinquent: boolean; name: string | null } | null> {
    const email = identity.email?.trim().toLowerCase();
    if (email) {
      const byEmail = await this.prisma.memberPaymentFlag.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: { isDelinquent: true, name: true },
      });
      if (byEmail) return byEmail;
    }
    const telegramId = identity.telegramId?.trim();
    if (telegramId) {
      const byTelegram = await this.prisma.memberPaymentFlag.findUnique({
        where: { tenantId_telegramId: { tenantId, telegramId } },
        select: { isDelinquent: true, name: true },
      });
      if (byTelegram) return byTelegram;
    }
    return null;
  }

  // -------------------- helpers --------------------

  /**
   * Lógica compartida de upsert/import: matching email → telegramId → create.
   * `db` permite ejecutarla contra el cliente raíz o dentro de una transacción.
   * Toda query filtra por tenantId (path admin con tenant explícito).
   */
  private async writeFlag(
    db: Pick<PrismaService, 'memberPaymentFlag' | 'user'>,
    tenantId: string,
    dto: PaymentFlagUpsertDto,
  ): Promise<{ id: string }> {
    const email = dto.email?.trim().toLowerCase() || null;
    const telegramId = dto.telegramId?.trim() || null;

    // Vínculo best-effort con el usuario del tenant (join lógico, sin FK).
    const userId = email
      ? ((
          await db.user.findUnique({
            where: { tenantId_email: { tenantId, email } },
            select: { id: true },
          })
        )?.id ?? null)
      : null;

    const data = {
      name: dto.name ?? null,
      isDelinquent: dto.isDelinquent,
      note: dto.note ?? null,
    };

    if (email) {
      const byEmail = await db.memberPaymentFlag.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: { id: true },
      });
      if (byEmail) {
        await db.memberPaymentFlag.updateMany({
          where: { tenantId, id: byEmail.id },
          data: { ...data, userId, ...(telegramId ? { telegramId } : {}) },
        });
        return byEmail;
      }
    }

    if (telegramId) {
      const byTelegram = await db.memberPaymentFlag.findUnique({
        where: { tenantId_telegramId: { tenantId, telegramId } },
        select: { id: true },
      });
      if (byTelegram) {
        // Si vino email, la fila legacy queda migrada a la clave nueva.
        await db.memberPaymentFlag.updateMany({
          where: { tenantId, id: byTelegram.id },
          data: { ...data, ...(email ? { email, userId } : {}) },
        });
        return byTelegram;
      }
    }

    return db.memberPaymentFlag.create({
      data: { tenantId, email, userId, telegramId, ...data },
      select: { id: true },
    });
  }
}
