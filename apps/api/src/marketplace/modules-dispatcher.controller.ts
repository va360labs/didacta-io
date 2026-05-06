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
import { TokenService, type SessionClaims } from '../auth/token.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import {
  ALLOWED_METHODS,
  ModuleRouterService,
  type AllowedMethod,
  type ModuleRouteRequestContext,
  type ModuleRouteResponse,
} from './module-router.service';
import type { ModuleHttpConfig } from './module-manifest.schema';
import { RateLimitedHttp, RateLimiterService } from './rate-limiter.service';
import { SandboxedDbService } from './sandboxed-db.service';
import { SandboxedHttpService } from './sandboxed-http.service';
import { BlockedSandboxedHttp, type SandboxedHttp } from './sandboxed-http.types';
import { BlockedSandboxedDb, type SandboxedDb } from './sandboxed-db.types';

/// Controller wildcard que recibe TODO request bajo `/modules/*` y lo
/// despacha al módulo dinámico correspondiente. Vive fuera del flow
/// estándar de NestJS porque los módulos cargados en runtime no están en
/// el dependency graph; aquí actuamos como adapter manual.
///
/// Auth (auth opcional, decodificación manual):
/// El dispatcher NO aplica `@UseGuards(JwtAuthGuard)` porque algunos
/// módulos exponen rutas públicas pensadas para alumnos finales (ej.
/// catálogo público de un mod.community). Pero SÍ decodifica el Bearer
/// manualmente — si viene un token válido, popula `user` en el contexto
/// del handler; si no viene o es inválido, `user = null` y cada handler
/// decide qué hacer (devolver 401 si requiere auth, o servir contenido
/// público si no).
///
/// Antes de alpha.48 esta decodificación NO existía: el comentario
/// asumía que Nest tiene un "JwtAuthGuard opcional automático" que NO
/// existe. Resultado: TODOS los módulos third-party que llamaban
/// `requireUser` recibían `user: null` aunque el cliente mandara Bearer
/// válido → 401 sistemático. Bug latente desde alpha.27, descubierto
/// con el primer módulo real (mod.migrator-learndash) que tiró un
/// preflight autenticado desde el wizard.

@ApiTags('Marketplace · Dispatcher dinámico')
@ApiBearerAuth()
@Controller()
export class ModulesDispatcherController {
  private readonly logger = new Logger(ModulesDispatcherController.name);

  constructor(
    private readonly router: ModuleRouterService,
    private readonly tokens: TokenService,
    private readonly httpService: SandboxedHttpService,
    private readonly rateLimiter: RateLimiterService,
    private readonly dbService: SandboxedDbService,
    private readonly tenantContext: TenantContextService,
  ) {}

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
    @Body() body: unknown,
  ): Promise<void> {
    const method = (req.method ?? '').toUpperCase();
    if (!ALLOWED_METHODS.includes(method as AllowedMethod)) {
      throw new HttpException('Método no soportado por el dispatcher', HttpStatus.METHOD_NOT_ALLOWED);
    }

    // Decodificación opcional del Bearer. Si viene válido, populamos `user`;
    // si no viene o es inválido, dejamos `user = undefined` y el handler
    // decide. NO lanzamos 401 acá — algunos módulos exponen rutas públicas.
    const user = await this.resolveOptionalUser(req);

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

    // ctx.http: cliente saliente scoped a este módulo + esta request.
    // - Si el módulo no declara `manifest.http` → BlockedSandboxedHttp
    //   (rechaza toda URL con HTTP_BLOCKED_HOST y mensaje claro al dev).
    // - Si lo declara → RateLimitedHttp(SandboxedHttpService.build(...)) con
    //   allowlist + SSRF guard + rate limit por (módulo, host) + retry/backoff
    //   en 429. El AbortSignal del reply de Fastify se propaga al cliente
    //   para cancelar in-flight si el cliente cierra la conexión.
    const requestSignal = makeRequestAbortSignal(reply);
    const http: SandboxedHttp = this.buildScopedHttp(
      matched.moduleName,
      matched.httpConfig,
      requestSignal,
    );
    // ctx.db: hasta el wiring real (alpha.51 task DB-004) inyectamos un
    // BlockedSandboxedDb si requiresDb=false en manifest. La task DB-004
    // reemplaza esto por SandboxedDbService.build(...) cuando dbEnabled=true.
    const db: SandboxedDb = this.buildScopedDb(
      matched.moduleName,
      matched.dbEnabled,
      matched.tablePrefix,
    );

    const ctx: ModuleRouteRequestContext = {
      method: method as AllowedMethod,
      path: stripped,
      params: matched.params,
      query: (req.query as Record<string, string | string[]>) ?? {},
      body,
      user: user
        ? { sub: user.sub, tenantId: user.tenantId, roles: user.roles }
        : null,
      http,
      db,
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

  /// Construye el cliente HTTP scoped a un módulo + request. Compone
  /// `SandboxedHttpService` (allowlist + SSRF + timeout + body cap) y
  /// `RateLimitedHttp` (token bucket por host + retry/backoff en 429).
  /// `protected` para permitir override en tests del dispatcher.
  protected buildScopedHttp(
    moduleName: string,
    httpConfig: ModuleHttpConfig | null,
    requestSignal: AbortSignal | undefined,
  ): SandboxedHttp {
    if (!httpConfig) return new BlockedSandboxedHttp(moduleName);
    const inner = this.httpService.build(moduleName, httpConfig, requestSignal);
    return new RateLimitedHttp(inner, this.rateLimiter, moduleName, httpConfig.rateLimitPerHost);
  }

  /// Construye el cliente de BD scoped al `tablePrefix` del módulo.
  /// - `dbEnabled=false` → `BlockedSandboxedDb` (rechaza con
  ///    DB_PREFIX_VIOLATION + mensaje explicando cómo activarlo).
  /// - `dbEnabled=true` → `SandboxedDbService.build(...)` con tenantId
  ///    resuelto del request actual (TenantContextService — middleware
  ///    lo pobla con el tenantId del Bearer JWT). Si el request no
  ///    pasó por el middleware o llegó sin Bearer válido, tenantId=null
  ///    y RLS bloqueará tablas tenant-scoped — comportamiento conservador.
  /// `protected` para override en tests.
  protected buildScopedDb(
    moduleName: string,
    dbEnabled: boolean,
    tablePrefix: string,
  ): SandboxedDb {
    if (!dbEnabled) return new BlockedSandboxedDb(moduleName);
    const tenantId = this.tenantContext.get()?.tenantId ?? null;
    return this.dbService.build(moduleName, tablePrefix, tenantId);
  }

  /// Extrae el Bearer del header Authorization y lo verifica con
  /// `TokenService.verifyAccess`. Si todo OK devuelve los claims; si no
  /// hay header, no es Bearer, o el token es inválido/expirado, devuelve
  /// `undefined`. NUNCA lanza — el handler del módulo decide la política
  /// en función de si recibe `user` o `null`.
  private async resolveOptionalUser(
    req: FastifyRequest,
  ): Promise<SessionClaims | undefined> {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return undefined;
    try {
      return await this.tokens.verifyAccess(token);
    } catch {
      return undefined;
    }
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

/// Construye un AbortSignal que se dispara si el cliente cierra la
/// conexión antes de que terminemos de responder. Lo escuchamos en el
/// `reply.raw` (raw HTTP socket de Node). Si `reply.raw.writableEnded`
/// ya es true al recibir el `close`, significa que NOSOTROS terminamos
/// la respuesta — no es cancel del cliente, no abortamos.
///
/// Devuelve `undefined` si el environment no expone `reply.raw` (tests,
/// Fastify mockeado). El cliente HTTP saliente seguirá funcionando, solo
/// que sin propagación de cancelación del frontend.
function makeRequestAbortSignal(reply: FastifyReply): AbortSignal | undefined {
  const raw = (reply as { raw?: { on?: (ev: string, cb: () => void) => unknown; writableEnded?: boolean } }).raw;
  if (!raw || typeof raw.on !== 'function') return undefined;
  const ctrl = new AbortController();
  raw.on('close', () => {
    if (raw.writableEnded === false) {
      ctrl.abort(new Error('Cliente cerró la conexión antes de que terminara la respuesta.'));
    }
  });
  return ctrl.signal;
}
