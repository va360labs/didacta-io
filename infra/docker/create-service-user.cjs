/* eslint-disable */
// ============================================================================
// create-service-user.cjs — crea/actualiza un usuario de SERVICIO (super_admin)
// para que el agente pueda hacer pruebas sin usar la cuenta del dueño.
//
// Lee de env:
//   SERVICE_USER_EMAIL    (default service@didacta.local)
//   SERVICE_USER_PASSWORD (obligatoria — generada y guardada en el .env)
//   SERVICE_TENANT_SLUG   (default demo, el del seed de bootstrap)
//
// Uso (con el stack de docker-compose.alpha.yml levantado):
//   docker compose -f docker-compose.alpha.yml run --rm \
//     -v ./infra/docker/create-service-user.cjs:/tmp/cu.cjs \
//     didacta sh -lc "cd /app && node /tmp/cu.cjs"
// ============================================================================
const argon2 = require('argon2');
const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  const email = process.env.SERVICE_USER_EMAIL || 'service@didacta.local';
  const pass = process.env.SERVICE_USER_PASSWORD;
  const slug = process.env.SERVICE_TENANT_SLUG || 'demo';
  if (!pass) {
    console.error('ERR: falta SERVICE_USER_PASSWORD');
    process.exit(1);
  }
  const tenant = await prisma.tenant.findFirst({ where: { slug } });
  if (!tenant) {
    console.error(`ERR: tenant '${slug}' no existe`);
    process.exit(1);
  }
  const hash = await argon2.hash(pass, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email } },
    update: { passwordHash: hash, status: 'ACTIVE', name: 'Didacta Dev (servicio)' },
    create: {
      tenantId: tenant.id,
      email,
      name: 'Didacta Dev (servicio)',
      passwordHash: hash,
      status: 'ACTIVE',
    },
  });
  const role = await prisma.role.findFirst({ where: { name: 'super_admin' } });
  if (role) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
  }
  console.log('SERVICE_USER_OK', user.email, user.id);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERR', e && e.message ? e.message : e);
  process.exit(1);
});
