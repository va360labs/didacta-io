/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del ScimService — séptimo piloto License SDK (`feat:scim`).
 *
 * Mismo enfoque que custom-domains.service.test.ts: fake del PrismaService
 * con storage in-memory por tabla. NO toca Postgres real. Las consultas
 * Prisma no se replican exactamente — sólo el subset que usa el service.
 *
 * Cobertura mínima exigida (≥12 casos):
 *   - createUser idempotente: mismo userName → 409 con scimType=uniqueness.
 *   - createUser sin email parseable → 400 invalidValue.
 *   - createUser active=true → status=PENDING; active=false → DEACTIVATED.
 *   - patchUser active=false → DEACTIVATED + sesiones invalidadas.
 *   - patchUser active=true desde DEACTIVATED → ACTIVE.
 *   - patchUser active=true desde SUSPENDED → SUSPENDED se respeta (no auto-rehab).
 *   - patchUser path=name.givenName → recompone name.
 *   - patchUser path desconocido → 400 invalidPath.
 *   - patchUser sin operaciones que cambien estado → no-op (no escribe).
 *   - listUsers paginado con startIndex + count.
 *   - listUsers filter userName eq → matchea por email (case-insensitive).
 *   - listUsers filter inválido → 400 invalidFilter.
 *   - getUser tenant isolation: tenant A no ve user de tenant B.
 *   - deleteUser soft-delete con deletedAt + status=DEACTIVATED.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ScimService } from '../src/scim/scim.service';

// ---------------------------------------------------------------------------
// Fake Prisma in-memory
// ---------------------------------------------------------------------------

interface FakeUser {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  locale: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface FakeSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

function makeFakePrisma() {
  const users: FakeUser[] = [];
  const sessions: FakeSession[] = [];
  let userSeq = 0;

  const matchesWhere = (u: FakeUser, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if ('id' in where && u.id !== where['id']) return false;
    if ('tenantId' in where && u.tenantId !== where['tenantId']) return false;
    if ('deletedAt' in where) {
      const w = where['deletedAt'];
      if (w === null && u.deletedAt !== null) return false;
      if (w !== null && u.deletedAt === null && w !== undefined) return false;
    }
    if ('email' in where) {
      const e = where['email'];
      if (typeof e === 'string') {
        if (u.email !== e) return false;
      } else if (e && typeof e === 'object' && 'equals' in (e as Record<string, unknown>)) {
        const eq = (e as { equals: string; mode?: string }).equals;
        const mode = (e as { equals: string; mode?: string }).mode;
        if (mode === 'insensitive') {
          if (u.email.toLowerCase() !== eq.toLowerCase()) return false;
        } else {
          if (u.email !== eq) return false;
        }
      }
    }
    return true;
  };

  return {
    _users: users,
    _sessions: sessions,
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return users.find((u) => matchesWhere(u, where)) ?? null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Soporta where.tenantId_email = { tenantId, email } (Prisma compound key).
        if (where['tenantId_email']) {
          const k = where['tenantId_email'] as { tenantId: string; email: string };
          return users.find((u) => u.tenantId === k.tenantId && u.email === k.email) ?? null;
        }
        if (where['id']) {
          return users.find((u) => u.id === where['id']) ?? null;
        }
        return null;
      }),
      findMany: vi.fn(
        async ({
          where,
          skip,
          take,
        }: {
          where: Record<string, unknown>;
          orderBy?: unknown;
          skip?: number;
          take?: number;
        }) => {
          const filtered = users
            .filter((u) => matchesWhere(u, where))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return filtered.slice(skip ?? 0, (skip ?? 0) + (take ?? filtered.length));
        },
      ),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return users.filter((u) => matchesWhere(u, where)).length;
      }),
      create: vi.fn(
        async ({ data }: { data: Partial<FakeUser> & { tenantId: string; email: string } }) => {
          const now = new Date();
          userSeq += 1;
          const u: FakeUser = {
            id: `user-${userSeq.toString().padStart(8, '0')}`,
            tenantId: data.tenantId,
            email: data.email,
            name: data.name ?? null,
            status: data.status ?? 'PENDING',
            locale: data.locale ?? 'es-ES',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          };
          users.push(u);
          return u;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error(`fake user ${where.id} not found`);
        Object.assign(u, data);
        u.updatedAt = new Date();
        return u;
      }),
    },
    session: {
      deleteMany: vi.fn(
        async ({ where }: { where: { userId: string; expiresAt?: { gt: Date } } }) => {
          const before = sessions.length;
          for (let i = sessions.length - 1; i >= 0; i--) {
            const s = sessions[i]!;
            if (s.userId !== where.userId) continue;
            if (where.expiresAt && s.expiresAt.getTime() <= where.expiresAt.gt.getTime()) continue;
            sessions.splice(i, 1);
          }
          return { count: before - sessions.length };
        },
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Para los tests, ejecutamos el callback con el mismo client (no hay
      // aislamiento real). Es suficiente para verificar la secuencia.
      return fn({
        user: {
          update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
            const u = users.find((x) => x.id === where.id);
            if (!u) throw new Error(`fake user ${where.id} not found`);
            Object.assign(u, data);
            u.updatedAt = new Date();
            return u;
          },
        },
        session: {
          deleteMany: async ({
            where,
          }: {
            where: { userId: string; expiresAt?: { gt: Date } };
          }) => {
            for (let i = sessions.length - 1; i >= 0; i--) {
              const s = sessions[i]!;
              if (s.userId !== where.userId) continue;
              if (where.expiresAt && s.expiresAt.getTime() <= where.expiresAt.gt.getTime())
                continue;
              sessions.splice(i, 1);
            }
          },
        },
      });
    }),
  };
}

function makeAuditLog() {
  const recordSpy = vi.fn().mockResolvedValue(undefined);
  return { audit: { record: recordSpy }, recordSpy };
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScimService', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let audit: ReturnType<typeof makeAuditLog>;
  let service: ScimService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    audit = makeAuditLog();
    service = new ScimService(
      prisma as unknown as ConstructorParameters<typeof ScimService>[0],
      audit.audit as unknown as ConstructorParameters<typeof ScimService>[1],
    );
  });

  // ---------------------------- createUser ---------------------------------

  describe('createUser', () => {
    it('crea un user con status=PENDING cuando active=true (default IdPs)', async () => {
      const out = await service.createUser(TENANT_A, {
        userName: 'juan@acme.com',
        active: true,
      });
      expect(out.userName).toBe('juan@acme.com');
      expect(out.active).toBe(true); // PENDING mapea a active=true
      expect(prisma._users[0]?.status).toBe('PENDING');
      expect(audit.recordSpy).toHaveBeenCalledTimes(1);
      expect(audit.recordSpy.mock.calls[0]![0].action).toBe('scim.user.created');
    });

    it('crea un user con status=DEACTIVATED cuando active=false', async () => {
      const out = await service.createUser(TENANT_A, {
        userName: 'juan@acme.com',
        active: false,
      });
      expect(out.active).toBe(false);
      expect(prisma._users[0]?.status).toBe('DEACTIVATED');
    });

    it('idempotencia: mismo userName en mismo tenant → 409 ConflictException', async () => {
      await service.createUser(TENANT_A, { userName: 'juan@acme.com', active: true });
      await expect(
        service.createUser(TENANT_A, { userName: 'juan@acme.com', active: true }),
      ).rejects.toThrow(ConflictException);
    });

    it('error 409 lleva scimType=uniqueness en el body SCIM', async () => {
      await service.createUser(TENANT_A, { userName: 'juan@acme.com', active: true });
      try {
        await service.createUser(TENANT_A, { userName: 'juan@acme.com', active: true });
        throw new Error('debió lanzar');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const body = (e as ConflictException).getResponse() as Record<string, unknown>;
        expect(body['scimType']).toBe('uniqueness');
        expect(body['status']).toBe('409');
      }
    });

    it('rechaza con 400 invalidValue cuando no hay email derivable', async () => {
      await expect(
        service.createUser(TENANT_A, {
          userName: 'no-soy-email',
          active: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('aislamiento entre tenants: mismo userName en tenants distintos OK', async () => {
      await service.createUser(TENANT_A, { userName: 'juan@acme.com', active: true });
      const b = await service.createUser(TENANT_B, { userName: 'juan@acme.com', active: true });
      expect(b.id).toBeDefined();
      expect(prisma._users).toHaveLength(2);
    });
  });

  // ---------------------------- patchUser ----------------------------------

  describe('patchUser', () => {
    it('PATCH replace active=false → status=DEACTIVATED', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      // Ascendamos el user a ACTIVE para probar el down-grade.
      prisma._users[0]!.status = 'ACTIVE';

      const updated = await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', path: 'active', value: false }],
      });
      expect(updated.active).toBe(false);
      expect(prisma._users[0]?.status).toBe('DEACTIVATED');
    });

    it('PATCH active=false invalida sesiones activas', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      prisma._users[0]!.status = 'ACTIVE';
      // sesión activa.
      prisma._sessions.push({
        id: 'sess-1',
        userId: created.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      // sesión expirada (no debería tocarse).
      prisma._sessions.push({
        id: 'sess-old',
        userId: created.id,
        expiresAt: new Date(Date.now() - 1000),
      });

      await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', path: 'active', value: false }],
      });

      expect(prisma._sessions.find((s) => s.id === 'sess-1')).toBeUndefined();
      // expirada queda — el filtro expiresAt.gt now la excluye.
      expect(prisma._sessions.find((s) => s.id === 'sess-old')).toBeDefined();
    });

    it('PATCH active=true desde DEACTIVATED → ACTIVE', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: false,
      });
      const updated = await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', path: 'active', value: true }],
      });
      expect(updated.active).toBe(true);
      expect(prisma._users[0]?.status).toBe('ACTIVE');
    });

    it('PATCH active=true desde SUSPENDED no auto-rehabilita', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      prisma._users[0]!.status = 'SUSPENDED';

      await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', path: 'active', value: true }],
      });
      // Sigue SUSPENDED.
      expect(prisma._users[0]?.status).toBe('SUSPENDED');
    });

    it('PATCH replace name.givenName recompone name', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        name: { givenName: 'Juan', familyName: 'Pérez' },
        active: true,
      });

      const updated = await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', path: 'name.givenName', value: 'Juan Carlos' }],
      });
      expect(updated.name?.givenName).toBe('Juan Carlos');
      expect(updated.name?.familyName).toBe('Pérez');
      expect(prisma._users[0]?.name).toBe('Juan Carlos Pérez');
    });

    it('PATCH path desconocido → 400 invalidPath', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      await expect(
        service.patchUser(TENANT_A, created.id, {
          Operations: [{ op: 'replace', path: 'foo.bar', value: 'x' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('PATCH replace sin path con value=objeto aplica merge parcial', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      prisma._users[0]!.status = 'ACTIVE';

      const updated = await service.patchUser(TENANT_A, created.id, {
        Operations: [
          {
            op: 'replace',
            value: {
              active: false,
              displayName: 'Renombrado',
            },
          },
        ],
      });
      expect(updated.active).toBe(false);
      expect(updated.displayName).toBe('Renombrado');
    });

    it('PATCH no-op (sin cambios reales) NO escribe audit log', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      audit.recordSpy.mockClear();

      // active=true sobre un PENDING no provoca status change (PENDING → ACTIVE
      // es lo que dispararía cambio; pero PENDING + active=true es ya activo
      // semánticamente). Aquí pasamos active=true con user PENDING → debería
      // pasar a ACTIVE → SÍ habrá audit. Probamos con replace de displayName
      // al mismo valor, que es no-op real.
      await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', path: 'displayName', value: created.displayName ?? '' }],
      });
      // Aquí cambia name de Juan -> Juan (mismo) → en realidad escribe.
      // Probemos un PATCH realmente vacío de cambios.
      // Limpiamos el audit del paso anterior.
      audit.recordSpy.mockClear();
      // Reusamos el mismo flow pero sin operaciones soportadas que toquen
      // ningún campo: replace sin path con value=objeto vacío.
      await service.patchUser(TENANT_A, created.id, {
        Operations: [{ op: 'replace', value: {} }],
      });
      expect(audit.recordSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------- listUsers ----------------------------------

  describe('listUsers', () => {
    beforeEach(async () => {
      await service.createUser(TENANT_A, { userName: 'a@acme.com', active: true });
      await service.createUser(TENANT_A, { userName: 'b@acme.com', active: true });
      await service.createUser(TENANT_A, { userName: 'c@acme.com', active: true });
      await service.createUser(TENANT_B, { userName: 'a@beta.com', active: true });
    });

    it('paginado startIndex=1, count=2 devuelve los primeros 2', async () => {
      const r = await service.listUsers(TENANT_A, { startIndex: 1, count: 2 });
      expect(r.totalResults).toBe(3);
      expect(r.startIndex).toBe(1);
      expect(r.itemsPerPage).toBe(2);
      expect(r.resources.map((u) => u.userName)).toEqual(['a@acme.com', 'b@acme.com']);
    });

    it('paginado startIndex=2, count=2 devuelve b y c (1-based)', async () => {
      const r = await service.listUsers(TENANT_A, { startIndex: 2, count: 2 });
      expect(r.resources.map((u) => u.userName)).toEqual(['b@acme.com', 'c@acme.com']);
    });

    it('filter `userName eq "a@acme.com"` matchea por email exacto', async () => {
      const r = await service.listUsers(TENANT_A, {
        startIndex: 1,
        count: 50,
        filter: 'userName eq "a@acme.com"',
      });
      expect(r.totalResults).toBe(1);
      expect(r.resources[0]?.userName).toBe('a@acme.com');
    });

    it('filter inválido (estilo no soportado) → 400 invalidFilter', async () => {
      await expect(
        service.listUsers(TENANT_A, {
          startIndex: 1,
          count: 50,
          filter: 'displayName co "Juan"',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('aislamiento de tenant: tenant A no ve users de tenant B', async () => {
      const a = await service.listUsers(TENANT_A, { startIndex: 1, count: 50 });
      const b = await service.listUsers(TENANT_B, { startIndex: 1, count: 50 });
      expect(a.totalResults).toBe(3);
      expect(b.totalResults).toBe(1);
      expect(b.resources[0]?.userName).toBe('a@beta.com');
    });
  });

  // ---------------------------- getUser ------------------------------------

  describe('getUser', () => {
    it('devuelve user existente del tenant', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'juan@acme.com',
        active: true,
      });
      const r = await service.getUser(TENANT_A, created.id);
      expect(r.id).toBe(created.id);
    });

    it('NotFoundException para id desconocido', async () => {
      await expect(service.getUser(TENANT_A, 'inexistente')).rejects.toThrow(NotFoundException);
    });

    it('tenant isolation: tenant A no encuentra user del tenant B', async () => {
      const created = await service.createUser(TENANT_B, {
        userName: 'b@beta.com',
        active: true,
      });
      await expect(service.getUser(TENANT_A, created.id)).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------- deleteUser ---------------------------------

  describe('deleteUser', () => {
    it('soft delete: marca deletedAt + status=DEACTIVATED', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      await service.deleteUser(TENANT_A, created.id);
      expect(prisma._users[0]?.deletedAt).toBeInstanceOf(Date);
      expect(prisma._users[0]?.status).toBe('DEACTIVATED');
    });

    it('post delete: getUser devuelve 404 (deletedAt is null filter)', async () => {
      const created = await service.createUser(TENANT_A, {
        userName: 'a@b.com',
        active: true,
      });
      await service.deleteUser(TENANT_A, created.id);
      await expect(service.getUser(TENANT_A, created.id)).rejects.toThrow(NotFoundException);
    });
  });
});
