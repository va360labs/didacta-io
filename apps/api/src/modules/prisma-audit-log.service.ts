/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuditLogService } from '@didacta/core-kernel';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Audit log append-only con cadena de hashes para detección de tampering.
 *
 * Cada entrada calcula:
 *   hash = SHA-256(prev_hash || tenantId || timestamp || action || resourceType || resourceId || metadata)
 *
 * El prev_hash apunta al hash de la última entrada del MISMO TENANT, formando
 * una cadena local. Si alguien modifica una fila vieja, los hashes posteriores
 * dejan de validar.
 *
 * CONCURRENCIA. Leer el último hash e insertar van dentro de UNA transacción
 * con un advisory lock por tenant (`pg_advisory_xact_lock`). Sin él, dos
 * acciones auditadas a la vez del mismo tenant leían el mismo «último hash»,
 * se insertaban las dos con el mismo `prev_hash` y `verifyChain` daba la
 * cadena por rota PARA SIEMPRE: las filas son append-only (hay un trigger que
 * bloquea UPDATE y DELETE), así que una bifurcación no se puede reparar. Y una
 * cadena que siempre sale «rota» no avisa de nada: el día que alguien manipule
 * una fila, la alerta ya llevaba meses encendida.
 *
 * El lock solo serializa las escrituras de un mismo tenant; tenants distintos
 * no se esperan entre sí. Se libera solo, al terminar la transacción.
 *
 * La fórmula del hash NO cambia: las cadenas ya escritas se verifican igual
 * que antes. Lo que este cambio no hace es reparar una cadena que ya se
 * bifurcó antes de él.
 */
/**
 * Serializa un objeto con `JSON.stringify` ordenando claves de manera
 * recursiva. Necesario para hashes deterministas: PostgreSQL JSONB
 * normaliza el orden de keys de los `metadata` al guardar, así que
 * hashear con el orden de inserción original rompe la verificación al
 * releer (orden distinto → hash distinto).
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

/** Primera clave del advisory lock: el «espacio» de la cadena de auditoría. */
const AUDIT_CHAIN_LOCK_SPACE = 'audit_log';

/** Margen para esperar el lock del tenant y completar la escritura. */
const AUDIT_WRITE_TIMEOUT_MS = 10_000;

@Injectable()
export class PrismaAuditLogService implements AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    tenantId: string;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // Lock de DOS claves: (espacio «audit_log», tenant). La forma de dos
        // enteros no comparte espacio con la de un solo bigint que usan otros
        // servicios (access-groups), así que una coincidencia de hash con ellos
        // no hace esperar a nadie.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${AUDIT_CHAIN_LOCK_SPACE}), hashtext(${entry.tenantId}))`;

        // A partir de aquí nadie más del tenant está entre este SELECT y su
        // INSERT: el «último» que se lee es el último de verdad.
        const last = await tx.auditLog.findFirst({
          where: { tenantId: entry.tenantId },
          orderBy: { id: 'desc' },
          select: { hash: true },
        });
        const prevHash = last?.hash ?? null;

        const timestamp = new Date();
        const hashInput = canonicalStringify({
          prevHash,
          tenantId: entry.tenantId,
          actorId: entry.actorId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          metadata: entry.metadata ?? {},
          timestamp: timestamp.toISOString(),
        });
        const hash = createHash('sha256').update(hashInput).digest('hex');

        await tx.auditLog.create({
          data: {
            tenantId: entry.tenantId,
            actorId: entry.actorId,
            action: entry.action,
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            metadata: (entry.metadata ?? {}) as never,
            ip: entry.ip ?? null,
            userAgent: entry.userAgent ?? null,
            timestamp,
            prevHash,
            hash,
          },
        });
      },
      // En una ráfaga de acciones del mismo tenant, una escritura espera al
      // lock de las anteriores. Los 2 s / 5 s por defecto de Prisma se quedan
      // cortos ahí, y un timeout aquí es una entrada de auditoría perdida.
      { maxWait: AUDIT_WRITE_TIMEOUT_MS, timeout: AUDIT_WRITE_TIMEOUT_MS },
    );
  }

  /**
   * Recorre toda la cadena del tenant en orden cronológico (id asc) y verifica
   * que cada `hash` coincide con SHA-256 sobre los datos visibles + `prev_hash`.
   *
   * Si alguien editó una fila vieja, el hash deja de coincidir y todas las
   * posteriores también fallan (porque su prev_hash apuntaba al hash original).
   */
  async verifyChain(tenantId: string): Promise<{
    valid: boolean;
    totalEntries: number;
    firstBrokenId: string | null;
    brokenAt: Date | null;
  }> {
    const rows = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });

    let prevHash: string | null = null;
    for (const row of rows) {
      if (row.prevHash !== prevHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          firstBrokenId: row.id.toString(),
          brokenAt: row.timestamp,
        };
      }

      // Canónico (orden alfabético de keys) — formato actual.
      const payload = {
        prevHash: row.prevHash,
        tenantId: row.tenantId,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        metadata: row.metadata ?? {},
        timestamp: row.timestamp.toISOString(),
      };
      const expected: string = createHash('sha256')
        .update(canonicalStringify(payload))
        .digest('hex');
      // Legacy: orden de inserción del literal en código. Mantenemos
      // compatibilidad para no invalidar audit logs creados antes del
      // fix (PostgreSQL JSONB normaliza orden de keys de metadata, lo
      // que rompía la verify para metadatas con > 1 key).
      const expectedLegacy: string = createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');

      if (expected !== row.hash && expectedLegacy !== row.hash) {
        return {
          valid: false,
          totalEntries: rows.length,
          firstBrokenId: row.id.toString(),
          brokenAt: row.timestamp,
        };
      }

      prevHash = row.hash;
    }

    return { valid: true, totalEntries: rows.length, firstBrokenId: null, brokenAt: null };
  }

  /**
   * Listado de entradas para el panel /admin/auditoria. Soporta filtros por
   * actor, acción, tipo de recurso y rango de fechas. Devuelve hasta `limit`
   * (default 100, máximo 500) ordenadas por timestamp desc.
   *
   * NO devuelve los hashes en el listado para no ensuciar la UI; el panel
   * tiene un botón separado "Verificar cadena" que llama a verifyChain.
   */
  async list(
    tenantId: string,
    filters: {
      actorId?: string;
      action?: string;
      resourceType?: string;
      dateFrom?: Date;
      dateTo?: Date;
      limit?: number;
    },
  ): Promise<
    Array<{
      id: string;
      actorId: string | null;
      action: string;
      resourceType: string;
      resourceId: string;
      metadata: unknown;
      ip: string | null;
      userAgent: string | null;
      timestamp: Date;
    }>
  > {
    const where: Record<string, unknown> = { tenantId };
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.action) where.action = { contains: filters.action };
    if (filters.resourceType) where.resourceType = filters.resourceType;
    if (filters.dateFrom || filters.dateTo) {
      where.timestamp = {};
      if (filters.dateFrom) (where.timestamp as Record<string, unknown>).gte = filters.dateFrom;
      if (filters.dateTo) (where.timestamp as Record<string, unknown>).lte = filters.dateTo;
    }

    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      select: {
        id: true,
        actorId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        metadata: true,
        ip: true,
        userAgent: true,
        timestamp: true,
      },
    });

    return rows.map((r) => ({
      id: r.id.toString(),
      actorId: r.actorId,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      metadata: r.metadata,
      ip: r.ip,
      userAgent: r.userAgent,
      timestamp: r.timestamp,
    }));
  }
}
