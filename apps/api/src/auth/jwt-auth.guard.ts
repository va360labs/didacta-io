/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { isAdminMfaEnforced } from './mfa-config';
import { TokenService, type SessionClaims } from './token.service';

export const REQUIRES_MFA_KEY = 'requiresMfa';
export const MFA_EXEMPT_KEY = 'mfaExempt';
export const PUBLIC_ROUTE_KEY = 'isPublic';

/**
 * Roles a los que el guard exige MFA verificada por defecto. Coincide con
 * `AuthService.shouldRequireMfa` — la política vive en un único lugar
 * conceptual aunque se aplique en dos capas (auth.service marca el token,
 * el guard impone runtime).
 */
const ADMIN_ROLES_REQUIRING_MFA = new Set(['super_admin', 'tenant_admin']);

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionClaims;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        message: 'Falta header Authorization Bearer',
        code: 'AUTH_MISSING_BEARER_HEADER',
      });
    }
    const token = authHeader.slice('Bearer '.length).trim();

    try {
      const claims = await this.tokens.verifyAccess(token);
      request.user = claims;
    } catch {
      throw new UnauthorizedException({
        message: 'Token inválido o expirado',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    const requiresMfa = this.reflector.getAllAndOverride<boolean>(REQUIRES_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiresMfa && !request.user.mfaVerified) {
      throw new UnauthorizedException({
        message: 'Esta acción requiere MFA verificado',
        code: 'AUTH_MFA_VERIFICATION_REQUIRED',
      });
    }

    // Enforcement por rol: cualquier acción de un super_admin / tenant_admin
    // exige token con mfaVerified=true salvo rutas explícitamente exentas
    // (las del propio flujo de MFA + perfil mínimo, marcadas con @MfaExempt()).
    // Esto cierra el bypass de LMS-109 sin tener que decorar uno por uno
    // todos los controllers admin.
    const mfaExempt = this.reflector.getAllAndOverride<boolean>(MFA_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!mfaExempt && this.requiresAdminMfa(request.user) && !request.user.mfaVerified) {
      throw new ForbiddenException({
        message:
          'Tu rol exige MFA verificado para esta acción. Configura o verifica tu segundo factor.',
        code: 'mfa_required',
      });
    }

    return true;
  }

  /// Misma política que `AuthService.shouldRequireMfa`: respeta el
  /// flag global `DIDACTA_REQUIRE_MFA_ADMIN`. Sin él, el guard NO
  /// rechaza a admins por falta de MFA verificada — es responsabilidad
  /// del usuario activar TOTP desde su perfil si lo desea.
  private requiresAdminMfa(user: SessionClaims): boolean {
    if (!isAdminMfaEnforced()) return false;
    return user.roles.some((r) => ADMIN_ROLES_REQUIRING_MFA.has(r));
  }
}
