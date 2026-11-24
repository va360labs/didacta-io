/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { slugify } from '@didacta/mod-access-groups';
import {
  MEMBER_REGISTRATION_SCOPE,
  MemberRegistrationSettings,
  VERIFICATION_SETTING_KEY,
} from '@didacta/mod-member-registration';
import { MembershipTierInUseError, type TierRow } from '@didacta/mod-subscriptions';
import { AccessGroupsService } from '../access-groups/access-groups.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PrismaTenantConfigService } from '../prisma-tenant-config.service';
import { TenantModulesService } from '../tenant-modules.service';
import type { CreateTierDto, UpdateTierDto } from './membership-tiers.dto';

/** Módulo del registro gratis: la puerta del nivel gratis. */
const FREE_SIGNUP_MODULE = 'mod.member-registration';

type PlanRow = Awaited<
  ReturnType<ReturnType<ModuleRegistryService['getMembershipService']>['listPlans']>
>[number];

/** Un nivel tal y como lo edita el creador (modo completo y modo sencillo). */
export interface MembershipTierAdminView {
  id: string;
  name: string;
  description: string | null;
  isFree: boolean;
  sortOrder: number;
  active: boolean;
  accessGroupId: string | null;
  /** `true`: el nivel da todos los cursos publicados (también los nuevos). */
  allCourses: boolean;
  /** Cursos del nivel (vacío con `allCourses`). */
  courseIds: string[];
  /** Planes del nivel (periodicidades), también los apagados. */
  plans: PlanRow[];
  /**
   * Gente dentro: en uno de pago, las membresías vivas de sus planes; en el
   * gratis, los miembros de su grupo.
   */
  members: number;
}

export interface MembershipTiersAdminView {
  tiers: MembershipTierAdminView[];
  /** Planes sin nivel (los de antes): pasan al primer nivel de pago que se cree. */
  legacyPlanCount: number;
  /** El registro gratis (la puerta del nivel gratis) está encendido y abierto. */
  freeSignup: { moduleEnabled: boolean; open: boolean };
}

/**
 * Niveles de la membresía, la parte que COMPONE dos módulos: las filas de nivel
 * (mod.subscriptions) y el grupo de acceso de cada nivel (mod.access-groups, a
 * través de su service público: nunca escribiendo sus tablas).
 *
 *  - Crear un nivel crea su grupo (todos los cursos, o los elegidos).
 *  - El PRIMER nivel de pago de un aula que ya vendía membresía se queda con
 *    el grupo de siempre y con los planes de siempre: quien ya paga no nota
 *    nada.
 *  - El nivel gratis hace de su grupo el «grupo por defecto al aprobar» del
 *    registro gratis y enciende ese registro (módulo y política), que es la
 *    puerta de entrada al nivel gratis.
 */
@Injectable()
export class MembershipTiersOrchestrator {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly accessGroups: AccessGroupsService,
    private readonly tenantModules: TenantModulesService,
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly logger: PinoLogger,
  ) {}

  private get tiers() {
    return this.registry.getMembershipTiersService();
  }

  private get membership() {
    return this.registry.getMembershipService();
  }

  async list(tenantId: string): Promise<MembershipTiersAdminView> {
    const [rows, plans, legacyPlanCount, freeSignup] = await Promise.all([
      this.tiers.listTiers(tenantId),
      this.membership.listPlans(tenantId),
      this.tiers.countLegacyPlans(tenantId),
      this.freeSignupState(tenantId),
    ]);
    const tiers: MembershipTierAdminView[] = [];
    for (const row of rows) tiers.push(await this.view(tenantId, row, plans));
    return { tiers, legacyPlanCount, freeSignup };
  }

  async get(tenantId: string, tierId: string): Promise<MembershipTierAdminView> {
    const row = await this.tiers.getTier(tenantId, tierId);
    return this.view(tenantId, row, await this.membership.listPlans(tenantId));
  }

  async create(
    tenantId: string,
    actorId: string,
    dto: CreateTierDto,
  ): Promise<MembershipTierAdminView> {
    const isFree = dto.isFree === true;
    // Lo que el service validaría, ANTES de crear el grupo: un nombre repetido
    // o un segundo nivel gratis no deben dejar un grupo huérfano.
    const existing = await this.tiers.listTiers(tenantId);
    const name = dto.name.trim().replace(/\s+/g, ' ');
    if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      throw new BadRequestException({
        message: 'Ya hay un nivel con ese nombre.',
        code: 'MEMBERSHIP_TIER_INVALID',
        detail: 'name_taken',
      });
    }
    if (isFree && existing.some((t) => t.isFree)) {
      throw new BadRequestException({
        message: 'Ya hay un nivel gratis.',
        code: 'MEMBERSHIP_TIER_INVALID',
        detail: 'free_exists',
      });
    }

    // Primer nivel de pago de un aula que ya vendía: se queda con el grupo y
    // los planes de siempre.
    const firstPaid = !isFree && !existing.some((t) => !t.isFree);
    const legacyPlans = firstPaid ? await this.tiers.countLegacyPlans(tenantId) : 0;
    const config = await this.membership.getConfig(tenantId);
    const adoptGroup =
      firstPaid && legacyPlans > 0 && config.accessGroupId
        ? await this.liveGroup(tenantId, config.accessGroupId)
        : null;

    let groupId: string;
    let createdGroup = false;
    if (adoptGroup) {
      groupId = adoptGroup.id;
      if (dto.courseIds && adoptGroup.kind !== 'ALL_COURSES') {
        await this.accessGroups.setGroupCourses(tenantId, groupId, { courseIds: dto.courseIds });
      }
    } else {
      const allCourses = dto.allCourses === true;
      const group = await this.accessGroups.createGroup(tenantId, {
        name: groupName(name),
        slug: groupSlug(name),
        kind: allCourses ? 'ALL_COURSES' : 'MULTI_COURSE',
        description:
          `Contenido del nivel «${name}» de la membresía. Se cambia en Membresía → Niveles.`.slice(
            0,
            500,
          ),
        ...(allCourses ? {} : { courseIds: dto.courseIds ?? [] }),
        autoGrantNewCourses: true,
      });
      groupId = group.id;
      createdGroup = true;
    }

    let tier: TierRow;
    try {
      tier = await this.tiers.createTier(tenantId, {
        name,
        description: dto.description ?? null,
        isFree,
        accessGroupId: groupId,
      });
    } catch (err) {
      if (createdGroup) {
        await this.accessGroups.deleteGroup(tenantId, groupId).catch(() => undefined);
      }
      throw err;
    }

    if (firstPaid && legacyPlans > 0) {
      const moved = await this.tiers.adoptLegacyPlans(tenantId, tier.id);
      this.logger.log(
        { tenantId, tierId: tier.id, moved, adoptedGroup: Boolean(adoptGroup) },
        'membresía: primer nivel de pago — los planes de siempre pasan a este nivel',
      );
    }
    if (isFree) await this.openFreeSignup(tenantId, actorId, groupId);
    return this.get(tenantId, tier.id);
  }

  async update(
    tenantId: string,
    actorId: string,
    tierId: string,
    dto: UpdateTierDto,
  ): Promise<MembershipTierAdminView> {
    const before = await this.tiers.getTier(tenantId, tierId);
    if (dto.courseIds !== undefined) {
      const group = before.accessGroupId
        ? await this.liveGroup(tenantId, before.accessGroupId)
        : null;
      if (!group) {
        throw new BadRequestException({
          message: 'Este nivel no tiene grupo de acceso.',
          code: 'MEMBERSHIP_TIER_INVALID',
          detail: 'no_group',
        });
      }
      if (group.kind === 'ALL_COURSES') {
        throw new BadRequestException({
          message: 'Este nivel da todos los cursos: no se eligen uno a uno.',
          code: 'MEMBERSHIP_TIER_INVALID',
          detail: 'all_courses',
        });
      }
      await this.accessGroups.setGroupCourses(tenantId, group.id, { courseIds: dto.courseIds });
    }

    const after = await this.tiers.updateTier(tenantId, tierId, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    });

    if (after.name !== before.name) {
      if (after.accessGroupId && (await this.ownsGroup(tenantId, after))) {
        await this.accessGroups
          .updateGroup(tenantId, after.accessGroupId, { name: groupName(after.name) })
          .catch(() => undefined);
      }
      await this.renamePlans(tenantId, after.id, before.name, after.name);
    }

    // El nivel gratis apagado deja de ser la puerta del registro (las altas
    // nuevas ya no lo reciben); encendido, vuelve a serlo.
    if (after.isFree && after.accessGroupId && after.active !== before.active) {
      if (after.active) {
        await this.openFreeSignup(tenantId, actorId, after.accessGroupId);
      } else {
        await this.accessGroups.updateGroup(tenantId, after.accessGroupId, {
          isDefaultForApproval: false,
        });
      }
    }
    return this.get(tenantId, after.id);
  }

  async reorder(tenantId: string, tierIds: string[]): Promise<MembershipTiersAdminView> {
    await this.tiers.reorderTiers(tenantId, tierIds);
    return this.list(tenantId);
  }

  /**
   * Borra un nivel que no tiene a nadie dentro (ni planes vendidos ni miembros
   * en su grupo) y su grupo, si es suyo. Con gente dentro: 409, se apaga.
   */
  async remove(tenantId: string, tierId: string): Promise<void> {
    const tier = await this.tiers.getTier(tenantId, tierId);
    const group = tier.accessGroupId ? await this.liveGroup(tenantId, tier.accessGroupId) : null;
    if (group && group.memberCount > 0) throw new MembershipTierInUseError(tier.id);
    await this.tiers.deleteTier(tenantId, tier.id);
    if (group && (await this.ownsGroup(tenantId, tier))) {
      await this.accessGroups.deleteGroup(tenantId, group.id);
    }
  }

  // ---------------- Helpers ----------------

  private async view(
    tenantId: string,
    row: TierRow,
    plans: PlanRow[],
  ): Promise<MembershipTierAdminView> {
    const group = row.accessGroupId ? await this.liveGroup(tenantId, row.accessGroupId) : null;
    const members = row.isFree
      ? (group?.memberCount ?? 0)
      : await this.tiers.countLiveSubscriptions(tenantId, row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isFree: row.isFree,
      sortOrder: row.sortOrder,
      active: row.active,
      accessGroupId: group ? group.id : null,
      allCourses: group?.kind === 'ALL_COURSES',
      courseIds: group && group.kind !== 'ALL_COURSES' ? group.courseIds : [],
      plans: plans.filter((p) => p.tierId === row.id),
      members,
    };
  }

  /** El grupo si existe y no está borrado; `null` si no. */
  private async liveGroup(tenantId: string, groupId: string) {
    try {
      return await this.accessGroups.getGroup(tenantId, groupId);
    } catch {
      return null;
    }
  }

  /**
   * ¿El grupo del nivel es SOLO suyo? No lo es si es el grupo de la
   * configuración de la membresía (lo heredó el primer nivel) o si otro nivel
   * lo comparte: entonces no se renombra ni se borra con el nivel.
   */
  private async ownsGroup(tenantId: string, tier: TierRow): Promise<boolean> {
    if (!tier.accessGroupId) return false;
    const config = await this.membership.getConfig(tenantId);
    if (config.accessGroupId === tier.accessGroupId) return false;
    const all = await this.tiers.listTiers(tenantId);
    return !all.some((t) => t.id !== tier.id && t.accessGroupId === tier.accessGroupId);
  }

  /**
   * Los planes que se llaman «<nivel> · …» siguen al nivel al renombrarlo (y su
   * Product de Stripe con ellos). Un choque de nombre no para el renombrado.
   */
  private async renamePlans(tenantId: string, tierId: string, from: string, to: string) {
    const prefix = `${from} · `;
    const plans = (await this.membership.listPlans(tenantId)).filter(
      (p) => p.tierId === tierId && p.name.startsWith(prefix),
    );
    for (const plan of plans) {
      const name = `${to} · ${plan.name.slice(prefix.length)}`.slice(0, 80);
      try {
        await this.membership.updatePlan(tenantId, plan.id, { name });
      } catch (err) {
        this.logger.warn(
          { tenantId, planId: plan.id, error: (err as Error).message },
          'membresía: no se pudo renombrar un plan al renombrar su nivel',
        );
      }
    }
  }

  /**
   * La puerta del nivel gratis: su grupo pasa a ser el que reciben las
   * inscripciones aprobadas, el registro gratis (mod.member-registration) se
   * enciende y su política se abre (conservando los verificadores que hubiera;
   * sin ninguno: registro libre con aprobación del creador).
   */
  private async openFreeSignup(tenantId: string, actorId: string, groupId: string) {
    await this.accessGroups.updateGroup(tenantId, groupId, { isDefaultForApproval: true });
    const modules = await this.tenantModules.list(tenantId);
    if (!modules.some((m) => m.name === FREE_SIGNUP_MODULE && m.enabled)) {
      await this.tenantModules.enable(tenantId, FREE_SIGNUP_MODULE, actorId);
    }
    const settings = new MemberRegistrationSettings(this.tenantConfig);
    const policy = await settings.resolvePolicy(tenantId);
    if (!policy.enabled) {
      await this.tenantConfig.set(
        tenantId,
        MEMBER_REGISTRATION_SCOPE,
        VERIFICATION_SETTING_KEY,
        { enabled: true, verifiers: policy.verifiers },
        { actorId },
      );
    }
  }

  private async freeSignupState(tenantId: string) {
    const modules = await this.tenantModules.list(tenantId);
    const moduleEnabled = modules.some((m) => m.name === FREE_SIGNUP_MODULE && m.enabled);
    const policy = await new MemberRegistrationSettings(this.tenantConfig).resolveEffectivePolicy(
      tenantId,
    );
    return { moduleEnabled, open: moduleEnabled && policy.enabled && policy.operational };
  }
}

/** Nombre del grupo de un nivel, reconocible en «Grupos de acceso». */
function groupName(tierName: string): string {
  return `Membresía · ${tierName}`.slice(0, 120);
}

/** Slug único: el del nombre más un sufijo (dos aulas, o un nivel borrado y vuelto a crear). */
function groupSlug(tierName: string): string {
  const base = slugify(`membresia-${tierName}`).slice(0, 100) || 'membresia-nivel';
  return `${base}-${randomBytes(3).toString('hex')}`;
}
