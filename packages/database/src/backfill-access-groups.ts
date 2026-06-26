/**
 * Back-fill de mod.access-groups (Fase 2).
 * Idempotente: se puede correr varias veces sin duplicar nada.
 *
 * Por cada tenant ACTIVE:
 *  1. Asegura el grupo por defecto "VA360.pro" (kind ALL_COURSES, isDefaultForApproval
 *     si el tenant aún no tiene uno).
 *  2. Asigna como miembros a los usuarios ya aprobados por inscripción
 *     (status ACTIVE + approvalDecidedAt != null).
 *  3. ADOPTA sus enrollments de Fase 1 (source ADMIN → GROUP) y registra el grant
 *     correspondiente, para que la revocación del grupo los gobierne (refcount).
 *     NO toca enrollments PURCHASE/SUBSCRIPTION/API ni usuarios sin approvalDecidedAt.
 *
 * Uso:
 *   pnpm --filter @didacta/database db:backfill:access-groups
 */

import { createPrismaClient } from './client.js';

const DEFAULT_GROUP_SLUG = 'va360-pro';
const DEFAULT_GROUP_NAME = 'VA360.pro';

async function main() {
  const prisma = createPrismaClient();
  console.info('[backfill-access-groups] Iniciando…');

  const tenants = await prisma.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, slug: true },
  });

  for (const tenant of tenants) {
    // 1. Grupo por defecto (ALL_COURSES).
    let group = await prisma.modAccessGroup.findFirst({
      where: { tenantId: tenant.id, slug: DEFAULT_GROUP_SLUG, deletedAt: null },
    });
    if (!group) {
      const hasDefault = await prisma.modAccessGroup.findFirst({
        where: { tenantId: tenant.id, isDefaultForApproval: true, deletedAt: null },
        select: { id: true },
      });
      group = await prisma.modAccessGroup.create({
        data: {
          tenantId: tenant.id,
          slug: DEFAULT_GROUP_SLUG,
          name: DEFAULT_GROUP_NAME,
          description: 'Acceso a todos los cursos publicados (grupo por defecto al aprobar).',
          kind: 'ALL_COURSES',
          isDefaultForApproval: !hasDefault,
          autoGrantNewCourses: true,
        },
      });
    }

    // 2. Miembros aprobados por inscripción.
    const members = await prisma.user.findMany({
      where: { tenantId: tenant.id, status: 'ACTIVE', approvalDecidedAt: { not: null } },
      select: { id: true },
    });

    let assigned = 0;
    let adopted = 0;
    for (const u of members) {
      const existing = await prisma.modAccessGroupMember.findUnique({
        where: { mod_access_groups_member_unique: { groupId: group.id, userId: u.id } },
      });
      if (!existing) {
        await prisma.modAccessGroupMember.create({
          data: { groupId: group.id, tenantId: tenant.id, userId: u.id, status: 'ACTIVE' },
        });
        assigned++;
      } else if (existing.status !== 'ACTIVE') {
        await prisma.modAccessGroupMember.update({
          where: { mod_access_groups_member_unique: { groupId: group.id, userId: u.id } },
          data: { status: 'ACTIVE', revokedAt: null },
        });
        assigned++;
      }

      // 3. Adoptar enrollments ADMIN (creados por enroll-all-published de Fase 1).
      const enrollments = await prisma.modLearningEnrollment.findMany({
        where: { tenantId: tenant.id, userId: u.id, source: 'ADMIN', status: 'ACTIVE' },
        select: { courseId: true },
      });
      for (const e of enrollments) {
        await prisma.modLearningEnrollment.updateMany({
          where: { tenantId: tenant.id, userId: u.id, courseId: e.courseId, source: 'ADMIN' },
          data: { source: 'GROUP' },
        });
        await prisma.modAccessGroupGrant.upsert({
          where: {
            mod_access_groups_grant_unique: {
              tenantId: tenant.id,
              groupId: group.id,
              userId: u.id,
              courseId: e.courseId,
            },
          },
          create: { tenantId: tenant.id, groupId: group.id, userId: u.id, courseId: e.courseId },
          update: { revokedAt: null },
        });
        adopted++;
      }
    }

    const count = await prisma.modAccessGroupMember.count({
      where: { tenantId: tenant.id, groupId: group.id, status: 'ACTIVE' },
    });
    await prisma.modAccessGroup.update({
      where: { id: group.id },
      data: { memberCount: count },
    });

    console.info(
      `[backfill-access-groups] tenant ${tenant.slug}: grupo "${group.slug}" (default=${group.isDefaultForApproval}), ${assigned} miembros nuevos, ${adopted} enrollments adoptados, total miembros=${count}`,
    );
  }

  await prisma.$disconnect();
  console.info('[backfill-access-groups] Completado.');
}

main().catch((err) => {
  console.error('[backfill-access-groups] Error:', err);
  process.exit(1);
});
