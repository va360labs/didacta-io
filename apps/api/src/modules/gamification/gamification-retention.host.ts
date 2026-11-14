/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { academyLocale, type AcademyDefaultsPrisma } from '../../common/academy-defaults';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';

/** Roles del equipo: no se les celebra la bienvenida ni el aniversario. */
const STAFF_ROLES = ['super_admin', 'tenant_admin', 'formador'];

export interface RetentionMember {
  id: string;
  name: string;
  timeZone: string;
  joinedAt: Date;
  isStaff: boolean;
}

/**
 * Lo que la retención de mod.gamification necesita del core y de otros
 * módulos, resuelto aquí, en la capa de composición (el módulo no lee tablas
 * ajenas, ADR-016/039):
 *  - del core: nombre, zona horaria, alta y rol de cada persona; idioma del
 *    aula; quién firma las celebraciones;
 *  - de mod.courses: título y slug de un curso (por su servicio público).
 */
@Injectable()
export class GamificationRetentionHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  async members(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, RetentionMember>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        timezone: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    return new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          // Nunca el email en público: sin nombre, la parte local recortada.
          name: u.name?.trim() || (u.email ?? '').split('@')[0] || '—',
          timeZone: u.timezone || 'UTC',
          joinedAt: u.createdAt,
          isStaff: u.roles.some((r) => STAFF_ROLES.includes(r.role.name)),
        },
      ]),
    );
  }

  async member(tenantId: string, userId: string): Promise<RetentionMember | null> {
    return (await this.members(tenantId, [userId])).get(userId) ?? null;
  }

  async locale(tenantId: string): Promise<string> {
    return academyLocale(this.prisma as unknown as AcademyDefaultsPrisma, tenantId);
  }

  /**
   * Quién firma las celebraciones: quien administra el aula (el primero que se
   * dio de alta). No hay «usuario del sistema»: el post sale a nombre del
   * creador, como la bienvenida del modo sencillo y los anuncios de directos.
   */
  async celebrationAuthor(tenantId: string): Promise<{ id: string; displayName: string } | null> {
    const owner = await this.prisma.user.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: ['tenant_admin', 'super_admin'] } } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true },
    });
    if (!owner) return null;
    return { id: owner.id, displayName: owner.name?.trim() || owner.email.split('@')[0]! };
  }

  /** Título y slug de un curso por el servicio público de mod.courses. */
  async course(
    tenantId: string,
    courseId: string,
  ): Promise<{
    id: string;
    title: string;
    slug: string;
    status: string;
    externalPurchaseUrl: string | null;
  } | null> {
    try {
      const c = await this.registry.getCoursesService().getCourseDetail(tenantId, courseId);
      return {
        id: c.id,
        title: c.title,
        slug: c.slug,
        status: c.status,
        externalPurchaseUrl: c.externalPurchaseUrl ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Día UTC `YYYY-MM-DD` con el que se agrupan las celebraciones. */
  static utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
  }
}
