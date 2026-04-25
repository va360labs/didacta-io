import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PUBLIC_ROUTE_KEY, REQUIRES_MFA_KEY } from './jwt-auth.guard';
import type { SessionClaims } from './token.service';

export const Public = () => SetMetadata(PUBLIC_ROUTE_KEY, true);
export const RequiresMfa = () => SetMetadata(REQUIRES_MFA_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionClaims | undefined => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    return request.user;
  },
);
