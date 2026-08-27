import { describe, expect, it, vi } from 'vitest';
import { FundaeInspectorService } from '../src/inspector.service.js';

/**
 * Acceso de seguimiento Fundae (LMS-123).
 *
 * Lo que se prueba aquí es la PUERTA: quién abre y quién no. Un acceso revocado
 * o caducado tiene que dejar de abrir en el acto, porque es lo único que separa
 * «una cuenta de inspección acotada a un grupo» de «una cuenta que se quedó
 * dentro del aula para siempre».
 */

function makeContext() {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    eventBus: { publish: vi.fn(async () => {}) },
    auditLog: { record: vi.fn(async () => {}) },
  } as never;
}

function makePrisma(opts: {
  access?: { expiresAt: Date | null; revokedAt: Date | null } | null;
  group?: { id: string; actionId: string } | null;
  action?: { courseId: string | null } | null;
}) {
  const upserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  return {
    upserts,
    updates,
    modFundaeInspectorAccess: {
      findFirst: vi.fn(async () => opts.access ?? null),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        upserts.push(args.create);
        return {
          id: 'acc-1',
          groupId: 'g1',
          userId: 'u-insp',
          grantedAt: new Date('2026-03-01T00:00:00Z'),
          grantedBy: 'admin-1',
          expiresAt: null,
          revokedAt: null,
          notas: null,
        };
      }),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
    modFundaeGroup: {
      // `'group' in opts` y no `??`: hace falta poder pasar null EXPLÍCITO para
      // simular un grupo borrado, y `??` lo confundiría con «no lo declaré».
      findFirst: vi.fn(async () =>
        'group' in opts ? opts.group : { id: 'g1', actionId: 'a1', numeroGrupo: 1 },
      ),
      findMany: vi.fn(async () => []),
    },
    modFundaeAction: {
      findFirst: vi.fn(async () => ('action' in opts ? opts.action : { courseId: 'c1' })),
      findMany: vi.fn(async () => []),
    },
    user: {
      findFirst: vi.fn(async () => ({ id: 'u-insp', name: 'Inspectora', email: 'i@x.com' })),
      findMany: vi.fn(async () => []),
    },
  };
  // El fake se devuelve TIPADO. Con `as never` aquí, `ReturnType<typeof
  // makePrisma>` es `never` y cualquier lectura de `.upserts`/`.updates` en los
  // tests deja de compilar — el build no lo veía porque no mira los tests, pero
  // `pnpm typecheck` sí. El ensanchado a PrismaClient se hace donde se usa.
}

describe('FundaeInspectorService — la puerta', () => {
  it('un acceso vivo resuelve al curso de la acción', async () => {
    const prisma = makePrisma({ access: { expiresAt: null, revokedAt: null } });
    const svc = new FundaeInspectorService(prisma as never, makeContext());

    await expect(svc.resolveAccess('t1', 'u-insp', 'g1')).resolves.toEqual({ courseId: 'c1' });
  });

  it('sin concesión, no abre', async () => {
    const prisma = makePrisma({ access: null });
    const svc = new FundaeInspectorService(prisma as never, makeContext());

    await expect(svc.resolveAccess('t1', 'u-desconocido', 'g1')).resolves.toBeNull();
  });

  it('caducado deja de abrir aunque nadie lo haya revocado', async () => {
    const prisma = makePrisma({
      access: { expiresAt: new Date('2020-01-01T00:00:00Z'), revokedAt: null },
    });
    const svc = new FundaeInspectorService(prisma as never, makeContext());

    await expect(svc.resolveAccess('t1', 'u-insp', 'g1')).resolves.toBeNull();
  });

  it('una caducidad futura sigue abriendo', async () => {
    const prisma = makePrisma({
      access: { expiresAt: new Date('2999-01-01T00:00:00Z'), revokedAt: null },
    });
    const svc = new FundaeInspectorService(prisma as never, makeContext());

    await expect(svc.resolveAccess('t1', 'u-insp', 'g1')).resolves.toEqual({ courseId: 'c1' });
  });

  it('si el grupo ya no existe, no abre nada', async () => {
    const prisma = makePrisma({ access: { expiresAt: null, revokedAt: null }, group: null });
    const svc = new FundaeInspectorService(prisma as never, makeContext());

    await expect(svc.resolveAccess('t1', 'u-insp', 'g1')).resolves.toBeNull();
  });

  it('revocar MARCA la fila, no la borra: quién miró el expediente es trazabilidad', async () => {
    const prisma = makePrisma({ access: { expiresAt: null, revokedAt: null } });
    const ctx = makeContext();
    const svc = new FundaeInspectorService(prisma as never, ctx);

    await svc.revoke('t1', 'admin-1', 'g1', 'u-insp');

    expect(prisma.updates).toHaveLength(1);
    expect(prisma.updates[0]).toMatchObject({
      where: { tenantId: 't1', groupId: 'g1', userId: 'u-insp', revokedAt: null },
    });
    expect(prisma.modFundaeInspectorAccess.updateMany).toHaveBeenCalled();
    // Y queda en el registro de auditoría del tenant.
    expect(
      (ctx as unknown as { auditLog: { record: ReturnType<typeof vi.fn> } }).auditLog.record,
    ).toHaveBeenCalledWith(expect.objectContaining({ action: 'fundae.inspector.revoked' }));
  });

  it('conceder deja rastro de quién lo concedió', async () => {
    const prisma = makePrisma({});
    const ctx = makeContext();
    const svc = new FundaeInspectorService(prisma as never, ctx);

    const view = await svc.grant('t1', 'admin-1', 'g1', 'u-insp');

    expect(prisma.upserts[0]).toMatchObject({ grantedBy: 'admin-1', groupId: 'g1', userId: 'u-insp' });
    expect(view.activo).toBe(true);
    expect(view.userEmail).toBe('i@x.com');
    expect(
      (ctx as unknown as { auditLog: { record: ReturnType<typeof vi.fn> } }).auditLog.record,
    ).toHaveBeenCalledWith(expect.objectContaining({ action: 'fundae.inspector.granted' }));
  });
});
