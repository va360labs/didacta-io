/**
 * Seed de bootstrap.
 * Idempotente: se puede correr varias veces sin duplicar nada.
 *
 * Crea:
 * - Tenant `va360` (slug, status ACTIVE)
 * - Roles del sistema: super_admin, tenant_admin, formador, alumno, auditor, empresa_manager
 * - Usuario super_admin VA360 con password seteado por env (BOOTSTRAP_PASSWORD) o el default
 *
 * Uso:
 *   BOOTSTRAP_PASSWORD='miPasswordSegura123!' \
 *   BOOTSTRAP_EMAIL='valen@va360labs.com' \
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
  { name: 'empresa_manager', description: 'RRHH de empresa bonificada' },
];

async function main() {
  const prisma = createPrismaClient();

  const tenantSlug = process.env['BOOTSTRAP_TENANT_SLUG'] ?? 'va360';
  const tenantName = process.env['BOOTSTRAP_TENANT_NAME'] ?? 'VA360 LABS';
  const adminEmail = process.env['BOOTSTRAP_EMAIL'] ?? 'valen@va360labs.com';
  const adminName = process.env['BOOTSTRAP_NAME'] ?? 'Valentín Ayesa';
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
    update: { passwordHash, name: adminName, status: 'ACTIVE' },
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
