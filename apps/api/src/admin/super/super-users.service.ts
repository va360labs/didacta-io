/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { LICENSE_CAPABILITIES, LicenseService } from '@didacta/license-sdk';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Listings cross-tenant para super_admin (follow-up `feat:multi_tenant.real`).
 *
 * Diferencia con AdminUsersService:
 *  - AdminUsersService filtra siempre por `tenantId` del JWT (tenant-scoped).
 *  - SuperUsersService lista usuarios de TODOS los tenants. Requiere licencia
 *    EE `feat:multi_tenant.real`; sin ella → 402 vía CapabilityRequiredError.
 *  - Pensado para holdings con varias filiales, no para tenant_admin individual.
 *
 * Nota sobre RLS: el rol Postgres que usa Prisma actualmente tiene BYPASSRLS,
 * por lo que las policies de `rls.sql` no enforzan a nivel BD. El enforcement
 * lógico vive en el código (filtros explícitos).
 */
export interface SuperUserListItem {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  roles: string[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
}

export interface SuperUsersListResult {
  items: SuperUserListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface SuperUsersListFilters {
  search?: string;
  status?: string;
  role?: string;
  tenantId?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class SuperUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly license: LicenseService,
  ) {}

  /**
   * Pre-chequea la capability antes de listar. Sin EE el endpoint devuelve
   * 402 (no se filtra a un solo tenant — el flujo correcto en CE es usar
   * `/admin/users`, que sí es tenant-scoped).
   */
  async list(filters: SuperUsersListFilters): Promise<SuperUsersListResult> {
    this.license.requireCapability(LICENSE_CAPABILITIES.MULTI_TENANT_REAL);

    const where: Record<string, unknown> = { deletedAt: null };
    if (filters.tenantId) where.tenantId = filters.tenantId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      const q = filters.search.trim();
      if (q) {
        where.OR = [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ];
      }
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: {
          roles: { include: { role: true } },
          tenant: { select: { id: true, slug: true, name: true } },
        },
        orderBy: [{ tenantId: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count({ where }),
    ]);

    let items = users.map((u) => this.toListItem(u));

    // Filtro por rol se aplica post-fetch para no complicar el where con joins
    // por los pivots. El total reportado refleja el filtro pre-rol; si se
    // necesitase total exacto post-rol, conviene query SQL custom.
    if (filters.role) {
      items = items.filter((u) => u.roles.includes(filters.role!));
    }

    return { items, total, limit, offset };
  }

  private toListItem(u: {
    id: string;
    email: string;
    name: string | null;
    status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
    roles: Array<{ role: { name: string } }>;
    mfaEnabled: boolean;
    emailVerified: boolean;
    createdAt: Date;
    lastLoginAt: Date | null;
    tenantId: string;
    tenant: { id: string; slug: string; name: string } | null;
  }): SuperUserListItem {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      roles: u.roles.map((r) => r.role.name),
      mfaEnabled: u.mfaEnabled,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      tenantId: u.tenantId,
      tenantSlug: u.tenant?.slug ?? '',
      tenantName: u.tenant?.name ?? '',
    };
  }
}
