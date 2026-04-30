/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ScimService — CRUD de Users sobre la tabla `app_user` con semántica SCIM 2.0
 * (séptimo piloto License SDK).
 *
 * Reglas duras (validadas por tests):
 *   - Tenant scoping en CADA query: where: { tenantId, deletedAt: null, ... }.
 *   - Idempotencia de POST: si el mismo userName ya existe en el tenant,
 *     devolvemos 409 SCIM con scimType='uniqueness' (no 200).
 *   - PATCH active=false → User.status='DEACTIVATED' (NO borrado físico).
 *     Active=true → status='ACTIVE'.
 *   - Audit log per operación: prefix `scim.user.<verb>` para que el panel de
 *     auditoría pueda filtrarlos.
 *   - Cero FKs cross-module: este service NO toca tabla de roles ni asigna
 *     ningún rol al user creado. Los roles los asigna el admin del tenant
 *     manualmente en /admin/usuarios después.
 *
 * Lo que NO hace este piloto:
 *   - No envía email de invite (los IdPs gestionan el alta de credenciales en
 *     su lado; el usuario llegará a Didacta vía SSO/SAML cuando esté listo).
 *   - No persiste `externalId` (requeriría migración Prisma).
 *   - No soporta /Me, /Bulk, /Groups.
 *   - No implementa filter complejo (sólo `userName eq "..."`).
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { scimToUserCreate, userToScim, type ScimMappedUser } from './scim.mapper';
import {
  SCIM_SCHEMAS,
  makeScimError,
  type ScimError,
  type ScimListResponse,
  type ScimUser,
} from './scim.types';
import type { ScimCreateUserDto, ScimListQueryDto, ScimPatchDto, ScimPatchOp } from './scim.dto';

/**
 * Forma del resultado de list, lista compatible con SCIM ListResponse + total.
 */
export interface ScimListUsersResult {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  resources: ScimUser[];
}

@Injectable()
export class ScimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /**
   * GET /scim/v2/Users — paginado SCIM (1-based startIndex).
   *
   * Soporte de filtro: solamente `userName eq "valor"`. Cualquier otro filter
   * → 400 SCIM con scimType=invalidFilter. Esto cubre el 99% de uso real
   * (los IdPs filtran por userName para chequear si el user ya existe antes
   * de crear).
   */
  async listUsers(tenantId: string, query: ScimListQueryDto): Promise<ScimListUsersResult> {
    const baseWhere: Prisma.UserWhereInput = { tenantId, deletedAt: null };

    if (query.filter) {
      const parsed = parseUserNameEqFilter(query.filter);
      if (!parsed) {
        throw new BadRequestException(
          makeScimError(
            400,
            `Unsupported filter "${query.filter}". This server only supports userName eq "value".`,
            'invalidFilter',
          ),
        );
      }
      baseWhere.email = { equals: parsed.toLowerCase(), mode: 'insensitive' };
    }

    // SCIM startIndex es 1-based. Lo convertimos a Prisma skip 0-based.
    const skip = Math.max(0, query.startIndex - 1);
    const take = query.count;

    const [totalResults, rows] = await Promise.all([
      this.prisma.user.count({ where: baseWhere }),
      this.prisma.user.findMany({
        where: baseWhere,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
    ]);

    return {
      totalResults,
      startIndex: query.startIndex,
      itemsPerPage: rows.length,
      resources: rows.map((u) => userToScim(this.toMapped(u))),
    };
  }

  // ---------------------------------------------------------------------------
  // Get one
  // ---------------------------------------------------------------------------

  async getUser(tenantId: string, userId: string): Promise<ScimUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException(makeScimError(404, `User ${userId} not found in this tenant.`));
    }
    return userToScim(this.toMapped(user));
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * POST /scim/v2/Users — crea un user nuevo o devuelve 409 si el userName ya
   * existe. Idempotencia: el IdP que reenvíe el mismo POST NO produce
   * duplicados; recibe 409 con scimType='uniqueness' y reentra a su flujo
   * normal de "user ya existe".
   */
  async createUser(
    tenantId: string,
    dto: ScimCreateUserDto,
    actor: { actorId?: string | null } = {},
  ): Promise<ScimUser> {
    const input = scimToUserCreate(dto);

    if (!input.email) {
      throw new BadRequestException(
        makeScimError(
          400,
          'userName must be a valid email address (or include emails[primary] with a valid value).',
          'invalidValue',
        ),
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: input.email } },
    });
    if (existing) {
      throw new ConflictException(
        makeScimError(409, `User with userName "${input.email}" already exists.`, 'uniqueness'),
      );
    }

    // Status inicial:
    //   - active=true → PENDING (el usuario aún no se ha logueado/configurado
    //     password). Si el tenant tiene SAML, llegará por SSO y queda ACTIVE
    //     en el primer login. Si no, el admin tendrá que reenviar invite.
    //   - active=false → DEACTIVATED desde el principio (raro pero soportado).
    const status = input.active ? 'PENDING' : 'DEACTIVATED';

    const created = await this.prisma.user.create({
      data: {
        tenantId,
        email: input.email,
        name: input.name,
        status,
        ...(input.locale ? { locale: input.locale } : {}),
      },
    });

    await this.auditLog.record({
      tenantId,
      actorId: actor.actorId ?? null,
      action: 'scim.user.created',
      resourceType: 'user',
      resourceId: created.id,
      metadata: {
        email: created.email,
        viaScim: true,
        active: input.active,
      },
    });

    return userToScim(this.toMapped(created));
  }

  // ---------------------------------------------------------------------------
  // Patch
  // ---------------------------------------------------------------------------

  /**
   * PATCH /scim/v2/Users/:id — aplica un set de operaciones SCIM al user.
   *
   * Operaciones soportadas (todas con `op: 'replace'`):
   *   - path='active'           → toggle activación (ACTIVE/PENDING ↔ DEACTIVATED).
   *   - path='name.givenName' / 'name.familyName' → renombrar.
   *   - path='locale'           → cambiar locale.
   *   - path='userName'         → cambiar email (rechazamos si ya existe en el tenant).
   *   - sin path, value=objeto  → merge parcial (mismas keys que arriba).
   *
   * Cualquier path desconocido → 400 SCIM scimType=invalidPath.
   * `add` y `remove` con paths simples se procesan como replace para los
   * campos soportados; `remove` sobre `name` resetea givenName/familyName.
   */
  async patchUser(
    tenantId: string,
    userId: string,
    dto: ScimPatchDto,
    actor: { actorId?: string | null } = {},
  ): Promise<ScimUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException(makeScimError(404, `User ${userId} not found in this tenant.`));
    }

    let nextEmail: string | null = null;
    let nextName: string | null | undefined = undefined; // undefined = no tocar
    let nextLocale: string | null | undefined = undefined;
    let nextActive: boolean | undefined = undefined;

    for (const op of dto.Operations) {
      this.applyPatchOp(op, {
        setEmail: (v) => {
          nextEmail = v;
        },
        setName: (v) => {
          nextName = v;
        },
        setLocale: (v) => {
          nextLocale = v;
        },
        setActive: (v) => {
          nextActive = v;
        },
        currentName: user.name,
      });
    }

    // Validar email único si lo cambiamos.
    if (nextEmail && nextEmail !== user.email) {
      const dup = await this.prisma.user.findUnique({
        where: { tenantId_email: { tenantId, email: nextEmail } },
      });
      if (dup && dup.id !== userId) {
        throw new ConflictException(
          makeScimError(409, `userName "${nextEmail}" already in use.`, 'uniqueness'),
        );
      }
    }

    // Map active → status. Si el user ya estaba SUSPENDED (sanción manual del
    // admin), un PATCH active=true NO lo des-suspende — mejor no pisar acción
    // de admin con un PATCH SCIM. Para reactivarlo, el admin debe pasar por
    // /admin/usuarios. active=false sí marca DEACTIVATED siempre (los IdPs
    // necesitan poder cortar acceso desde su lado).
    let nextStatus: typeof user.status | undefined = undefined;
    if (nextActive === true) {
      if (user.status === 'DEACTIVATED' || user.status === 'PENDING') {
        nextStatus = 'ACTIVE';
      }
      // SUSPENDED se respeta: no auto-rehabilitamos vía SCIM.
    } else if (nextActive === false) {
      nextStatus = 'DEACTIVATED';
    }

    const data: Prisma.UserUpdateInput = {};
    if (nextEmail) data.email = nextEmail;
    if (nextName !== undefined) data.name = nextName;
    if (nextLocale !== undefined) data.locale = nextLocale ?? 'es-ES';
    if (nextStatus) data.status = nextStatus;

    if (Object.keys(data).length === 0) {
      // No-op: devolvemos el estado actual sin escribir DB ni audit log.
      return userToScim(this.toMapped(user));
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data,
      });
      // Si el user fue desactivado, invalidamos sus sesiones activas para que
      // el corte de acceso desde el IdP sea inmediato.
      if (nextStatus === 'DEACTIVATED') {
        await tx.session.deleteMany({
          where: { userId, expiresAt: { gt: new Date() } },
        });
      }
      return u;
    });

    await this.auditLog.record({
      tenantId,
      actorId: actor.actorId ?? null,
      action: 'scim.user.updated',
      resourceType: 'user',
      resourceId: userId,
      metadata: {
        viaScim: true,
        changedFields: Object.keys(data),
        nextStatus: nextStatus ?? null,
      },
    });

    return userToScim(this.toMapped(updated));
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  /**
   * DELETE /scim/v2/Users/:id — soft delete con `deletedAt`. Compatible con la
   * convención del resto del API (admin-users también hace soft delete).
   *
   * Los IdPs típicamente NO usan DELETE — usan PATCH active=false. Pero
   * exponer DELETE permite borrado real cuando el admin lo requiere por GDPR.
   */
  async deleteUser(
    tenantId: string,
    userId: string,
    actor: { actorId?: string | null } = {},
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException(makeScimError(404, `User ${userId} not found in this tenant.`));
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date(), status: 'DEACTIVATED' },
      });
      await tx.session.deleteMany({ where: { userId } });
    });

    await this.auditLog.record({
      tenantId,
      actorId: actor.actorId ?? null,
      action: 'scim.user.deleted',
      resourceType: 'user',
      resourceId: userId,
      metadata: { viaScim: true, email: user.email },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Aplica una sola operación SCIM a los acumuladores. Diseñado para ser puro
   * sobre los setters — facilita testearlo en aislamiento.
   */
  private applyPatchOp(
    op: ScimPatchOp,
    sinks: {
      setEmail: (v: string) => void;
      setName: (v: string | null) => void;
      setLocale: (v: string | null) => void;
      setActive: (v: boolean) => void;
      currentName: string | null;
    },
  ): void {
    if (op.op !== 'replace' && op.op !== 'add' && op.op !== 'remove') {
      throw new BadRequestException(
        makeScimError(400, `Unsupported op "${op.op}".`, 'invalidSyntax'),
      );
    }

    // Caso: sin path → value debe ser objeto con keys soportadas.
    if (!op.path) {
      if (op.op === 'remove') {
        throw new BadRequestException(
          makeScimError(400, 'remove without path is not supported.', 'noTarget'),
        );
      }
      if (typeof op.value !== 'object' || op.value === null || Array.isArray(op.value)) {
        throw new BadRequestException(
          makeScimError(400, 'replace without path requires an object value.', 'invalidSyntax'),
        );
      }
      const v = op.value as Record<string, unknown>;
      if (typeof v['active'] === 'boolean') sinks.setActive(v['active'] as boolean);
      if (typeof v['userName'] === 'string')
        sinks.setEmail((v['userName'] as string).toLowerCase());
      if (typeof v['locale'] === 'string') sinks.setLocale(v['locale'] as string);
      if (v['name'] && typeof v['name'] === 'object' && !Array.isArray(v['name'])) {
        const n = v['name'] as Record<string, unknown>;
        const given = typeof n['givenName'] === 'string' ? n['givenName'] : null;
        const family = typeof n['familyName'] === 'string' ? n['familyName'] : null;
        sinks.setName(joinName(given, family));
      } else if (typeof v['displayName'] === 'string') {
        sinks.setName(v['displayName'] as string);
      }
      return;
    }

    const path = op.path;

    if (path === 'active') {
      if (op.op === 'remove') {
        sinks.setActive(false);
        return;
      }
      if (typeof op.value !== 'boolean') {
        throw new BadRequestException(
          makeScimError(400, '"active" must be a boolean.', 'invalidValue'),
        );
      }
      sinks.setActive(op.value);
      return;
    }

    if (path === 'userName') {
      if (op.op === 'remove') {
        throw new BadRequestException(
          makeScimError(400, 'userName is required and cannot be removed.', 'mutability'),
        );
      }
      if (typeof op.value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(op.value.trim())) {
        throw new BadRequestException(
          makeScimError(400, 'userName must be a valid email.', 'invalidValue'),
        );
      }
      sinks.setEmail(op.value.trim().toLowerCase());
      return;
    }

    if (path === 'locale') {
      if (op.op === 'remove') {
        sinks.setLocale(null);
        return;
      }
      if (typeof op.value !== 'string') {
        throw new BadRequestException(
          makeScimError(400, '"locale" must be a string.', 'invalidValue'),
        );
      }
      sinks.setLocale(op.value);
      return;
    }

    if (path === 'displayName') {
      if (op.op === 'remove') {
        sinks.setName(null);
        return;
      }
      if (typeof op.value !== 'string') {
        throw new BadRequestException(
          makeScimError(400, '"displayName" must be a string.', 'invalidValue'),
        );
      }
      sinks.setName(op.value);
      return;
    }

    if (path === 'name.givenName' || path === 'name.familyName') {
      // Lo manejamos parcialmente: si setean uno, mantenemos el otro a partir
      // del nombre actual cuando sea posible.
      if (op.op !== 'remove' && typeof op.value !== 'string') {
        throw new BadRequestException(
          makeScimError(400, `${path} must be a string.`, 'invalidValue'),
        );
      }
      const cur = splitName(sinks.currentName);
      const value = op.op === 'remove' ? '' : (op.value as string);
      if (path === 'name.givenName') {
        sinks.setName(joinName(value || null, cur.family));
      } else {
        sinks.setName(joinName(cur.given, value || null));
      }
      return;
    }

    throw new BadRequestException(makeScimError(400, `Unsupported path "${path}".`, 'invalidPath'));
  }

  private toMapped(u: {
    id: string;
    email: string;
    name: string | null;
    status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
    locale: string;
    createdAt: Date;
    updatedAt: Date;
  }): ScimMappedUser {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      locale: u.locale,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers libres
// -----------------------------------------------------------------------------

/**
 * Parsea filtros SCIM mínimos del estilo `userName eq "valor"`. Devuelve el
 * valor del email o null si el filtro no es soportado.
 */
function parseUserNameEqFilter(filter: string): string | null {
  // Aceptamos espacios variables y comillas dobles. Case-insensitive en `eq`.
  const m = /^\s*userName\s+eq\s+"([^"]+)"\s*$/i.exec(filter);
  if (!m) return null;
  const v = m[1]!.trim();
  return v.length > 0 ? v : null;
}

function splitName(name: string | null): { given: string | null; family: string | null } {
  if (!name || !name.trim()) return { given: null, family: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { given: parts[0]!, family: null };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1]! };
}

function joinName(given: string | null, family: string | null): string | null {
  const g = given?.trim();
  const f = family?.trim();
  if (g && f) return `${g} ${f}`;
  if (g) return g;
  if (f) return f;
  return null;
}

/** Helper para construir un ListResponse SCIM completo a partir del result. */
export function buildListResponse<T extends ScimUser>(result: {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  resources: T[];
}): ScimListResponse<T> {
  return {
    schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
    totalResults: result.totalResults,
    startIndex: result.startIndex,
    itemsPerPage: result.itemsPerPage,
    Resources: result.resources,
  };
}

/** Re-export utilitario para que el controller pueda construir errores. */
export type { ScimError };
