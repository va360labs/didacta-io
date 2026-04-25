import { describe, expect, it } from 'vitest';
import { PrismaAuditLogService } from '../src/modules/prisma-audit-log.service';

interface AuditRow {
  id: bigint;
  tenantId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  timestamp: Date;
  prevHash: string | null;
  hash: string;
}

function makeFakePrisma() {
  const rows: AuditRow[] = [];
  let nextId = 1n;
  const prisma = {
    auditLog: {
      async findFirst(args: {
        where: { tenantId: string };
        orderBy: { id: 'desc' };
        select: { hash: true };
      }): Promise<{ hash: string } | null> {
        const matching = rows
          .filter((r) => r.tenantId === args.where.tenantId)
          .sort((a, b) => Number(b.id - a.id));
        return matching[0] ? { hash: matching[0].hash } : null;
      },
      async create(args: { data: Omit<AuditRow, 'id'> }): Promise<AuditRow> {
        const row: AuditRow = { id: nextId++, ...args.data };
        rows.push(row);
        return row;
      },
    },
    _rows: rows,
  };
  return prisma;
}

describe('PrismaAuditLogService', () => {
  it('persiste una entrada con hash y prev_hash null en la primera', async () => {
    const prisma = makeFakePrisma();
    const svc = new PrismaAuditLogService(prisma as never);

    await svc.record({
      tenantId: 't1',
      actorId: 'u1',
      action: 'course.created',
      resourceType: 'course',
      resourceId: 'c1',
    });

    expect(prisma._rows).toHaveLength(1);
    const [first] = prisma._rows;
    expect(first.prevHash).toBeNull();
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('encadena prev_hash a la última entrada del mismo tenant', async () => {
    const prisma = makeFakePrisma();
    const svc = new PrismaAuditLogService(prisma as never);

    await svc.record({
      tenantId: 't1',
      actorId: 'u1',
      action: 'login',
      resourceType: 'user',
      resourceId: 'u1',
    });
    await svc.record({
      tenantId: 't1',
      actorId: 'u1',
      action: 'course.published',
      resourceType: 'course',
      resourceId: 'c1',
    });

    const [a, b] = prisma._rows;
    expect(b.prevHash).toBe(a.hash);
  });

  it('cadenas separadas por tenant', async () => {
    const prisma = makeFakePrisma();
    const svc = new PrismaAuditLogService(prisma as never);

    await svc.record({
      tenantId: 't1',
      actorId: null,
      action: 'login',
      resourceType: 'user',
      resourceId: 'u1',
    });
    await svc.record({
      tenantId: 't2',
      actorId: null,
      action: 'login',
      resourceType: 'user',
      resourceId: 'u2',
    });

    expect(prisma._rows[0].prevHash).toBeNull();
    expect(prisma._rows[1].prevHash).toBeNull();
  });

  it('hash refleja los datos: cambios en metadata cambian el hash', async () => {
    const prisma = makeFakePrisma();
    const svc = new PrismaAuditLogService(prisma as never);

    await svc.record({
      tenantId: 't1',
      actorId: 'u1',
      action: 'config.updated',
      resourceType: 'config',
      resourceId: 'c1',
      metadata: { from: 'a' },
    });
    await svc.record({
      tenantId: 't1',
      actorId: 'u1',
      action: 'config.updated',
      resourceType: 'config',
      resourceId: 'c1',
      metadata: { from: 'b' },
    });

    expect(prisma._rows[0].hash).not.toEqual(prisma._rows[1].hash);
  });
});
