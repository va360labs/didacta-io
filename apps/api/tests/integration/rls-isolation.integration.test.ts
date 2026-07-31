/**
 * Tests de integración para Row-Level Security (RLS).
 *
 * Estos tests verifican que las políticas RLS en PostgreSQL funcionan
 * correctamente, aislando datos entre tenants.
 *
 * REQUISITOS:
 * - Base de datos PostgreSQL con schema aplicado
 * - Políticas RLS aplicadas (pnpm --filter @didacta/database db:rls:apply)
 * - Variable de entorno DATABASE_URL configurada
 *
 * SKIP: Si no hay DATABASE_URL, los tests se saltan con warning.
 *
 * @see packages/database/prisma/rls.sql
 * @see DISC-003
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env['DATABASE_URL'];

// Skip tests si no hay DB configurada
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('RLS Isolation (integration)', () => {
  let prisma: PrismaClient;
  let tenantA: { id: string; slug: string };
  let tenantB: { id: string; slug: string };

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // Crear dos tenants de prueba
    tenantA = await prisma.tenant.create({
      data: {
        id: randomUUID(),
        slug: `test-tenant-a-${Date.now()}`,
        name: 'Tenant A (RLS Test)',
        plan: 'starter',
      },
    });

    tenantB = await prisma.tenant.create({
      data: {
        id: randomUUID(),
        slug: `test-tenant-b-${Date.now()}`,
        name: 'Tenant B (RLS Test)',
        plan: 'starter',
      },
    });
  });

  afterAll(async () => {
    // Cleanup: borrar tenants de prueba
    // Usamos deleteMany porque las FKs pueden causar problemas con delete
    if (tenantA?.id) {
      await prisma.user.deleteMany({ where: { tenantId: tenantA.id } });
      await prisma.tenant.delete({ where: { id: tenantA.id } }).catch(() => {});
    }
    if (tenantB?.id) {
      await prisma.user.deleteMany({ where: { tenantId: tenantB.id } });
      await prisma.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  /**
   * Helper: ejecuta query con RLS context de un tenant específico.
   */
  async function withTenant<T>(tenantId: string, callback: (tx: any) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return callback(tx);
    });
  }

  describe('Aislamiento de lectura', () => {
    it('tenant A solo ve sus propios usuarios', async () => {
      // Setup: crear usuarios en ambos tenants
      const userA = await prisma.user.create({
        data: {
          id: randomUUID(),
          tenantId: tenantA.id,
          email: `user-a-${Date.now()}@test.com`,
          passwordHash: 'hash',
        },
      });

      const userB = await prisma.user.create({
        data: {
          id: randomUUID(),
          tenantId: tenantB.id,
          email: `user-b-${Date.now()}@test.com`,
          passwordHash: 'hash',
        },
      });

      // Query desde contexto de tenant A
      const usersSeenByA = await withTenant(tenantA.id, async (tx) => {
        return tx.user.findMany({ select: { id: true, tenantId: true } });
      });

      // Verificar que solo ve usuarios de su tenant
      expect(usersSeenByA.every((u: any) => u.tenantId === tenantA.id)).toBe(true);
      expect(usersSeenByA.some((u: any) => u.id === userA.id)).toBe(true);
      expect(usersSeenByA.some((u: any) => u.id === userB.id)).toBe(false);

      // Cleanup
      await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    });

    it('sin contexto de tenant, RLS devuelve 0 rows', async () => {
      // Setup: crear un usuario
      const user = await prisma.user.create({
        data: {
          id: randomUUID(),
          tenantId: tenantA.id,
          email: `user-nocontext-${Date.now()}@test.com`,
          passwordHash: 'hash',
        },
      });

      // Query SIN setear app.current_tenant_id
      // current_tenant_id() devuelve NULL, y tenant_id = NULL es siempre falso
      const usersNoContext = await prisma.$transaction(async (tx) => {
        // Explícitamente NO seteamos el tenant
        return tx.user.findMany({ where: { id: user.id } });
      });

      // RLS debería filtrar todo (0 rows)
      expect(usersNoContext).toHaveLength(0);

      // Cleanup (sin RLS porque usamos el cliente directo)
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('Aislamiento de escritura', () => {
    it('no permite crear usuario con tenantId de otro tenant', async () => {
      // Intentar crear usuario en tenant B desde contexto de tenant A
      // RLS WITH CHECK debería rechazarlo
      const attemptCrossTenantCreate = withTenant(tenantA.id, async (tx) => {
        return tx.user.create({
          data: {
            id: randomUUID(),
            tenantId: tenantB.id, // ← Intentando escribir en otro tenant
            email: `cross-tenant-${Date.now()}@test.com`,
            passwordHash: 'hash',
          },
        });
      });

      // Debería fallar con error de RLS (new row violates policy)
      await expect(attemptCrossTenantCreate).rejects.toThrow();
    });

    it('permite crear usuario en el mismo tenant del contexto', async () => {
      const userId = randomUUID();

      const user = await withTenant(tenantA.id, async (tx) => {
        return tx.user.create({
          data: {
            id: userId,
            tenantId: tenantA.id, // ← Mismo tenant que el contexto
            email: `same-tenant-${Date.now()}@test.com`,
            passwordHash: 'hash',
          },
        });
      });

      expect(user.id).toBe(userId);
      expect(user.tenantId).toBe(tenantA.id);

      // Cleanup
      await prisma.user.delete({ where: { id: userId } });
    });
  });

  describe('Tablas globales (sin RLS)', () => {
    it('installed_module es accesible sin contexto de tenant', async () => {
      // Las tablas sin columna tenant_id no tienen RLS
      // installed_module es global (a nivel de instancia, no de tenant)
      const modules = await prisma.installedModule.findMany({
        take: 5,
      });

      // No debería lanzar error, aunque el array puede estar vacío
      expect(Array.isArray(modules)).toBe(true);
    });

    it('tenant es accesible sin contexto de tenant', async () => {
      const tenants = await prisma.tenant.findMany({
        where: { id: { in: [tenantA.id, tenantB.id] } },
      });

      expect(tenants).toHaveLength(2);
    });
  });
});
