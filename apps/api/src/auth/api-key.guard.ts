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
      throw new UnauthorizedException('Falta header Authorization');
    }

    if (auth.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).trim();
      try {
        req.user = await this.tokens.verifyAccess(token);
        return true;
      } catch {
        throw new UnauthorizedException('Bearer token inválido o expirado');
      }
    }

    if (auth.startsWith('ApiKey ')) {
      const token = auth.slice('ApiKey '.length).trim();
      const key = await this.apiKeys.findValidByToken(token);
      if (!key) {
        throw new UnauthorizedException('API key inválida, expirada o revocada');
      }
      req.user = {
        sub: key.userId,
        tenantId: key.tenantId,
        roles: key.scopes,
        mfaVerified: true,
      };
      return true;
    }

    throw new UnauthorizedException('Esquema de Authorization no soportado');
  }
}
