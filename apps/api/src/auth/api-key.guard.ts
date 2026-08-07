/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ApiKeyService } from './api-key.service';
import { PUBLIC_ROUTE_KEY } from './jwt-auth.guard';
import { TokenService } from './token.service';

/**
 * Guard combinado: acepta Bearer JWT o `Authorization: ApiKey <token>`.
 * Si el token de API key es válido, popula request.user con un SessionClaims
 * sintético que tiene mfaVerified=true y los scopes/roles equivalentes.
 */
@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly apiKeys: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.headers['authorization'];
    if (!auth || typeof auth !== 'string') {
      throw new UnauthorizedException({
        message: 'Falta header Authorization',
        code: 'AUTH_MISSING_AUTHORIZATION_HEADER',
      });
    }

    if (auth.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).trim();
      try {
        req.user = await this.tokens.verifyAccess(token);
        return true;
      } catch {
        throw new UnauthorizedException({
          message: 'Bearer token inválido o expirado',
          code: 'AUTH_BEARER_TOKEN_INVALID',
        });
      }
    }

    if (auth.startsWith('ApiKey ')) {
      const token = auth.slice('ApiKey '.length).trim();
      const key = await this.apiKeys.findValidByToken(token);
      if (!key) {
        throw new UnauthorizedException({
          message: 'API key inválida, expirada o revocada',
          code: 'AUTH_API_KEY_INVALID',
        });
      }
      req.user = {
        sub: key.userId,
        tenantId: key.tenantId,
        roles: key.scopes,
        mfaVerified: true,
      };
      return true;
    }

    throw new UnauthorizedException({
      message: 'Esquema de Authorization no soportado',
      code: 'AUTH_UNSUPPORTED_AUTH_SCHEME',
    });
  }
}
