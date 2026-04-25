import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TokenService, type SessionClaims } from './token.service';

export const REQUIRES_MFA_KEY = 'requiresMfa';
export const PUBLIC_ROUTE_KEY = 'isPublic';

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
      throw new UnauthorizedException('Falta header Authorization Bearer');
    }
    const token = authHeader.slice('Bearer '.length).trim();

    try {
      const claims = await this.tokens.verifyAccess(token);
      request.user = claims;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const requiresMfa = this.reflector.getAllAndOverride<boolean>(REQUIRES_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiresMfa && !request.user.mfaVerified) {
      throw new UnauthorizedException('Esta acción requiere MFA verificado');
    }

    return true;
  }
}
