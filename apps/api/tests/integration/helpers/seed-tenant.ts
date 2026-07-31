/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Helper de tests de integración (ART-025).
 *
 * Crea (idempotente) un tenant mínimo en Postgres para que los endpoints EE
 * que persisten datos asociados al tenant (audit logs, tenant settings, etc.)
 * puedan resolver las foreign keys sin "Foreign key constraint violated:
 * tenant_setting_tenant_id_fkey".
 *
 * Lo mantenemos como helper aparte para no inflar `test-app.ts` y para que
 * cada test decida si necesita seed (los smoke tests de gating no lo necesitan
 * cuando el endpoint sólo lee).
 */

import type { PrismaService } from '../../../src/prisma/prisma.service';
import { TEST_TENANT_ID, TEST_USER_ID } from './issue-test-jwt';

/**
 * Slug aleatorio por seed para evitar colisiones entre tests si dos tests
 * paralelos seedean el mismo tenantId con un slug constante (no debería pasar
 * con singleFork, pero es defensivo). Sufijo se calcula 1 vez al cargar el
 * módulo.
 */
const SLUG_SUFFIX = Math.random().toString(36).slice(2, 8);

/**
 * Asegura que existe en la DB un tenant + user con los IDs canónicos del
 * helper `issueTestAccessJwt`. Idempotente: hace `upsert`. NO crea sesiones
 * ni dependencias adicionales — los services que escriben (audit log,
 * tenant settings) sólo necesitan el tenant + el actor (user).
 *
 * Uso:
 *   const testApp = await createTestApp({...});
 *   await seedMinimalTenant(testApp.prisma);
 */
export async function seedMinimalTenant(prisma: PrismaService): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: TEST_TENANT_ID },
    create: {
      id: TEST_TENANT_ID,
      slug: `integration-test-${SLUG_SUFFIX}`,
      name: 'Integration Test Tenant',
      status: 'ACTIVE',
      config: {},
    },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: TEST_USER_ID },
    create: {
      id: TEST_USER_ID,
      tenantId: TEST_TENANT_ID,
      email: `admin-${SLUG_SUFFIX}@didacta.test`,
      // passwordHash es opcional en el schema (login OIDC/SCIM no lo usa).
      // Los roles vienen en el JWT, no en la fila User.
      name: 'Integration Admin',
    },
    update: {},
  });
}
