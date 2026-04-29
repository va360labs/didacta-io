import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MFA_EXEMPT_KEY, PUBLIC_ROUTE_KEY, REQUIRES_MFA_KEY } from './jwt-auth.guard';
import type { SessionClaims } from './token.service';

export const Public = () => SetMetadata(PUBLIC_ROUTE_KEY, true);
export const RequiresMfa = () => SetMetadata(REQUIRES_MFA_KEY, true);

/**
 * Marca una ruta como exenta del enforcement automático de MFA para roles
 * admin. Sólo debería aplicarse a endpoints estrictamente necesarios para
 * que un admin sin mfaVerified pueda completar el setup/verify (los del
 * propio flujo MFA + perfil mínimo). NO usar en ningún endpoint con
 * efectos de negocio.
 */
export const MfaExempt = () => SetMetadata(MFA_EXEMPT_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionClaims | undefined => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    return request.user;
  },
);
