/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Seed de bootstrap.
 * Idempotente: se puede correr varias veces sin duplicar nada.
 *
 * El camino canónico para instalar Didacta es el setup wizard (/setup/init):
 * arranca el contenedor sin envs `BOOTSTRAP_*` y configura por UI. Este seed
 * es la alternativa headless (CI, scripts) y se mantiene mínimo.
 *
 * Crea:
 * - Tenant de bootstrap (slug de BOOTSTRAP_TENANT_SLUG, default `demo`, status ACTIVE)
 * - Roles del sistema: super_admin, tenant_admin, formador, alumno, auditor, empresa_manager
 * - Usuario super_admin con password seteado por env (BOOTSTRAP_PASSWORD, obligatoria)
 *
 * Uso:
 *   BOOTSTRAP_PASSWORD='miPasswordSegura123!' \
 *   BOOTSTRAP_EMAIL='admin@example.com' \
 *   pnpm --filter @didacta/database db:seed
 */

import * as argon2 from 'argon2';
import { createPrismaClient } from './client.js';

const SYSTEM_ROLES = [
  { name: 'super_admin', description: 'Acceso global a la plataforma' },
  { name: 'tenant_admin', description: 'Gestor de un tenant' },
  { name: 'formador', description: 'Crea y mantiene cursos' },
  { name: 'alumno', description: 'Consume cursos y se matricula' },
  { name: 'auditor', description: 'Acceso de solo lectura para auditoría' },
  {
    name: 'inspector',
    description: 'Seguimiento Fundae: solo lectura, acotado a los grupos concedidos',
  },
  { name: 'empresa_manager', description: 'RRHH de empresa bonificada' },
];

async function main() {
  const prisma = createPrismaClient();

  const tenantSlug = process.env['BOOTSTRAP_TENANT_SLUG'] ?? 'demo';
  const tenantName = process.env['BOOTSTRAP_TENANT_NAME'] ?? 'Demo';
  const adminEmail = process.env['BOOTSTRAP_EMAIL'] ?? 'admin@example.com';
  const adminName = process.env['BOOTSTRAP_NAME'] ?? 'Admin';
  const adminPassword = process.env['BOOTSTRAP_PASSWORD'];

  if (!adminPassword || adminPassword.length < 12) {
    throw new Error(
      'BOOTSTRAP_PASSWORD obligatoria, mínimo 12 caracteres. Generá una con `openssl rand -base64 24`.',
    );
  }

  console.info('[seed] Iniciando bootstrap…');

  // 1. Tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: tenantSlug },
    update: { name: tenantName, status: 'ACTIVE' },
    create: { slug: tenantSlug, name: tenantName, status: 'ACTIVE' },
  });
  console.info(`[seed] Tenant ${tenant.slug} (${tenant.id}) listo`);

  // 1.b TenantDomains — mapeo Host header → tenant para login transparente.
  // Sembramos los hosts donde el bootstrap tenant es accesible (default: solo
  // localhost para dev; en un despliegue real pasá tus dominios por env).
  // Cualquier domain extra se gestiona desde /admin/tenants (super_admin).
  const defaultDomains = (process.env['BOOTSTRAP_DOMAINS'] ?? 'localhost,127.0.0.1')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  for (const [idx, hostname] of defaultDomains.entries()) {
    await prisma.tenantDomain.upsert({
      where: { hostname },
      update: { tenantId: tenant.id, isVerified: true },
      create: {
        tenantId: tenant.id,
        hostname,
        isPrimary: idx === 0,
        isVerified: true,
      },
    });
  }
  console.info(`[seed] ${defaultDomains.length} dominios sembrados para ${tenant.slug}`);

  // 2. Roles del sistema
  for (const role of SYSTEM_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description, isSystem: true },
      create: { name: role.name, description: role.description, isSystem: true },
    });
  }
  console.info(`[seed] ${SYSTEM_ROLES.length} roles del sistema garantizados`);

  // 3. Usuario super_admin
  const passwordHash = await argon2.hash(adminPassword, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: adminEmail } },
    // NO pisamos passwordHash en update: si el usuario ya cambió su contraseña
    // (en la app), re-correr el seed en un deploy NO debe revertirla. La
    // contraseña de BOOTSTRAP_PASSWORD solo se aplica al CREAR el usuario.
    update: { name: adminName, status: 'ACTIVE' },
    create: {
      tenantId: tenant.id,
      email: adminEmail,
      name: adminName,
      passwordHash,
      status: 'ACTIVE',
    },
  });

  // 4. Asignar role super_admin
  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'super_admin' } });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: superAdminRole.id } },
    update: {},
    create: { userId: user.id, roleId: superAdminRole.id },
  });

  console.info(`[seed] Usuario ${user.email} (${user.id}) con rol super_admin`);
  console.info('[seed] OK. Tenant slug + email + password listos para login.');
  console.info(`[seed] Login en: tenantSlug=${tenant.slug} email=${user.email}`);

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error('[seed] FALLÓ:', error);
  process.exit(1);
});
