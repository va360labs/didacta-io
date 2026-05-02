import {
  All,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser } from '../auth/decorators';
import type { SessionClaims } from '../auth/token.service';
import {
  ALLOWED_METHODS,
  ModuleRouterService,
  type AllowedMethod,
  type ModuleRouteRequestContext,
  type ModuleRouteResponse,
} from './module-router.service';

/// Controller wildcard que recibe TODO request bajo `/modules/*` y lo
/// despacha al módulo dinámico correspondiente. Vive fuera del flow
/// estándar de NestJS porque los módulos cargados en runtime no están en
/// el dependency graph; aquí actuamos como adapter manual.
///
/// Auth: este controller NO aplica `JwtAuthGuard` global. Cada module
/// route declara su propia política via `requiresAuth` (TODO en futuro).
/// Por ahora, el `req.user` se popula desde el JWT si viene válido (el
/// `JwtAuthGuard` opcional de Nest ya lo decoró si el header está
/// presente). Implementación: el dispatcher invoca con `user=null` si no
/// hay claims y deja al handler decidir; para MVP esperamos que los
/// módulos validen ellos mismos qué quieren autenticado.
///
/// Una alternativa más segura sería gateado obligatorio super_admin a
/// nivel del marketplace. Lo descartamos porque la promesa de los
/// módulos es servir endpoints que el alumno final pueda llamar — un
/// gate global a super_admin rompería el use case.

@ApiTags('Marketplace · Dispatcher dinámico')
@ApiBearerAuth()
@Controller()
export class ModulesDispatcherController {
  private readonly logger = new Logger(ModulesDispatcherController.name);

  constructor(private readonly router: ModuleRouterService) {}

  /// Atrapa todos los métodos bajo `/modules/*`. NestJS no soporta
  /// wildcard `*` en path con todos los HTTP methods en un decorator
  /// declarativo limpio, así que usamos `@All` y rerouting manual al
  /// router runtime.
  @All('modules/*')
  @ApiOperation({
    summary:
      'Dispatcher de endpoints dinámicos de módulos instalados via marketplace. NO documentado individualmente — depende del módulo.',
  })
  async dispatch(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentUser() user: SessionClaims | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    const method = (req.method ?? '').toUpperCase();
    if (!ALLOWED_METHODS.includes(method as AllowedMethod)) {
      throw new HttpException('Método no soportado por el dispatcher', HttpStatus.METHOD_NOT_ALLOWED);
    }

    // El path llega con el prefijo `/api/v1` aplicado por NestFactory; lo
    // quitamos para que matchee contra `apiNamespace` declarado en el
    // manifest (que vive sin prefijo, ej `/modules/example`).
    const rawUrl = req.url ?? '';
    const pathOnly = rawUrl.split('?')[0] ?? '';
    const stripped = stripGlobalPrefix(pathOnly);

    const matched = this.router.match(method, stripped);
    if (!matched) {
      throw new NotFoundException(`No hay módulo registrado para ${method} ${stripped}`);
    }

    const ctx: ModuleRouteRequestContext = {
      method: method as AllowedMethod,
      path: stripped,
      params: matched.params,
      query: (req.query as Record<string, string | string[]>) ?? {},
      body,
      user: user
        ? { sub: user.sub, tenantId: user.tenantId, roles: user.roles }
        : null,
    };

    let result: ModuleRouteResponse;
    try {
      const ret = await matched.handler(ctx);
      result = ret ?? { status: 204, body: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[mod:${matched.moduleName}] handler lanzó: ${msg}`);
      throw new HttpException(
        { message: `Error en módulo "${matched.moduleName}": ${msg}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const status = result.status ?? (result.body === null || result.body === undefined ? 204 : 200);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
    }
    reply.status(status).send(result.body);
  }
}

/// Quita el global prefix `/api/v1` del path entrante. NestJS lo aplica
/// en `setGlobalPrefix` (ver `main.ts`) pero el path crudo de Fastify aún
/// lo lleva. Conviene mantener el ancla en una sola constante por si el
/// prefix cambia en el futuro.
const GLOBAL_PREFIX = '/api/v1';
function stripGlobalPrefix(path: string): string {
  if (path.startsWith(GLOBAL_PREFIX + '/')) return path.slice(GLOBAL_PREFIX.length);
  if (path === GLOBAL_PREFIX) return '/';
  return path;
}
