import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ModuleHttpConfig } from './module-manifest.schema';
import type { SandboxedDb } from './sandboxed-db.types';
import type { SandboxedHttp } from './sandboxed-http.types';

/// Métodos HTTP que un módulo dinámico puede declarar como ruta. Sin
/// HEAD/OPTIONS/CONNECT/TRACE: el dispatcher añade soporte CORS y HEAD
/// automático cuando lo necesite.
export const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/// Shape que un módulo dinámico debe declarar en su `module.exports.routes`.
/// El path es relativo al namespace del módulo: si `apiNamespace='/modules/example'`
/// y `route.path='/hello'`, el endpoint final es `/api/v1/modules/example/hello`.
export interface ModuleRoute {
  method: AllowedMethod;
  /// Path relativo. Acepta `/path/:param` para path params; el dispatcher
  /// los extrae y se los pasa al handler como `params: { param: '...' }`.
  path: string;
  handler: ModuleRouteHandler;
}

/// Handler que recibe un context de request restringido. NO se le pasa el
/// FastifyRequest crudo: el módulo no debe tocar headers de tenant
/// directamente ni el cookie store. La whitelist explícita evita escapes.
export interface ModuleRouteRequestContext {
  method: AllowedMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  /// User claims si el request va autenticado; null si es anónimo. El
  /// gate de auth lo aplica el dispatcher antes de invocar.
  user: { sub: string; tenantId: string; roles: string[] } | null;
  /// Cliente HTTP saliente scoped al módulo. Aplica allowlist por host
  /// (manifest.http.allowedHosts), rate limit (token bucket por host),
  /// SSRF guard (bloquea IPs privadas/loopback), timeout y body cap.
  /// Contrato en `sandboxed-http.types.ts`. Hasta el wiring real (task 5)
  /// es un `NoopSandboxedHttp` que lanza `HTTP_NETWORK` si se invoca.
  http: SandboxedHttp;
  /// Cliente de BD scoped a las tablas del módulo (alpha.51+). SQL guard
  /// bloquea cualquier query que toque tablas fuera del `tablePrefix` del
  /// manifest. Si el módulo no declara `requiresDb: true`, recibe un
  /// `BlockedSandboxedDb` que rechaza con DB_PREFIX_VIOLATION.
  db: SandboxedDb;
}

export type ModuleRouteHandler = (
  req: ModuleRouteRequestContext,
) => Promise<ModuleRouteResponse> | ModuleRouteResponse;

export interface ModuleRouteResponse {
  status?: number; // default 200
  body?: unknown;
  headers?: Record<string, string>;
}

interface RegisteredRoute {
  moduleName: string;
  apiNamespace: string;
  method: AllowedMethod;
  /// Path absoluto (apiNamespace + ruta del módulo) usado para indexado.
  fullPath: string;
  /// Path absoluto convertido a regex para matching con path params.
  pattern: RegExp;
  paramNames: string[];
  handler: ModuleRouteHandler;
  /// Config HTTP del manifest (alpha.49). NULL si el módulo no declara
  /// `http` — el dispatcher inyecta `BlockedSandboxedHttp`. Si declara,
  /// el dispatcher arma `RateLimitedHttp` con allowlist + rate limit.
  httpConfig: ModuleHttpConfig | null;
  /// `manifest.requiresDb` (alpha.51). Si true → SandboxedDbService scoped
  /// al `tablePrefix` del módulo. Si false → BlockedSandboxedDb.
  dbEnabled: boolean;
  /// `manifest.tablePrefix`. Usado para SQL guard en SandboxedDbService.
  tablePrefix: string;
}

export interface RegisterModuleOptions {
  /// Bloque `http` del manifest del módulo (alpha.49). Si está, el
  /// dispatcher cablea un cliente HTTP saliente con allowlist + rate
  /// limit + SSRF guard. Si es null/undefined, el módulo recibe un
  /// `BlockedSandboxedHttp` que rechaza toda URL.
  httpConfig?: ModuleHttpConfig | null;
  /// `manifest.requiresDb` (alpha.51). Si true, el dispatcher cablea un
  /// `SandboxedDbService` scoped al `tablePrefix` del manifest. Si false
  /// o undefined, el módulo recibe un `BlockedSandboxedDb` que rechaza
  /// con DB_PREFIX_VIOLATION explicando cómo activarlo.
  dbEnabled?: boolean;
  /// `manifest.tablePrefix` (siempre presente — required en el manifest).
  /// Necesario aquí para que el dispatcher arme el SandboxedDbService
  /// scoped sin volver al row de installed_module por request.
  tablePrefix?: string;
}

/// Registro runtime de routes expuestas por módulos dinámicos. Usado por
/// `MarketplaceDispatcherController` para resolver requests entrantes a
/// `/api/v1/modules/<slug>/*`.
///
/// Los routes son **per-module** — al desinstalar un módulo se borran
/// todos los suyos. Sin colisiones entre módulos (los namespaces son
/// distintos por construcción del manifest, ADR-008).
@Injectable()
export class ModuleRouterService {
  private readonly logger = new Logger(ModuleRouterService.name);
  private readonly routesByModule = new Map<string, RegisteredRoute[]>();

  /// Registra todas las routes de un módulo. Si el módulo ya tenía routes
  /// (caso upgrade in-place), las anteriores se borran ANTES de registrar
  /// las nuevas — evita rutas zombie de versiones previas.
  registerModule(
    moduleName: string,
    apiNamespace: string,
    routes: ModuleRoute[],
    options: RegisterModuleOptions = {},
  ): void {
    this.unregisterModule(moduleName);
    if (routes.length === 0) return;
    const httpConfig = options.httpConfig ?? null;
    const dbEnabled = options.dbEnabled === true;
    const tablePrefix = options.tablePrefix ?? '';
    const registered: RegisteredRoute[] = [];
    for (const r of routes) {
      validateRoute(r);
      const fullPath = joinPath(apiNamespace, r.path);
      const { pattern, paramNames } = compilePathPattern(fullPath);
      registered.push({
        moduleName,
        apiNamespace,
        method: r.method,
        fullPath,
        pattern,
        paramNames,
        handler: r.handler,
        httpConfig,
        dbEnabled,
        tablePrefix,
      });
    }
    this.routesByModule.set(moduleName, registered);
    this.logger.log(
      `Módulo "${moduleName}" registró ${registered.length} ruta(s) bajo ${apiNamespace} (http=${httpConfig ? 'enabled' : 'blocked'}, db=${dbEnabled ? 'enabled' : 'blocked'}).`,
    );
  }

  /// Borra todas las routes del módulo. Se llama al desinstalar y antes de
  /// cada upgrade.
  unregisterModule(moduleName: string): void {
    const had = this.routesByModule.delete(moduleName);
    if (had) {
      this.logger.log(`Módulo "${moduleName}" desregistrado del router runtime.`);
    }
  }

  /// Devuelve handler+params para un (method, path) entrante, o null si no
  /// matchea ninguna route registrada. El dispatcher debe llamar a esto
  /// con el path SIN el prefijo `/api/v1/`.
  match(method: string, path: string): {
    moduleName: string;
    handler: ModuleRouteHandler;
    params: Record<string, string>;
    httpConfig: ModuleHttpConfig | null;
    dbEnabled: boolean;
    tablePrefix: string;
  } | null {
    const upperMethod = method.toUpperCase();
    for (const list of this.routesByModule.values()) {
      for (const route of list) {
        if (route.method !== upperMethod) continue;
        const m = path.match(route.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? '');
        });
        return {
          moduleName: route.moduleName,
          handler: route.handler,
          params,
          httpConfig: route.httpConfig,
          dbEnabled: route.dbEnabled,
          tablePrefix: route.tablePrefix,
        };
      }
    }
    return null;
  }

  /// Listado plano de routes registradas. Útil para `/admin/modules/installed/:name/routes`.
  listRoutes(moduleName?: string): Array<{
    moduleName: string;
    method: AllowedMethod;
    path: string;
  }> {
    const out: Array<{ moduleName: string; method: AllowedMethod; path: string }> = [];
    for (const [name, list] of this.routesByModule.entries()) {
      if (moduleName && name !== moduleName) continue;
      for (const r of list) {
        out.push({ moduleName: name, method: r.method, path: r.fullPath });
      }
    }
    return out;
  }
}

/// Rechaza routes con shape inválida. Lanza `Error` directo (no
/// `MarketplacePackageError`) porque el caller es el sandbox boot, que
/// envuelve cualquier excepción en `MODULE_BOOT_FAILED`.
function validateRoute(r: ModuleRoute): void {
  if (!r || typeof r !== 'object') {
    throw new Error('route inválida: se esperaba { method, path, handler }');
  }
  if (!ALLOWED_METHODS.includes(r.method)) {
    throw new Error(
      `route.method "${r.method}" no permitido (esperado: ${ALLOWED_METHODS.join('|')})`,
    );
  }
  if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
    throw new Error('route.path debe ser un string que empiece por "/"');
  }
  if (r.path.includes('..') || r.path.includes('//')) {
    throw new Error('route.path contiene segmentos inválidos ("//", "..")');
  }
  if (typeof r.handler !== 'function') {
    throw new Error('route.handler debe ser una función');
  }
}

function joinPath(namespace: string, sub: string): string {
  const n = namespace.replace(/\/$/, '');
  const s = sub.startsWith('/') ? sub : `/${sub}`;
  return `${n}${s}`;
}

/// Convierte `/modules/example/items/:id/comments/:cid` en una regex con
/// captures + lista ordenada de nombres de params. No soporta wildcards
/// glob ni regex en el path por simplicidad y por evitar ReDoS.
export function compilePathPattern(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = path.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${withParams}/?$`), paramNames };
}
