import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuditLogService } from '@learnship/core-kernel';
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
 * IMPORTANTE: la concurrencia entre dos requests del mismo tenant podría dar
 * dos filas con el mismo prev_hash. Para Fase 1.A es aceptable; en Fase 2 se
 * añadirá un lock advisory por tenantId al insertar para garantizar linealidad.
 */
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
    const last = await this.prisma.auditLog.findFirst({
      where: { tenantId: entry.tenantId },
      orderBy: { id: 'desc' },
      select: { hash: true },
    });
    const prevHash = last?.hash ?? null;

    const timestamp = new Date();
    const hashInput = JSON.stringify({
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

    await this.prisma.auditLog.create({
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
  }
}
