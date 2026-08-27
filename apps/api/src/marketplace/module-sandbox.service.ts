/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import { createContext, runInContext, type Context } from 'node:vm';
import type { ModuleJobTickHandler } from './job-runner/mod-jobs.types';
import { ALLOWED_REQUIRES, ModuleLintService } from './module-lint.service';
import type { ModuleJobLifecycleConfig } from './module-manifest.schema';
import { MarketplacePackageError } from './module-package.errors';
import type { ModuleRoute } from './module-router.service';
import { NoopSandboxedDb, type SandboxedDb } from './sandboxed-db.types';
import { NoopDidactaApi, type DidactaApi } from './sandboxed-didacta.types';
import { NoopSandboxedHttp, type SandboxedHttp } from './sandboxed-http.types';

/// Hook que un módulo puede declarar en su `module.exports`. Todos opcionales:
/// si falta `onInstall`, el módulo se considera puramente declarativo
/// (solo aporta tablas / endpoints registrados via DynamicModule en PR
/// posterior).
export interface SandboxedModule {
  onInstall?: (ctx: ModuleInstallContext) => Promise<void> | void;
  onUninstall?: (ctx: ModuleInstallContext) => Promise<void> | void;
  /// Routes HTTP que el módulo expone bajo su `apiNamespace`. El
  /// dispatcher (`modules-dispatcher.controller.ts`) las matchea contra
  /// requests entrantes a `/api/v1/modules/<slug>/*`. Forma esperada en
  /// `module-router.service.ts`.
  routes?: ModuleRoute[];
  /// Handler invocado por el `ModJobsWorkerService` (Sprint 3 / JR-002)
  /// por cada tick de un job encolado en `didacta.mod-jobs`. Su
  /// existencia se infiere de `manifest.jobLifecycle.onTickFn` — el
  /// sandbox normaliza el export al campo `onJobTick` para que los
  /// callers (registry, worker) consuman un nombre fijo.
  onJobTick?: ModuleJobTickHandler;
}

/// Contexto restringido que se pasa a los hooks del módulo. Ningún acceso
/// directo a Prisma, S3 ni red — sólo lo que el core decide exponer.
/// alpha.49 añade `http` scoped: cliente HTTP saliente con allowlist por
/// host, rate limit por (módulo, host), SSRF guard y timeout/body cap.
/// La inyección de StorageService scoped y EventBus scoped llega cuando
/// haya use cases reales que la pidan.
export interface ModuleInstallContext {
  moduleName: string;
  moduleVersion: string;
  log: (level: 'log' | 'warn' | 'error', message: string) => void;
  /// Cliente HTTP saliente. Mismo contrato que el de
  /// `ModuleRouteRequestContext.http`. Útil cuando un `onInstall` necesita
  /// validar credenciales contra el sistema externo antes de marcar el
  /// módulo como INSTALLED. Ver `sandboxed-http.types.ts`.
  http: SandboxedHttp;
  /// Cliente de BD scoped al tablePrefix del módulo (alpha.51+). Útil
  /// para `onInstall` que necesite poblar tablas iniciales (seed data).
  /// Ver `sandboxed-db.types.ts`.
  db: SandboxedDb;
  /// API pública del core scoped al módulo (alpha.52+). Útil para
  /// `onInstall` que necesite crear roles iniciales o validar invariantes
  /// del core. Ver `sandboxed-didacta.types.ts`.
  didacta: DidactaApi;
}

/// Timeout por defecto para la ejecución del top-level del módulo y de los
/// hooks `onInstall`/`onUninstall`. 5 segundos es suficiente para boot
/// declarativo + setup ligero. Si un módulo necesita más, está haciendo
/// I/O bloqueante que NO debe vivir en estos hooks.
const DEFAULT_TIMEOUT_MS = 5000;

@Injectable()
export class ModuleSandboxService {
  private readonly logger = new Logger(ModuleSandboxService.name);

  constructor(private readonly lint: ModuleLintService) {}

  /// Carga el `dist/index.js` en una VM aislada y devuelve la `module.exports`
  /// asumiendo el shape `SandboxedModule`. El bundle pasa primero por el
  /// lint estático; luego se ejecuta con un `require` proxy que solo
  /// resuelve módulos de la allowlist.
  ///
  /// Si el manifest declara `jobLifecycle.onTickFn`, validamos que el
  /// bundle exporte esa función bajo ese nombre y la normalizamos al
  /// campo fijo `onJobTick` para que el worker/registry no tengan que
  /// volver a leer el manifest. Si la función no existe → MODULE_BOOT_FAILED.
  ///
  /// `manifest` es opcional para no romper callers existentes que no lo
  /// pasan (algunos tests del sandbox cargan código directamente sin
  /// manifest). En el flujo real de install (`InstallPackageService`)
  /// siempre se pasa.
  loadModule(
    distSource: string,
    moduleName: string,
    manifest?: { jobLifecycle?: ModuleJobLifecycleConfig },
  ): SandboxedModule {
    this.lint.lintBundle(distSource);

    const sandbox = this.buildSandbox(moduleName);
    // codeGeneration.strings/wasm:false → eval() y new Function('code') lanzan
    // dentro del contexto (no se puede generar código en runtime desde el módulo).
    const context = createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    // `module` y `exports` se crean DENTRO del contexto, no en el host. Un
    // objeto creado aquí fuera lleva de vuelta al realm anfitrión por
    // `module.constructor.constructor` (== `Function` del host), que
    // `codeGeneration` no alcanza. Ver la nota de `buildSandbox`.
    runInContext(
      'globalThis.module = { exports: {} }; globalThis.exports = globalThis.module.exports;',
      context,
      { filename: 'didacta:sandbox-bootstrap' },
    );

    try {
      runInContext(distSource, context, {
        filename: `${moduleName}.zip/dist/index.js`,
        timeout: DEFAULT_TIMEOUT_MS,
        displayErrors: true,
      });
    } catch (err) {
      throw wrapBootError(err);
    }

    const moduleExports = runInContext('module.exports', context, {
      filename: 'didacta:sandbox-bootstrap',
    }) as unknown;
    if (!moduleExports || typeof moduleExports !== 'object') {
      throw new MarketplacePackageError(
        'MODULE_BOOT_FAILED',
        'dist/index.js no exporta un objeto (asegúrate de hacer `module.exports = { onInstall: ... }`).',
      );
    }
    const sandboxed = moduleExports as SandboxedModule;
    if (sandboxed.onInstall && typeof sandboxed.onInstall !== 'function') {
      throw new MarketplacePackageError(
        'MODULE_BOOT_FAILED',
        '`onInstall` debe ser una función (recibido: ' + typeof sandboxed.onInstall + ').',
      );
    }
    if (sandboxed.onUninstall && typeof sandboxed.onUninstall !== 'function') {
      throw new MarketplacePackageError(
        'MODULE_BOOT_FAILED',
        '`onUninstall` debe ser una función (recibido: ' + typeof sandboxed.onUninstall + ').',
      );
    }
    if (sandboxed.routes !== undefined) {
      if (!Array.isArray(sandboxed.routes)) {
        throw new MarketplacePackageError(
          'MODULE_BOOT_FAILED',
          '`routes` debe ser un array (recibido: ' + typeof sandboxed.routes + ').',
        );
      }
      // Validación detallada del shape de cada route la hace el router al
      // registrar — aquí solo aseguramos que es un array.
    }

    // jobLifecycle: si el manifest declara `onTickFn`, exigimos que el
    // bundle lo exporte como función. Lo copiamos al alias fijo
    // `onJobTick` para que el resto del host consuma un único nombre.
    const onTickFn = manifest?.jobLifecycle?.onTickFn;
    if (onTickFn) {
      const exported = (moduleExports as Record<string, unknown>)[onTickFn];
      if (typeof exported !== 'function') {
        throw new MarketplacePackageError(
          'MODULE_BOOT_FAILED',
          `manifest.jobLifecycle.onTickFn declara "${onTickFn}" pero el bundle no exporta una función con ese nombre. Asegurate de hacer \`module.exports.${onTickFn} = async (ctx) => { ... };\` (recibido: ${typeof exported}).`,
        );
      }
      sandboxed.onJobTick = exported as ModuleJobTickHandler;
    }

    return sandboxed;
  }

  /// Ejecuta `onInstall(ctx)` con timeout. Si el hook lanza, se propaga
  /// como `MODULE_BOOT_FAILED` con el mensaje del módulo. `http` scoped
  /// puede pasarse explícitamente — si no, el ctx recibe un Noop que
  /// lanza `HTTP_NETWORK` ante cualquier intento de uso (placeholder
  /// alpha.49 hasta que la task 5 cablee el real).
  async runOnInstall(
    sandboxed: SandboxedModule,
    moduleName: string,
    moduleVersion: string,
    http: SandboxedHttp = new NoopSandboxedHttp(),
    db: SandboxedDb = new NoopSandboxedDb(),
    didacta: DidactaApi = new NoopDidactaApi(),
  ): Promise<void> {
    if (!sandboxed.onInstall) return;
    const ctx: ModuleInstallContext = {
      moduleName,
      moduleVersion,
      log: (level, message) => {
        this.logger[level](`[mod:${moduleName}] ${message}`);
      },
      http,
      db,
      didacta,
    };
    try {
      await withTimeout(sandboxed.onInstall(ctx), DEFAULT_TIMEOUT_MS);
    } catch (err) {
      throw wrapBootError(err, 'onInstall lanzó');
    }
  }

  /// Construye el sandbox con globals mínimos. NO se exponen `process`,
  /// `globalThis`, `eval`, `Function`, `fs`, `child_process`, ni timers
  /// que permitan I/O. `Buffer` y `URL` se exponen porque son CPU-only y
  /// muchos módulos legítimos los usan.
  ///
  /// ⚠️ ESTO NO ES UNA FRONTERA DE SEGURIDAD. `node:vm` no aísla realms: la
  /// propia documentación de Node lo dice explícitamente. Cualquier objeto o
  /// función del proceso anfitrión que llegue hasta aquí devuelve el control
  /// al host por su cadena de prototipos —
  /// `<algo del host>.constructor.constructor('return process')()` da el
  /// `Function` del anfitrión, que `codeGeneration: { strings: false }` NO
  /// alcanza porque esa opción sólo restringe la generación de código DENTRO
  /// del contexto—. Siguen siendo puentes vivos `Buffer`, `console`, `URL`,
  /// los timers y, sobre todo, lo que devuelve `require()`.
  ///
  /// Lo que sí hacemos aquí es no regalar el realm: ya NO se inyectan los
  /// intrínsecos del host (`Object`, `Array`, `Promise`, `Reflect`, `Proxy`,
  /// `JSON`, `Math`, `Date`, los `Error`, los TypedArray…). El contexto de la
  /// VM trae los suyos propios, así que el módulo funciona igual, y el camino
  /// corto `Object.constructor('return process')()` deja de existir. Es
  /// reducción de superficie, no aislamiento.
  ///
  /// La frontera real es que NO se ejecuta código sin firma verificada
  /// (`InstallPackageService.assertExecutionAllowed`). El aislamiento de
  /// verdad —proceso aparte, usuario sin privilegios, entorno sin
  /// credenciales, IPC explícito— es trabajo pendiente; `worker_threads` no
  /// vale para esto: es el mismo proceso, comparte memoria y hereda una copia
  /// de `process.env`.
  ///
  /// Reportado por Bruno (ingenierosindustriales.com), ver SECURITY-CREDITS.md.
  private buildSandbox(moduleName: string): Context {
    const sandboxConsole = {
      log: (...args: unknown[]) => this.logger.log(`[mod:${moduleName}] ${formatLogArgs(args)}`),
      info: (...args: unknown[]) => this.logger.log(`[mod:${moduleName}] ${formatLogArgs(args)}`),
      warn: (...args: unknown[]) => this.logger.warn(`[mod:${moduleName}] ${formatLogArgs(args)}`),
      error: (...args: unknown[]) =>
        this.logger.error(`[mod:${moduleName}] ${formatLogArgs(args)}`),
      debug: (...args: unknown[]) =>
        this.logger.debug?.(`[mod:${moduleName}] ${formatLogArgs(args)}`),
    };

    return {
      // `module` / `exports` NO van aquí: los crea el bootstrap dentro del
      // contexto para que no sean objetos del realm anfitrión.
      require: this.buildRequireProxy(moduleName),
      console: sandboxConsole,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      // Timers acotados — sin setInterval/setImmediate persistente. setTimeout
      // se permite con cap de 30s para evitar handlers que vivan tras el
      // unload del módulo.
      setTimeout: (cb: () => void, ms: number) => {
        if (typeof ms !== 'number' || ms < 0 || ms > 30_000) {
          throw new Error('setTimeout: delay fuera de rango (0..30000)');
        }
        return setTimeout(cb, ms).unref();
      },
      clearTimeout,
      // El contexto vm provee `eval` como intrínseco de V8; lo sombreamos a
      // undefined para cumplir la promesa del sandbox (`typeof eval` ===
      // 'undefined'). La generación de código en runtime queda además bloqueada
      // vía `codeGeneration` en createContext (defensa en profundidad).
      eval: undefined,
      // Los intrínsecos JS (`Object`, `Array`, `Promise`, `JSON`, `Math`,
      // `Date`, los `Error`, `Reflect`, `Proxy`, los TypedArray…) NO se
      // inyectan: el contexto de la VM ya tiene los suyos. Inyectar los del
      // host era regalar `Function` del anfitrión vía `.constructor`.
    };
  }

  private buildRequireProxy(moduleName: string): (id: string) => unknown {
    return (id: string) => {
      if (typeof id !== 'string') {
        throw new MarketplacePackageError(
          'MODULE_BOOT_FAILED',
          `[mod:${moduleName}] require() llamado con argumento no-string`,
        );
      }
      if (!ALLOWED_REQUIRES.has(id)) {
        throw new MarketplacePackageError(
          'MODULE_BOOT_FAILED',
          `[mod:${moduleName}] require("${id}") rechazado por allowlist`,
          { module: id },
        );
      }
      // En MVP solo resolvemos los built-ins puros; los workspace packages
      // (`@didacta/core-kernel`, `@nestjs/common`, `zod`) los inyectaremos
      // como stubs con surface mínima cuando haya un módulo real que los
      // use. Por ahora, devolvemos el módulo real desde el resolver de Node
      // del proceso host — la allowlist ya filtra qué se permite.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(id);
    };
  }
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function wrapBootError(err: unknown, prefix?: string): MarketplacePackageError {
  if (err instanceof MarketplacePackageError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MarketplacePackageError(
    'MODULE_BOOT_FAILED',
    prefix ? `${prefix}: ${message}` : message,
  );
}

async function withTimeout<T>(value: Promise<T> | T, timeoutMs: number): Promise<T> {
  if (!(value instanceof Promise)) return value;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hook timeout (${timeoutMs}ms)`)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([value, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
