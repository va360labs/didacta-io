import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TokenService } from '../auth/token.service';
import { TenantContextService } from './tenant-context.service';

/**
 * Resuelve el tenantId del request:
 * 1. Si hay header Authorization Bearer válido → tenantId del JWT.
 * 2. Si la ruta es pública (probes, docs) → no setea contexto.
 *
 * Cualquier query Prisma ejecutada dentro del scope del request
 * leerá el tenantId via TenantContextService.
 *
 * NOTA: la aplicación de SET LOCAL app.current_tenant_id se hace en
 * cada repository/service que use Prisma. Para garantizar enforcement,
 * el patrón recomendado es envolver la lógica con `withTenantContext`
 * del paquete @didacta/database.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly tokens: TokenService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async use(req: FastifyRequest['raw'], _res: FastifyReply['raw'], next: () => void) {
    const traceId = (req.headers['x-trace-id'] as string | undefined) ?? randomUUID();
    const authHeader = req.headers['authorization'];

    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    try {
      const claims = await this.tokens.verifyAccess(token);
      this.tenantContext.run({ tenantId: claims.tenantId, userId: claims.sub, traceId }, () => {
        next();
      });
    } catch {
      next();
    }
  }
}
