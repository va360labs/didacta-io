import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AlreadyEnrolledError, LearningError } from '@didacta/mod-learning';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { ModuleRegistryService } from '../module-registry.service';
import {
  type AccessGroupKindDto,
  type CreateAccessGroupDto,
  type SetAccessGroupCoursesDto,
  type UpdateAccessGroupDto,
  slugify,
} from './access-groups.dto';

type LearningServiceLike = ReturnType<ModuleRegistryService['getLearningService']>;

/**
 * Type guard del error P2002 (violación de unique) de Prisma SIN depender del
 * namespace `Prisma`: su `instanceof` no estrecha el tipo en el build limpio
 * (`nest build`) y provoca TS18046. Chequea la forma estructural `{ code:'P2002' }`.
 */
function isUniqueConstraintViolation(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Tipos de retorno EXPLÍCITOS de la API del service. Necesarios para que
 * `nest build` (que emite .d.ts) no falle con TS2742 al intentar nombrar
 * tipos inferidos desde el cliente Prisma. Usan `AccessGroupKindDto` (string
 * union propio), no el enum Prisma.
 */
export interface AccessGroupSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: AccessGroupKindDto;
  isDefaultForApproval: boolean;
  autoGrantNewCourses: boolean;
  linkedTierName: string | null;
  memberCount: number;
  courseCount: number | null;
  createdAt: Date;
}

export interface AccessGroupDetailResult {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: AccessGroupKindDto;
  isDefaultForApproval: boolean;
  autoGrantNewCourses: boolean;
  linkedTierName: string | null;
  memberCount: number;
  courseIds: string[];
  members: Array<{
    userId: string;
    grantedAt: Date;
    name: string | null;
    email: string | null;
    source: string;
  }>;
}

export interface AccessGroupCourseCatalogItem {
  id: string;
  title: string;
  slug: string;
}

export interface AccessGroupUserCandidate {
  id: string;
  name: string | null;
  email: string;
}

/**
 * mod.access-groups (Fase 2) — grupos de acceso configurables.
 *
 * Un grupo otorga acceso a un SET de cursos (kind ALL_COURSES | COURSE |
 * MULTI_COURSE). El acceso se MATERIALIZA como enrollments del core
 * (`source = GROUP`) vía `LearningService` (RF-19: nunca Prisma directo a la
 * tabla de mod.learning). `mod_access_groups_grant` lleva el provenance/refcount
 * para una revocación segura: un curso solo se desmatricula cuando ningún grupo
 * vivo lo otorga, y `unenrollFromGroup` jamás toca enrollments de
 * PURCHASE/SUBSCRIPTION/API.
 *
 * Es CORE del host (módulo de primera parte, Path A), igual que mod.groups /
 * mod.events. Aislamiento multi-tenant por filtrado explícito de `tenantId` en
 * cada query (patrón GroupsController/MemberDecisionService); el fan-out a
 * servicios de módulo se envuelve en `tenantContext.run`. Ver PRD §14.
 */
@Injectable()
export class AccessGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly logger: PinoLogger,
  ) {}

  // ----------------------------- Lectura -----------------------------

  async listGroups(
    tenantId: string,
    page = 1,
    limit = 20,
  ): Promise<{ groups: AccessGroupSummary[]; total: number }> {
    const take = Math.min(50, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;
    const where = { tenantId, deletedAt: null };

    const [groups, total] = await Promise.all([
      this.prisma.modAccessGroup.findMany({
        where,
        include: { _count: { select: { courses: true } } },
        skip,
        take,
        orderBy: [{ isDefaultForApproval: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.modAccessGroup.count({ where }),
    ]);

    return {
      groups: groups.map((g) => ({
        id: g.id,
        slug: g.slug,
        name: g.name,
        description: g.description,
        kind: g.kind as AccessGroupKindDto,
        isDefaultForApproval: g.isDefaultForApproval,
        autoGrantNewCourses: g.autoGrantNewCourses,
        linkedTierName: g.linkedTierName,
        memberCount: g.memberCount,
        courseCount: g.kind === 'ALL_COURSES' ? null : g._count.courses,
        createdAt: g.createdAt,
      })),
      total,
    };
  }

  async getGroup(tenantId: string, id: string): Promise<AccessGroupDetailResult> {
    const group = await this.prisma.modAccessGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        courses: { select: { courseId: true } },
        members: {
          where: { status: 'ACTIVE' },
          select: { userId: true, grantedAt: true, source: true },
          take: 200,
          orderBy: { grantedAt: 'desc' },
        },
      },
    });
    if (!group) throw new NotFoundException('Grupo de acceso no encontrado');

    // Resolvemos nombre/email de cada miembro (mismo patrón tenant-safe que
    // listUserCandidates) para que el panel de admin muestre personas, no UUIDs.
    const memberUsers = group.members.length
      ? await this.prisma.user.findMany({
          where: { tenantId, id: { in: group.members.map((m) => m.userId) } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const usersById = new Map(memberUsers.map((u) => [u.id, u]));

    return {
      id: group.id,
      slug: group.slug,
      name: group.name,
      description: group.description,
      kind: group.kind as AccessGroupKindDto,
      isDefaultForApproval: group.isDefaultForApproval,
      autoGrantNewCourses: group.autoGrantNewCourses,
      linkedTierName: group.linkedTierName,
      memberCount: group.memberCount,
      courseIds: group.courses.map((c) => c.courseId),
      members: group.members.map((m) => ({
        userId: m.userId,
        grantedAt: m.grantedAt,
        name: usersById.get(m.userId)?.name ?? null,
        email: usersById.get(m.userId)?.email ?? null,
        source: m.source,
      })),
    };
  }

  // ----------------------------- CRUD -----------------------------

  async createGroup(tenantId: string, dto: CreateAccessGroupDto): Promise<AccessGroupDetailResult> {
    if (dto.kind === 'ALL_COURSES' && dto.courseIds && dto.courseIds.length > 0) {
      throw new BadRequestException(
        'Un grupo ALL_COURSES otorga todos los cursos; no admite lista explícita',
      );
    }
    const slug = dto.slug ?? slugify(dto.name);
    if (!slug) throw new BadRequestException('No se pudo derivar un slug válido del nombre');

    const existing = await this.prisma.modAccessGroup.findFirst({
      where: { tenantId, slug, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new BadRequestException(`Ya existe un grupo con el slug "${slug}"`);

    const group = await this.prisma.modAccessGroup.create({
      data: {
        tenantId,
        slug,
        name: dto.name,
        description: dto.description ?? null,
        kind: dto.kind,
        autoGrantNewCourses: dto.autoGrantNewCourses ?? true,
      },
    });

    if (dto.kind !== 'ALL_COURSES' && dto.courseIds && dto.courseIds.length > 0) {
      const unique = Array.from(new Set(dto.courseIds));
      await this.prisma.modAccessGroupCourse.createMany({
        data: unique.map((courseId) => ({ groupId: group.id, tenantId, courseId })),
        skipDuplicates: true,
      });
    }

    await this.audit(tenantId, 'access_group.created', group.id, { slug, kind: dto.kind });
    return this.getGroup(tenantId, group.id);
  }

  async updateGroup(
    tenantId: string,
    id: string,
    dto: UpdateAccessGroupDto,
  ): Promise<AccessGroupDetailResult> {
    const before = await this.requireGroup(tenantId, id);

    // Normaliza cadena vacía a null para el vínculo de tier.
    const linkedTierName =
      dto.linkedTierName === undefined
        ? undefined
        : dto.linkedTierName && dto.linkedTierName.trim().length > 0
          ? dto.linkedTierName.trim()
          : null;

    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefaultForApproval === true) {
        // Solo un grupo por tenant puede ser el de aprobación por defecto.
        await tx.modAccessGroup.updateMany({
          where: { tenantId, isDefaultForApproval: true, NOT: { id } },
          data: { isDefaultForApproval: false },
        });
      }
      await tx.modAccessGroup.update({
        where: { id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description === undefined ? undefined : dto.description,
          autoGrantNewCourses: dto.autoGrantNewCourses ?? undefined,
          isDefaultForApproval: dto.isDefaultForApproval ?? undefined,
          linkedTierName,
        },
      });
    });

    // Si el vínculo con el tier cambió, retira a los miembros que entraron por
    // el tier anterior (se reincorporarán en el próximo sync si corresponden).
    if (linkedTierName !== undefined && linkedTierName !== before.linkedTierName) {
      await this.revokeGroupTierMembers(tenantId, id);
    }

    await this.audit(tenantId, 'access_group.updated', id, {});
    return this.getGroup(tenantId, id);
  }

  async deleteGroup(tenantId: string, id: string) {
    const group = await this.requireGroup(tenantId, id);
    const members = await this.prisma.modAccessGroupMember.findMany({
      where: { tenantId, groupId: id, status: 'ACTIVE' },
      select: { userId: true },
    });

    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const learning = this.registry.getLearningService();
      for (const m of members) {
        await this.revokeAllGrantsForMember(tenantId, id, m.userId, learning);
      }
    });

    await this.prisma.modAccessGroup.update({
      where: { id },
      data: { deletedAt: new Date(), isDefaultForApproval: false, memberCount: 0 },
    });
    await this.prisma.modAccessGroupMember.updateMany({
      where: { tenantId, groupId: id, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    // Limpia los calendarios de drip de audiencia GROUP que apuntaban a este
    // grupo (si no, quedarían huérfanos referenciando un grupo inexistente). No
    // escribimos la tabla de mod.learning directamente: lo hace su propio service.
    try {
      await this.registry.getLearningService().deleteDripSchedulesForGroup(tenantId, id);
    } catch (err) {
      this.logger.warn(
        { err, tenantId, groupId: id },
        'access-groups: no se pudieron limpiar los drips del grupo borrado (no bloqueante)',
      );
    }

    await this.audit(tenantId, 'access_group.deleted', id, { revokedMembers: members.length });
    return { deleted: true, revokedMembers: members.length };
  }

  /**
   * Reemplaza el set de cursos de un grupo COURSE/MULTI_COURSE y reconcilia los
   * enrollments de sus miembros activos: otorga los cursos añadidos y revoca
   * (por refcount) los quitados.
   */
  async setGroupCourses(
    tenantId: string,
    id: string,
    dto: SetAccessGroupCoursesDto,
  ): Promise<AccessGroupDetailResult> {
    const group = await this.requireGroup(tenantId, id);
    if (group.kind === 'ALL_COURSES') {
      throw new BadRequestException(
        'Un grupo ALL_COURSES otorga todos los cursos; no se editan sus cursos',
      );
    }

    const desired = Array.from(new Set(dto.courseIds));
    const current = (
      await this.prisma.modAccessGroupCourse.findMany({
        where: { tenantId, groupId: id },
        select: { courseId: true },
      })
    ).map((c) => c.courseId);

    const toAdd = desired.filter((c) => !current.includes(c));
    const toRemove = current.filter((c) => !desired.includes(c));

    await this.prisma.$transaction([
      this.prisma.modAccessGroupCourse.deleteMany({
        where: {
          tenantId,
          groupId: id,
          courseId: { in: toRemove.length ? toRemove : ['00000000-0000-0000-0000-000000000000'] },
        },
      }),
      this.prisma.modAccessGroupCourse.createMany({
        data: toAdd.map((courseId) => ({ groupId: id, tenantId, courseId })),
        skipDuplicates: true,
      }),
    ]);

    if (toAdd.length || toRemove.length) {
      const members = await this.prisma.modAccessGroupMember.findMany({
        where: { tenantId, groupId: id, status: 'ACTIVE' },
        select: { userId: true },
      });
      await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
        const learning = this.registry.getLearningService();
        for (const m of members) {
          for (const courseId of toAdd) {
            await this.grantCourseToUser(tenantId, id, m.userId, courseId, learning);
          }
          for (const courseId of toRemove) {
            await this.revokeCourseFromUser(tenantId, id, m.userId, courseId, learning);
          }
        }
      });
    }

    await this.audit(tenantId, 'access_group.courses_set', id, {
      added: toAdd.length,
      removed: toRemove.length,
    });
    return this.getGroup(tenantId, id);
  }

  // ----------------------------- Membresías -----------------------------

  async assignMembers(tenantId: string, id: string, userIds: string[]) {
    const group = await this.requireGroup(tenantId, id);
    const unique = Array.from(new Set(userIds));
    let added = 0;

    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const learning = this.registry.getLearningService();
      const courseIds = await this.resolveGroupCourseIds(tenantId, group);
      for (const userId of unique) {
        const activated = await this.activateMembership(tenantId, id, userId);
        if (activated) added += 1;
        for (const courseId of courseIds) {
          await this.grantCourseToUser(tenantId, id, userId, courseId, learning);
        }
      }
    });

    if (added > 0) {
      await this.prisma.modAccessGroup.update({
        where: { id },
        data: { memberCount: { increment: added } },
      });
    }

    await this.audit(tenantId, 'access_group.members_assigned', id, { count: unique.length });
    return { assigned: unique.length, added };
  }

  async revokeMember(tenantId: string, id: string, userId: string) {
    await this.requireGroup(tenantId, id);
    const membership = await this.prisma.modAccessGroupMember.findUnique({
      where: { mod_access_groups_member_unique: { groupId: id, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      return { revoked: false };
    }

    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const learning = this.registry.getLearningService();
      await this.revokeAllGrantsForMember(tenantId, id, userId, learning);
    });

    await this.prisma.modAccessGroupMember.update({
      where: { mod_access_groups_member_unique: { groupId: id, userId } },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await this.prisma.modAccessGroup.update({
      where: { id },
      data: { memberCount: { decrement: 1 } },
    });

    await this.audit(tenantId, 'access_group.member_revoked', id, { userId });
    return { revoked: true };
  }

  // --------------------- Integraciones con el flujo del core ---------------------

  /**
   * Asigna a un usuario recién aprobado el grupo `isDefaultForApproval` del
   * tenant (reemplaza el "enroll a todos los publicados" de Fase 1). Si el
   * tenant aún no tiene grupo por defecto configurado, hace fallback al
   * comportamiento de Fase 1 para no dejar al miembro sin acceso.
   */
  async assignDefaultGroupOnApproval(tenantId: string, userId: string): Promise<void> {
    const def = await this.prisma.modAccessGroup.findFirst({
      where: { tenantId, isDefaultForApproval: true, deletedAt: null },
      select: { id: true },
    });
    if (def) {
      await this.assignMembers(tenantId, def.id, [userId]);
      return;
    }
    this.logger.warn(
      { tenantId, userId },
      'access-groups: sin grupo por defecto configurado — fallback a enroll de todos los cursos publicados',
    );
    await this.enrollAllPublishedFallback(tenantId, userId);
  }

  /**
   * Al publicarse un curso, matricula en él a los miembros de los grupos
   * ALL_COURSES con `autoGrantNewCourses`. Invocado por el bridge que escucha
   * `courses.course.published`.
   */
  async onCoursePublished(tenantId: string, courseId: string): Promise<void> {
    const groups = await this.prisma.modAccessGroup.findMany({
      where: { tenantId, kind: 'ALL_COURSES', autoGrantNewCourses: true, deletedAt: null },
      select: { id: true },
    });
    if (groups.length === 0) return;

    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const learning = this.registry.getLearningService();
      for (const group of groups) {
        const members = await this.prisma.modAccessGroupMember.findMany({
          where: { tenantId, groupId: group.id, status: 'ACTIVE' },
          select: { userId: true },
        });
        for (const m of members) {
          await this.grantCourseToUser(tenantId, group.id, m.userId, courseId, learning);
        }
      }
    });
    this.logger.log(
      { tenantId, courseId, groups: groups.length },
      'access-groups: curso publicado otorgado a miembros de grupos ALL_COURSES',
    );
  }

  // ----------------------------- Catálogos (para la UI) -----------------------------

  /** Cursos publicados del tenant para el selector de cursos de un grupo. */
  async listCourseCatalog(tenantId: string): Promise<AccessGroupCourseCatalogItem[]> {
    const courses = await this.registry
      .getCoursesService()
      .listCourses(tenantId, { status: 'PUBLISHED' });
    return courses.map((c) => ({ id: c.id, title: c.title, slug: c.slug }));
  }

  /** Usuarios ACTIVE del tenant (búsqueda por nombre/email) para asignar a un grupo. */
  async listUserCandidates(
    tenantId: string,
    q: string | undefined,
    limit = 20,
  ): Promise<AccessGroupUserCandidate[]> {
    const take = Math.min(50, Math.max(1, limit));
    const term = q?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' as const } },
                { email: { contains: term, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, email: true },
      take,
      orderBy: { createdAt: 'desc' },
    });
    return users;
  }

  // ----------------------------- Helpers privados -----------------------------

  private async requireGroup(tenantId: string, id: string) {
    const group = await this.prisma.modAccessGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!group) throw new NotFoundException('Grupo de acceso no encontrado');
    return group;
  }

  /**
   * Crea/reactiva la membresía. Devuelve true si pasó a contar como activa.
   * `source` MANUAL (alta del admin) es "sticky": un alta manual sobre una
   * membresía TIER la promociona a MANUAL para que el tier-down no la retire.
   */
  private async activateMembership(
    tenantId: string,
    groupId: string,
    userId: string,
    source: 'MANUAL' | 'TIER' = 'MANUAL',
  ): Promise<boolean> {
    const existing = await this.prisma.modAccessGroupMember.findUnique({
      where: { mod_access_groups_member_unique: { groupId, userId } },
    });
    if (!existing) {
      await this.prisma.modAccessGroupMember.create({
        data: { groupId, tenantId, userId, status: 'ACTIVE', source },
      });
      return true;
    }
    if (existing.status !== 'ACTIVE') {
      // Reactivación: MANUAL es sticky — si la membresía revocada era MANUAL, no
      // la degradamos a TIER aunque la reactive el bridge (un tier-down futuro no
      // debe quitar lo que el admin añadió a mano).
      await this.prisma.modAccessGroupMember.update({
        where: { mod_access_groups_member_unique: { groupId, userId } },
        data: {
          status: 'ACTIVE',
          revokedAt: null,
          source: existing.source === 'MANUAL' ? 'MANUAL' : source,
        },
      });
      return true;
    }
    if (source === 'MANUAL' && existing.source !== 'MANUAL') {
      await this.prisma.modAccessGroupMember.update({
        where: { mod_access_groups_member_unique: { groupId, userId } },
        data: { source: 'MANUAL' },
      });
    }
    return false;
  }

  /**
   * Reconcilia la membresía TIER de un usuario según su tier efectivo. Lo invoca
   * el bridge al recibir `payment_connections.user_tier.changed`. Añade al usuario
   * (miembro TIER + matrícula en los cursos del grupo) a los grupos con
   * `linkedTierName === tierName`, y lo retira de los grupos donde su membresía
   * sea TIER pero ya no correspondan al tier actual. Nunca toca membresías MANUAL.
   */
  async reconcileTierMembership(
    tenantId: string,
    userId: string,
    tierName: string | null,
  ): Promise<{ addedToGroups: number; removedFromGroups: number }> {
    const linkedGroups = tierName
      ? await this.prisma.modAccessGroup.findMany({
          where: { tenantId, linkedTierName: tierName, deletedAt: null },
          select: { id: true, kind: true },
        })
      : [];
    const targetIds = linkedGroups.map((g) => g.id);

    // Membresías TIER vivas que ya NO corresponden al tier actual → retirar.
    const staleTierMemberships = await this.prisma.modAccessGroupMember.findMany({
      where: {
        tenantId,
        userId,
        status: 'ACTIVE',
        source: 'TIER',
        ...(targetIds.length ? { groupId: { notIn: targetIds } } : {}),
      },
      select: { groupId: true },
    });

    if (linkedGroups.length === 0 && staleTierMemberships.length === 0) {
      return { addedToGroups: 0, removedFromGroups: 0 };
    }

    // Conteos REALES de cambios (no candidatos): solo las altas nuevas y las
    // bajas efectivas, para que el audit y el retorno no engañen.
    let addedToGroups = 0;
    const removedToGroups = staleTierMemberships.length;
    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const learning = this.registry.getLearningService();
      for (const group of linkedGroups) {
        const added = await this.activateMembership(tenantId, group.id, userId, 'TIER');
        if (added) {
          addedToGroups += 1;
          await this.prisma.modAccessGroup.update({
            where: { id: group.id },
            data: { memberCount: { increment: 1 } },
          });
        }
        const courseIds = await this.resolveGroupCourseIds(tenantId, group);
        for (const courseId of courseIds) {
          await this.grantCourseToUser(tenantId, group.id, userId, courseId, learning);
        }
      }
      for (const m of staleTierMemberships) {
        await this.revokeAllGrantsForMember(tenantId, m.groupId, userId, learning);
        await this.prisma.modAccessGroupMember.update({
          where: { mod_access_groups_member_unique: { groupId: m.groupId, userId } },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
        await this.prisma.modAccessGroup.update({
          where: { id: m.groupId },
          data: { memberCount: { decrement: 1 } },
        });
      }
    });

    // Auditamos el cambio sobre el USUARIO (resourceId=userId); incluimos userId
    // en metadata para que sea localizable con independencia del resourceType.
    await this.audit(tenantId, 'access_group.tier_reconciled', userId, {
      userId,
      tierName,
      addedToGroups,
      removedFromGroups: removedToGroups,
    });
    return { addedToGroups, removedFromGroups: removedToGroups };
  }

  /**
   * Retira (revoca) todas las membresías TIER de un grupo. Se invoca cuando el
   * vínculo `linkedTierName` del grupo cambia/desaparece: los miembros que
   * entraron por el tier antiguo se reconcilian (los que sigan correspondiendo
   * al nuevo tier volverán a entrar en el próximo sync). No toca membresías MANUAL.
   */
  private async revokeGroupTierMembers(tenantId: string, groupId: string): Promise<void> {
    const tierMembers = await this.prisma.modAccessGroupMember.findMany({
      where: { tenantId, groupId, status: 'ACTIVE', source: 'TIER' },
      select: { userId: true },
    });
    if (tierMembers.length === 0) return;

    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const learning = this.registry.getLearningService();
      for (const m of tierMembers) {
        await this.revokeAllGrantsForMember(tenantId, groupId, m.userId, learning);
      }
    });
    await this.prisma.modAccessGroupMember.updateMany({
      where: { tenantId, groupId, status: 'ACTIVE', source: 'TIER' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await this.prisma.modAccessGroup.update({
      where: { id: groupId },
      data: { memberCount: { decrement: tierMembers.length } },
    });
  }

  private async resolveGroupCourseIds(
    tenantId: string,
    group: { id: string; kind: string },
  ): Promise<string[]> {
    if (group.kind === 'ALL_COURSES') {
      const courses = await this.registry
        .getCoursesService()
        .listCourses(tenantId, { status: 'PUBLISHED' });
      return courses.map((c) => c.id);
    }
    const rows = await this.prisma.modAccessGroupCourse.findMany({
      where: { tenantId, groupId: group.id },
      select: { courseId: true },
    });
    return rows.map((r) => r.courseId);
  }

  /** Registra el grant (provenance) y materializa el enrollment (idempotente). */
  private async grantCourseToUser(
    tenantId: string,
    groupId: string,
    userId: string,
    courseId: string,
    learning: LearningServiceLike,
  ): Promise<void> {
    await this.prisma.modAccessGroupGrant.upsert({
      where: { mod_access_groups_grant_unique: { tenantId, groupId, userId, courseId } },
      create: { tenantId, groupId, userId, courseId },
      update: { revokedAt: null },
    });
    try {
      await learning.enrollFromGroup(tenantId, userId, courseId);
    } catch (err) {
      if (err instanceof AlreadyEnrolledError) return; // ya tenía acceso por otra vía
      // Carrera P2002 (otra vía creó el enrollment a la vez): el grant ya quedó
      // registrado arriba; tratamos la colisión de unique como no-op para no
      // abortar el fan-out de assignMembers / onCoursePublished.
      if (isUniqueConstraintViolation(err)) return;
      if (err instanceof LearningError) {
        this.logger.warn(
          { tenantId, userId, courseId, code: (err as LearningError).code },
          'access-groups: no se pudo matricular en un curso del grupo — se omite (grant registrado)',
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Revoca el grant de este grupo y desmatricula solo si refcount llega a 0.
   *
   * El patrón "marcar revocado + contar grants vivos + decidir" se serializa con
   * un advisory lock por (tenant,user,course) dentro de una transacción: sin él,
   * dos revocaciones concurrentes (dos eventos user_tier.changed en workers
   * BullMQ, o tier-down + setGroupCourses) podían ver ambas `liveGrants>0` y
   * dejar el curso matriculado con 0 grants vivos (huérfano). El unenroll va
   * fuera de la tx (idempotente; un doble-unenroll es no-op).
   */
  private async revokeCourseFromUser(
    tenantId: string,
    groupId: string,
    userId: string,
    courseId: string,
    learning: LearningServiceLike,
  ): Promise<void> {
    const lockKey = `${tenantId}:${userId}:${courseId}`;
    const shouldUnenroll = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      await tx.modAccessGroupGrant.updateMany({
        where: { tenantId, groupId, userId, courseId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const liveGrants = await tx.modAccessGroupGrant.count({
        where: { tenantId, userId, courseId, revokedAt: null },
      });
      return liveGrants === 0;
    });
    if (shouldUnenroll) {
      await learning.unenrollFromGroup(tenantId, userId, courseId);
    }
  }

  private async revokeAllGrantsForMember(
    tenantId: string,
    groupId: string,
    userId: string,
    learning: LearningServiceLike,
  ): Promise<void> {
    const grants = await this.prisma.modAccessGroupGrant.findMany({
      where: { tenantId, groupId, userId, revokedAt: null },
      select: { courseId: true },
    });
    for (const g of grants) {
      await this.revokeCourseFromUser(tenantId, groupId, userId, g.courseId, learning);
    }
  }

  /** Comportamiento de Fase 1 conservado como fallback (sin grupo por defecto). */
  private async enrollAllPublishedFallback(tenantId: string, userId: string): Promise<void> {
    await this.tenantContext.run({ tenantId, traceId: randomUUID() }, async () => {
      const courses = await this.registry
        .getCoursesService()
        .listCourses(tenantId, { status: 'PUBLISHED' });
      const learning = this.registry.getLearningService();
      for (const course of courses) {
        try {
          await learning.enrollByAdmin(tenantId, null, { userId, courseId: course.id });
        } catch (err) {
          if (err instanceof AlreadyEnrolledError) continue;
          if (err instanceof LearningError) continue;
          throw err;
        }
      }
    });
  }

  private async audit(
    tenantId: string,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLog.record({
        tenantId,
        actorId: this.tenantContext.get()?.userId ?? null,
        action,
        resourceType: 'access_group',
        resourceId,
        metadata,
      });
    } catch (err) {
      this.logger.warn(
        { err, tenantId, action },
        'access-groups: fallo al auditar (no bloqueante)',
      );
    }
  }
}
