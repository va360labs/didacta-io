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
import { API_SCOPES_KEY } from './api-scope.decorator';
import type { SessionClaims } from './token.service';

/**
 * Verifica que el llamante tenga TODOS los scopes declarados con
 * `@RequireApiScopes(...)`. Debe ejecutarse DESPUÉS de `JwtOrApiKeyGuard`:
 * ese guard popula `request.user`, y para las API keys mapea sus `scopes`
 * dentro de `roles`. Así, una key con scope `enrollments:write` pasa este
 * guard, pero un JWT de admin (cuyos `roles` son nombres de rol, no scopes)
 * NO — efectivamente restringiendo el endpoint a API keys con el scope exacto.
 */
@Injectable()
export class ApiScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(API_SCOPES_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];
    if (required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const user = req.user as SessionClaims | undefined;
    if (!user) throw new UnauthorizedException();

    const granted = new Set(user.roles ?? []);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenException({
        message: `La API key no tiene el/los scope(s) requerido(s): ${missing.join(', ')}`,
        code: 'AUTH_API_KEY_MISSING_SCOPES',
      });
    }
    return true;
  }
}
