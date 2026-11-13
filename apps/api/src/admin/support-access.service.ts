/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { type AdminActor, auditActorId, auditActorTrace } from '../auth/admin-actor';
import { AccountStateService } from '../auth/account-state.service';
import type { ClientContext } from '../auth/client-context';
import { SessionRegistryService } from '../auth/session-registry.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SUPPORT_ACCESS_CODES,
  SUPPORT_USER_EMAIL,
  SUPPORT_USER_NAME,
  SUPPORT_USER_ROLE,
  clampTtlSeconds,
  generateSupportToken,
  hasSupportTokenPrefix,
  hashSupportToken,
  verifyGrant,
} from '../tenancy/support-access';
import { runGlobalWithoutTenant } from '../tenancy/tenant-context.storage';

const NO_CTX: ClientContext = { ip: null, userAgent: null };

/** Lo que se devuelve al emitir. El `token` se enseña UNA sola vez. */
export interface IssuedSupportAccess {
  id: string;
  /** Token en claro. No se persiste en ninguna parte: solo su SHA-256. */
  token: string;
  reason: string;
  expiresAt: string;
  /** Enlace listo para abrir. El canje ocurre en el navegador, en el aula del cliente. */
  redeemUrl: string;
}

/** Estado de una concesión, para la ficha del tenant y para el banner del aula. */
export interface SupportAccessSummary {
  id: string;
  reason: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  issuedByKind: string;
}

/** Lo que recibe quien canjea: una sesión de duración limitada y su porqué. */
export interface RedeemedSupportAccess {
  accessToken: string;
  expiresIn: number;
  expiresAt: string;
  reason: string;
  grantId: string;
  user: {
    id: string;
    email: string;
    name: string;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
  };
}

/**
 * Acceso de soporte de vida corta (U8).
 *
 * ## El recorrido entero, en una frase por paso
 *
 *  1. Un operador —persona con `super_admin`, o el plano de control con su
 *     credencial— pide acceso al tenant X **escribiendo un motivo**.
 *  2. Sale un token de un solo uso con caducidad ≤ 15 min. Se enseña una vez.
 *  3. Quien lo tenga abre el enlace en el aula del cliente y lo canjea.
 *  4. El canje abre sesión **como un usuario de soporte propio del tenant**,
 *     nunca como una persona real, y sella la concesión: ya no se puede volver
 *     a usar.
 *  5. El aula pinta un banner que no se puede cerrar mientras dure.
 *  6. Al caducar la ventana —o al revocarla— la sesión muere.
 *
 * Las dos puntas quedan escritas en el audit log **del tenant**: quién abrió el
 * acceso, con qué motivo, y cuándo se usó. El cliente puede leerlo sin pedirle
 * permiso a nadie, que es la diferencia entre un acceso de soporte y una puerta
 * trasera.
 *
 * ## Por qué el usuario de soporte es un usuario de verdad
 *
 * Porque el audit log tiene que poder decir la verdad. Si soporte entrara con
 * la identidad del tenant_admin del cliente, cada fila que dejara diría que la
 * hizo esa persona, y el registro dejaría de valer como prueba de nada — ni
 * para el cliente, ni para nosotros. El usuario de soporte es visible en la
 * lista de miembros a propósito.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly sessions: SessionRegistryService,
    private readonly accountState: AccountStateService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Emite una concesión para el tenant indicado.
   *
   * No hay límite de concesiones vivas a la vez y es deliberado: cada una tiene
   * su propio motivo y su propio rastro, y dos personas de soporte mirando el
   * mismo incidente no deberían pisarse. Lo que está acotado es la ventana.
   */
  async grant(
    actor: AdminActor,
    tenantId: string,
    input: { reason: string; ttlSeconds?: number },
    webBaseUrl: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<IssuedSupportAccess> {
    return runGlobalWithoutTenant(async () => {
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!tenant) {
        throw new NotFoundException({
          message: 'Tenant no encontrado.',
          code: 'ADMIN_TENANT_NOT_FOUND',
        });
      }
      // Un acceso de soporte a un tenant suspendido no serviría de nada: la
      // sesión que abriría el canje se corta sola en el interceptor de estado.
      if (tenant.status !== 'ACTIVE') {
        throw new ConflictException({
          message: 'El tenant no está activo: no admite sesiones, tampoco las de soporte.',
          code: SUPPORT_ACCESS_CODES.TENANT_UNAVAILABLE,
        });
      }

      const reason = input.reason.trim();
      const ttlSeconds = clampTtlSeconds(input.ttlSeconds);
      const token = generateSupportToken();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

      const created = await this.prisma.supportAccessGrant.create({
        data: {
          tenantId,
          tokenHash: hashSupportToken(token),
          reason,
          issuedByKind: actor.kind,
          issuedById: auditActorId(actor),
          expiresAt,
        },
        select: { id: true },
      });

      await this.auditLog.record({
        tenantId,
        actorId: auditActorId(actor),
        action: 'admin.tenant.support_access_granted',
        resourceType: 'support_access_grant',
        resourceId: created.id,
        metadata: {
          reason,
          expiresAt: expiresAt.toISOString(),
          ttlSeconds,
          ...auditActorTrace(actor),
        },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      this.logger.warn(
        { tenantId, grantId: created.id, actorKind: actor.kind },
        `[support-access] concesión emitida, caduca ${expiresAt.toISOString()}`,
      );

      return {
        id: created.id,
        token,
        reason,
        expiresAt: expiresAt.toISOString(),
        redeemUrl: `${webBaseUrl}/support/access?token=${encodeURIComponent(token)}`,
      };
    });
  }

  /**
   * Corta una concesión antes de tiempo y, si ya se había canjeado, cierra la
   * sesión que abrió. Sin esto la única forma de terminar un acceso sería
   * esperar, y «esperar» no es un botón que un operador pueda pulsar cuando se
   * da cuenta de que se ha equivocado de tenant.
   */
  async revoke(
    actor: AdminActor,
    tenantId: string,
    grantId: string,
    ctx: ClientContext = NO_CTX,
  ): Promise<{ revoked: boolean; sessionClosed: boolean }> {
    return runGlobalWithoutTenant(async () => {
      const grant = await this.prisma.supportAccessGrant.findFirst({
        where: { id: grantId, tenantId },
      });
      if (!grant) {
        throw new NotFoundException({
          message: 'Esa concesión de acceso de soporte no existe en este tenant.',
          code: SUPPORT_ACCESS_CODES.NOT_FOUND,
        });
      }
      if (grant.revokedAt) return { revoked: false, sessionClosed: false };

      const now = new Date();
      await this.prisma.supportAccessGrant.update({
        where: { id: grantId },
        data: { revokedAt: now },
      });

      let sessionClosed = false;
      if (grant.sessionId) {
        const { count } = await this.prisma.session.updateMany({
          where: { id: grant.sessionId, revokedAt: null },
          data: { revokedAt: now },
        });
        sessionClosed = count > 0;
        // Sin esto, el corte tardaría hasta 30 s (la caché de AccountStateService).
        this.accountState.invalidateSession(grant.sessionId);
      }

      await this.auditLog.record({
        tenantId,
        actorId: auditActorId(actor),
        action: 'admin.tenant.support_access_revoked',
        resourceType: 'support_access_grant',
        resourceId: grantId,
        metadata: { sessionClosed, reason: grant.reason, ...auditActorTrace(actor) },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      return { revoked: true, sessionClosed };
    });
  }

  /** Concesiones que siguen contando: vivas o canjeadas y aún dentro de su ventana. */
  async listActive(tenantId: string): Promise<SupportAccessSummary[]> {
    return runGlobalWithoutTenant(async () => {
      const rows = await this.prisma.supportAccessGrant.findMany({
        where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        expiresAt: r.expiresAt.toISOString(),
        redeemedAt: r.redeemedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        issuedByKind: r.issuedByKind,
      }));
    });
  }

  /**
   * Canjea el token y devuelve una sesión de soporte.
   *
   * Es público por necesidad —quien canjea todavía no tiene sesión— y por eso
   * cada rechazo devuelve un código distinto pero ningún dato del tenant: un
   * token que no vale no debe servir para averiguar si existe.
   */
  async redeem(plainToken: string, ctx: ClientContext = NO_CTX): Promise<RedeemedSupportAccess> {
    if (!plainToken || !hasSupportTokenPrefix(plainToken)) {
      throw new BadRequestException({
        message: 'Token de acceso de soporte no válido.',
        code: SUPPORT_ACCESS_CODES.INVALID,
      });
    }

    return runGlobalWithoutTenant(async () => {
      const grant = await this.prisma.supportAccessGrant.findUnique({
        where: { tokenHash: hashSupportToken(plainToken) },
      });
      if (!grant) {
        throw new BadRequestException({
          message: 'Token de acceso de soporte no válido.',
          code: SUPPORT_ACCESS_CODES.INVALID,
        });
      }

      const verdict = verifyGrant(grant);
      if (!verdict.ok) {
        // 410 y no 400: el token existió y era bueno; lo que pasa es que ya no
        // sirve. Quien lo abre necesita distinguir «me lo inventé» de «llego
        // tarde», porque la salida es distinta (pedir otro).
        throw new GoneException({
          message: MESSAGES[verdict.code] ?? 'Este acceso de soporte ya no es válido.',
          code: verdict.code,
        });
      }

      const tenant = await this.prisma.tenant.findFirst({
        where: { id: grant.tenantId, deletedAt: null },
        select: { id: true, slug: true, status: true },
      });
      if (!tenant || tenant.status !== 'ACTIVE') {
        throw new ForbiddenException({
          message: 'El espacio de este acceso no admite sesiones ahora mismo.',
          code: SUPPORT_ACCESS_CODES.TENANT_UNAVAILABLE,
        });
      }

      const supportUser = await this.ensureSupportUser(tenant.id);
      const ttlSeconds = Math.max(60, Math.floor((grant.expiresAt.getTime() - Date.now()) / 1000));

      const issued = await this.sessions.issueSupportAccess(
        {
          sub: supportUser.id,
          tenantId: tenant.id,
          roles: [SUPPORT_USER_ROLE],
          // La ventana ES el segundo factor: un secreto de un solo uso, de
          // minutos, emitido por alguien que ya se autenticó contra el plano de
          // control o contra esta instalación. Sin esto, una instalación con
          // `DIDACTA_REQUIRE_MFA_ADMIN=true` dejaría la sesión de soporte
          // autenticada pero incapaz de hacer nada.
          mfaVerified: true,
          sup: grant.id,
        },
        ttlSeconds,
        ctx,
      );

      // Un solo uso: se sella ANTES de devolver nada. Si dos canjes corren a la
      // vez, el `where` con `redeemedAt: null` hace que solo uno gane.
      const { count } = await this.prisma.supportAccessGrant.updateMany({
        where: { id: grant.id, redeemedAt: null, revokedAt: null },
        data: { redeemedAt: new Date(), sessionId: issued.sid },
      });
      if (count === 0) {
        // Otro canje ganó la carrera entre el verify y el sello. La sesión que
        // acabamos de abrir no debe sobrevivir a eso.
        await this.prisma.session.updateMany({
          where: { id: issued.sid },
          data: { revokedAt: new Date() },
        });
        this.accountState.invalidateSession(issued.sid);
        throw new GoneException({
          message: MESSAGES[SUPPORT_ACCESS_CODES.ALREADY_REDEEMED]!,
          code: SUPPORT_ACCESS_CODES.ALREADY_REDEEMED,
        });
      }

      await this.auditLog.record({
        tenantId: tenant.id,
        actorId: supportUser.id,
        action: 'admin.tenant.support_access_redeemed',
        resourceType: 'support_access_grant',
        resourceId: grant.id,
        metadata: {
          reason: grant.reason,
          issuedByKind: grant.issuedByKind,
          issuedById: grant.issuedById,
          expiresAt: grant.expiresAt.toISOString(),
        },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });

      this.logger.warn(
        { tenantId: tenant.id, grantId: grant.id, sessionId: issued.sid },
        '[support-access] concesión canjeada',
      );

      return {
        accessToken: issued.accessToken,
        expiresIn: issued.expiresIn,
        expiresAt: issued.expiresAt.toISOString(),
        reason: grant.reason,
        grantId: grant.id,
        user: {
          id: supportUser.id,
          email: SUPPORT_USER_EMAIL,
          name: SUPPORT_USER_NAME,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          roles: [SUPPORT_USER_ROLE],
        },
      };
    });
  }

  /**
   * Lo que el aula necesita para pintar el banner: el motivo y hasta cuándo.
   *
   * Devuelve `null` si la concesión ya no está viva, de modo que un token de
   * soporte que sobreviviera por caché no pintaría un banner mentiroso.
   */
  async describeActive(
    grantId: string,
  ): Promise<{ grantId: string; reason: string; expiresAt: string } | null> {
    return runGlobalWithoutTenant(async () => {
      const grant = await this.prisma.supportAccessGrant.findFirst({
        where: { id: grantId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, reason: true, expiresAt: true },
      });
      if (!grant) return null;
      return {
        grantId: grant.id,
        reason: grant.reason,
        expiresAt: grant.expiresAt.toISOString(),
      };
    });
  }

  /**
   * Devuelve el usuario de soporte del tenant, creándolo la primera vez.
   *
   * Nace SIN `passwordHash` y sin poder pedir uno: no hay forma de entrar con
   * él que no sea canjeando una concesión viva. El onboarding se da por hecho
   * para que el asistente de bienvenida no se le cruce a soporte en mitad de un
   * incidente.
   */
  private async ensureSupportUser(tenantId: string): Promise<{ id: string }> {
    const existing = await this.prisma.user.findFirst({
      where: { tenantId, email: SUPPORT_USER_EMAIL },
      select: { id: true, status: true, deletedAt: true },
    });
    if (existing) {
      if (existing.status !== 'ACTIVE' || existing.deletedAt) {
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', deletedAt: null },
        });
        this.accountState.invalidateUser(existing.id);
      }
      return { id: existing.id };
    }

    const role = await this.prisma.role.findUnique({ where: { name: SUPPORT_USER_ROLE } });
    if (!role) {
      throw new BadRequestException({
        message: `Rol ${SUPPORT_USER_ROLE} no existe en seed.`,
        code: 'ADMIN_TENANT_ADMIN_ROLE_MISSING',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          email: SUPPORT_USER_EMAIL,
          name: SUPPORT_USER_NAME,
          status: 'ACTIVE',
          emailVerified: true,
          onboardingCompletedAt: new Date(),
        },
        select: { id: true },
      });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      return user;
    });
  }
}

/** Mensajes de los rechazos del canje. Van al navegador de quien abre el enlace. */
const MESSAGES: Record<string, string> = {
  [SUPPORT_ACCESS_CODES.EXPIRED]:
    'Este acceso de soporte ha caducado. Pide uno nuevo desde el panel.',
  [SUPPORT_ACCESS_CODES.ALREADY_REDEEMED]:
    'Este acceso de soporte ya se usó. Es de un solo uso: pide uno nuevo.',
  [SUPPORT_ACCESS_CODES.REVOKED]: 'Un operador ha cerrado este acceso de soporte.',
};
