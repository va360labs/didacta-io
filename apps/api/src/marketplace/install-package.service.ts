/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import AdmZip from 'adm-zip';
import type { InstalledModule } from '@didacta/database';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { ModuleJobLifecycleRegistry } from './job-runner/mod-jobs-lifecycle.registry';
import { InstalledModuleService } from './installed-module.service';
import type { ModuleDidactaConfig, ModuleManifest } from './module-manifest.schema';
import { MarketplacePackageError } from './module-package.errors';
import { ModuleMigrationService } from './module-migration.service';
import { ModulePackageService } from './module-package.service';
import { ModuleRouterService } from './module-router.service';
import { ModuleSandboxService } from './module-sandbox.service';
import { RateLimitedHttp, RateLimiterService } from './rate-limiter.service';
import { ScopedDidactaApiFactory, type CoreServicesResolver } from './sandboxed-didacta.service';
import { BlockedDidactaApi, type DidactaApi } from './sandboxed-didacta.types';
import { SandboxedDbService } from './sandboxed-db.service';
import { BlockedSandboxedDb, type SandboxedDb } from './sandboxed-db.types';
import { SandboxedHttpService } from './sandboxed-http.service';
import { BlockedSandboxedHttp, type SandboxedHttp } from './sandboxed-http.types';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { resolveCoreContractVersion } from '../core-version';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';

/// Versión del core contra la que se valida el `coreVersionRequired` de un
/// paquete. Es EXACTAMENTE la misma que usa el registry al arrancar
/// (`apps/api/src/core-version.ts`): tenerlas separadas es lo que permitió que
/// un módulo pasara una validación y fallara la otra.
function resolveCoreVersion(): string {
  return resolveCoreContractVersion();
}

/// Origen de instalación (DISC-002). Exportado para uso en controller.
export type { ModuleSource } from './module-package.service';

/// Resultado de una instalación, alineado con lo que el endpoint devuelve.
export interface InstallResult {
  id: string;
  name: string;
  version: string;
  status: InstalledModule['status'];
  manifest: ModuleManifest;
  packageStorageKey: string;
  packageSha256: string;
  installedAt: Date | null;
  /// Origen de la instalación (DISC-002).
  source: 'MARKETPLACE_OFFICIAL' | 'MARKETPLACE_COMMUNITY' | 'DIRECT_UPLOAD';
  /// `true` si la firma fue verificada correctamente.
  signatureVerified: boolean;
  /// Error de firma si `signatureVerified=false`. Para mostrar warning en UI.
  signatureError?: string;
}

/// Orquestador del pipeline de instalación de un `*.zip` (ADR-009 §3).
///
/// Pasos:
///   1-8. Validación del paquete (firma, schema, etc.) — PR A.
///   9.   Persistencia del row `installed_module` en estado INSTALLING.
///   10.  Upload del ZIP a object storage.
///   11.  Lint estático del `dist/index.js` + boot en VM aislada (PR C).
///   12.  Ejecución de `onInstall(ctx)` del módulo, si existe.
///   13.  Marcado a INSTALLED (o FAILED si algún paso 10-12 explotó).
///
/// Out of scope todavía:
///   - Registro `DynamicModule` para que el módulo responda a HTTP — un PR
///     más adelante. La VM ya ejecuta el código pero los exports quedan en
///     memoria sin enrutar.
///
/// Idempotencia: si un install para el mismo `name` se reintenta tras un
/// FAILED previo, sobreescribimos el row y subimos un nuevo objeto en
/// storage con clave nueva (la antigua se queda huérfana — la limpia un
/// worker fuera de scope MVP).

@Injectable()
export class InstallPackageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InstallPackageService.name);

  constructor(
    private readonly packageService: ModulePackageService,
    private readonly installedModules: InstalledModuleService,
    private readonly contextFactory: ModuleContextFactory,
    private readonly sandbox: ModuleSandboxService,
    private readonly migrations: ModuleMigrationService,
    private readonly router: ModuleRouterService,
    private readonly httpService: SandboxedHttpService,
    private readonly rateLimiter: RateLimiterService,
    private readonly dbService: SandboxedDbService,
    private readonly didactaFactory: ScopedDidactaApiFactory,
    private readonly moduleRegistry: ModuleRegistryService,
    private readonly tenantContext: TenantContextService,
    private readonly jobLifecycle: ModuleJobLifecycleRegistry,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  /// Re-bootea los módulos previamente instalados al arrancar el server.
  ///
  /// `ModuleRouterService` y `ModuleJobLifecycleRegistry` viven solo en
  /// memoria: las routes y los hooks `onJobTick` se registran durante el
  /// `install()` y se pierden cuando el container se reinicia. Sin este
  /// hook, los módulos quedan `INSTALLED` en BD pero inalcanzables hasta
  /// que el operador haga un re-install manual.
  ///
  /// Lo que SÍ se re-ejecuta: descarga del blob de storage, `extractDistSource`,
  /// `sandbox.loadModule`, `router.registerModule`, `jobLifecycle.register`.
  /// Lo que NO: `onInstall` (es de lifecycle de instalación, no de boot),
  /// migraciones SQL (ya están aplicadas en BD), validación de firma (el
  /// blob ya pasó por validación al instalar — re-validar al boot añadiría
  /// segundos por módulo sin beneficio operativo).
  ///
  /// Si un módulo falla al re-bootear: log de error + skip. NO marcamos
  /// FAILED en BD porque la instalación SÍ ocurrió; el módulo solo está
  /// "running=false" en esta instancia. Re-install lo recupera.
  async onApplicationBootstrap(): Promise<void> {
    const installed = await this.installedModules.list({ status: 'INSTALLED' });
    if (installed.length === 0) {
      this.logger.log('Boot: no hay módulos instalados para re-bootear.');
      return;
    }
    this.logger.log(`Boot: re-booteando ${installed.length} módulo(s) instalado(s)...`);

    const storage = this.contextFactory.getStorage();
    for (const row of installed) {
      const manifest = row.manifestJson as unknown as ModuleManifest;
      try {
        const packageBuffer = await storage.download(row.packageStorageKey);
        const distSource = extractDistSource(packageBuffer);
        const sandboxed = this.sandbox.loadModule(distSource, manifest.name, manifest);

        if (sandboxed.routes && sandboxed.routes.length > 0) {
          this.router.registerModule(manifest.name, manifest.apiNamespace, sandboxed.routes, {
            httpConfig: manifest.http ?? null,
            dbEnabled: manifest.requiresDb === true,
            tablePrefix: manifest.tablePrefix,
            didactaConfig: manifest.didacta ?? null,
            jobLifecycleConfig: manifest.jobLifecycle ?? null,
            requiresSecrets: manifest.requiresSecrets === true,
            secretsLifecycleConfig: manifest.secretsLifecycle ?? null,
          });
        }

        if (sandboxed.onJobTick) {
          this.jobLifecycle.register(manifest.name, sandboxed.onJobTick, {
            httpConfig: manifest.http ?? null,
            dbEnabled: manifest.requiresDb === true,
            tablePrefix: manifest.tablePrefix,
            didactaConfig: manifest.didacta ?? null,
            moduleVersion: manifest.version,
            requiresSecrets: manifest.requiresSecrets === true,
            secretsLifecycleConfig: manifest.secretsLifecycle ?? null,
          });
        }

        this.logger.log(
          `Boot: "${manifest.name}@${manifest.version}" listo ` +
            `(${sandboxed.routes?.length ?? 0} routes, jobTick=${!!sandboxed.onJobTick}).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Boot: fallo al re-cargar "${row.name}@${row.version}": ${msg}. ` +
            `Queda inalcanzable hasta re-install.`,
        );
      }
    }
  }

  async install(packageBuffer: Buffer, installedById: string): Promise<InstallResult> {
    // 1-8. Validación end-to-end (PR A).
    const validated = await this.packageService.validatePackage(packageBuffer, {
      coreVersion: resolveCoreVersion(),
    });

    const previous = await this.installedModules.findByName(validated.manifest.name);
    if (
      previous &&
      previous.version === validated.manifest.version &&
      previous.status === 'INSTALLED'
    ) {
      // Idempotencia explícita: misma versión ya instalada y sana.
      throw new MarketplacePackageError(
        'ALREADY_INSTALLED',
        `El módulo "${validated.manifest.name}" ya está instalado en esta versión.`,
        {
          name: validated.manifest.name,
          version: validated.manifest.version,
          existingId: previous.id,
        },
      );
    }

    const storageKey = buildStorageKey(validated.manifest.name, validated.manifest.version);

    // 9. Crear row INSTALLING — antes de tocar storage para que un fallo
    // de S3 deje la traza en BD.
    const row = await this.installedModules.createInstalling({
      manifest: validated.manifest,
      manifestJwt: validated.manifestJwt,
      packageStorageKey: storageKey,
      packageSha256: validated.packageSha256,
      packageSizeBytes: validated.packageSizeBytes,
      installedById,
      prevVersion: previous?.version ?? null,
      source: validated.source,
    });

    try {
      // 10. Persistir en object storage. Usamos el storage activo de la
      // instancia (S3 / MinIO / local). El driver lo decide la env, no
      // este servicio.
      const storage = this.contextFactory.getStorage();
      await storage.upload(storageKey, packageBuffer, 'application/zip');

      // 11. Migraciones SQL del paquete (`prisma/migrations/*.sql`).
      // Se lintean (`tablePrefix` enforcement, sin REFERENCES cross-module,
      // no DDL prohibida) y luego se aplican en una transacción Prisma.
      // Se hace ANTES del boot del módulo para que el código pueda asumir
      // que sus tablas ya existen. Si algo falla, transacción rollback +
      // markFailed.
      const migrationFiles = this.migrations.extractMigrations(packageBuffer);
      const previouslyApplied = previous?.migrationsApplied ?? [];
      const migrationResult = await this.migrations.applyMigrations(
        migrationFiles,
        validated.manifest.tablePrefix,
        previouslyApplied,
      );
      if (migrationResult.applied.length > 0 || migrationResult.skipped.length > 0) {
        await this.installedModules.appendMigrationsApplied(row.id, migrationResult.applied);
      }

      // 12. Extraer `dist/index.js` y bootear en VM aislada. Si el lint o
      // el boot fallan, lanzamos `MODULE_LINT_FAILED` / `MODULE_BOOT_FAILED`
      // y el catch externo marca el row como FAILED. El blob queda en
      // storage para diagnóstico postmortem (las migrations ya aplicadas
      // NO se rollback — son commits separados; un retry verá las
      // migrations en `migrationsApplied` y no las re-correrá).
      const distSource = extractDistSource(packageBuffer);
      // Pasamos el manifest para que el sandbox valide jobLifecycle.onTickFn
      // contra los exports del bundle (Sprint 3 / JR-003). Si el manifest
      // declara la función pero el bundle no la exporta → MODULE_BOOT_FAILED.
      const sandboxed = this.sandbox.loadModule(
        distSource,
        validated.manifest.name,
        validated.manifest,
      );

      // 13. Hook de instalación del módulo, si lo declara. El http
      // scoped (alpha.49) llega también aquí para que `onInstall` pueda
      // validar credenciales contra el sistema externo antes de marcar
      // INSTALLED. Sin AbortSignal — el lifecycle hook tiene su propio
      // timeout en `runOnInstall` (DEFAULT_TIMEOUT_MS = 5s).
      const installHttp = this.buildScopedHttp(
        validated.manifest.name,
        validated.manifest.http ?? null,
      );
      // ctx.db scoped para `onInstall` (alpha.51). Si el módulo declara
      // `requiresDb: true`, el hook recibe el cliente real para sembrar
      // tablas iniciales o validar invariantes; si no, recibe Blocked.
      // tenantId se resuelve del request del super_admin que disparó el
      // install — en esos requests, el TenantMiddleware ya pobló el ALS.
      const installDb = this.buildScopedDb(
        validated.manifest.name,
        validated.manifest.requiresDb === true,
        validated.manifest.tablePrefix,
      );
      // ctx.didacta scoped para `onInstall` (alpha.52). Si el módulo
      // declara `manifest.didacta.permissions`, recibe ScopedDidactaApi
      // con permission matrix; si no, BlockedDidactaApi (rechazo claro).
      const installDidacta = await this.buildScopedDidacta(
        validated.manifest.name,
        validated.manifest.didacta ?? null,
      );
      await this.sandbox.runOnInstall(
        sandboxed,
        validated.manifest.name,
        validated.manifest.version,
        installHttp,
        installDb,
        installDidacta,
      );

      // 14. Registro de routes en el dispatcher runtime. Si el módulo
      // declara `routes`, el dispatcher las atenderá inmediatamente bajo
      // `/api/v1<apiNamespace>/<route.path>`. Si lanza por shape inválida
      // (validación dentro de `register`), el catch externo marca FAILED.
      // El `httpConfig` del manifest se memoriza junto a las routes para
      // que el dispatcher pueda construir el cliente HTTP scoped por
      // request sin volver a Postgres.
      if (sandboxed.routes && sandboxed.routes.length > 0) {
        try {
          this.router.registerModule(
            validated.manifest.name,
            validated.manifest.apiNamespace,
            sandboxed.routes,
            {
              httpConfig: validated.manifest.http ?? null,
              dbEnabled: validated.manifest.requiresDb === true,
              tablePrefix: validated.manifest.tablePrefix,
              didactaConfig: validated.manifest.didacta ?? null,
              jobLifecycleConfig: validated.manifest.jobLifecycle ?? null,
              requiresSecrets: validated.manifest.requiresSecrets === true,
              secretsLifecycleConfig: validated.manifest.secretsLifecycle ?? null,
            },
          );
        } catch (err) {
          throw new MarketplacePackageError(
            'MODULE_BOOT_FAILED',
            `Routes inválidas: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        // Upgrade in-place: la versión anterior podría haber registrado
        // routes; si la nueva no declara, las anteriores deben morir.
        this.router.unregisterModule(validated.manifest.name);
      }

      // 14b. Registro del onJobTick en el ModuleJobLifecycleRegistry
      // (Sprint 3 / JR-003). Si el módulo expone la función referenciada
      // por `manifest.jobLifecycle.onTickFn`, el sandbox ya la copió a
      // `sandboxed.onJobTick` (alias fijo). Memorizamos el wiring de
      // recursos (httpConfig, dbEnabled, tablePrefix, didactaConfig)
      // para que el worker pueda armar el ctx scoped sin volver a leer
      // el manifest. Si no expone, limpiamos cualquier registro previo
      // (caso upgrade in-place donde la versión anterior tenía jobs).
      if (sandboxed.onJobTick) {
        this.jobLifecycle.register(validated.manifest.name, sandboxed.onJobTick, {
          httpConfig: validated.manifest.http ?? null,
          dbEnabled: validated.manifest.requiresDb === true,
          tablePrefix: validated.manifest.tablePrefix,
          didactaConfig: validated.manifest.didacta ?? null,
          moduleVersion: validated.manifest.version,
          requiresSecrets: validated.manifest.requiresSecrets === true,
          secretsLifecycleConfig: validated.manifest.secretsLifecycle ?? null,
        });
      } else {
        this.jobLifecycle.unregister(validated.manifest.name);
      }

      // 15. Cierre OK.
      const installed = await this.installedModules.markInstalled(row.id);
      this.logger.log(
        `Módulo "${installed.name}@${installed.version}" instalado y booteado en sandbox ` +
          `(vendor=${installed.vendor}). Registro DynamicModule para enrutado HTTP llegará en PR siguiente.`,
      );

      return toInstallResult({
        row: installed,
        manifest: validated.manifest,
        source: validated.source,
        signatureVerified: validated.signatureVerified,
        signatureError: validated.signatureError,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.installedModules.markFailed(row.id, msg).catch(() => {
        this.logger.error(`No se pudo marcar FAILED el row ${row.id}: ${msg}`);
      });
      throw err;
    }
  }

  /// Construye el cliente HTTP scoped para `onInstall/onUninstall`. Mismo
  /// contrato que el del dispatcher; sin AbortSignal porque los lifecycle
  /// hooks tienen su propio timeout (`runOnInstall` en `module-sandbox`).
  private buildScopedHttp(
    moduleName: string,
    httpConfig: import('./module-manifest.schema').ModuleHttpConfig | null,
  ): SandboxedHttp {
    if (!httpConfig) return new BlockedSandboxedHttp(moduleName);
    const inner = this.httpService.build(moduleName, httpConfig);
    return new RateLimitedHttp(inner, this.rateLimiter, moduleName, httpConfig.rateLimitPerHost);
  }

  /// Construye el cliente de BD scoped para `onInstall/onUninstall`.
  /// Mismo contrato que el del dispatcher: si `requiresDb=false` →
  /// Blocked (rechaza con DB_PREFIX_VIOLATION). Si true → Sandboxed
  /// real con tenantId del request actual (super_admin que disparó el
  /// install). El `onInstall` típicamente solo siembra tablas globales
  /// del módulo, pero pasamos el tenantId por si el módulo lo necesita.
  private buildScopedDb(moduleName: string, requiresDb: boolean, tablePrefix: string): SandboxedDb {
    if (!requiresDb) return new BlockedSandboxedDb(moduleName);
    const tenantId = this.tenantContext.get()?.tenantId ?? null;
    return this.dbService.build(moduleName, tablePrefix, tenantId);
  }

  /// Construye el cliente `ctx.didacta` scoped para `onInstall/onUninstall`.
  /// Mismo contrato que el del dispatcher. Si el módulo no declara permisos
  /// → BlockedDidactaApi (rechaza con DIDACTA_PERMISSION_DENIED + mensaje
  /// accionable). Si declara → ScopedDidactaApi con resolver lazy de los
  /// services del core (CoursesService, LearningService, AssessmentsService,
  /// Storage). El resolver es lazy porque ModuleRegistryService.onModuleInit
  /// instancia los services, y ese hook puede aún no haber corrido cuando se
  /// construye este service.
  private async buildScopedDidacta(
    moduleName: string,
    didactaConfig: ModuleDidactaConfig | null,
  ): Promise<DidactaApi> {
    if (!didactaConfig) return new BlockedDidactaApi(moduleName);
    const tenantId = this.tenantContext.get()?.tenantId ?? null;
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId);
    const resolver: CoreServicesResolver = {
      getCoursesService: () => this.moduleRegistry.getCoursesService(),
      getLearningService: () => this.moduleRegistry.getLearningService(),
      getAssessmentsService: () => this.moduleRegistry.getAssessmentsService(),
      getWebBaseUrl: () => webBaseUrl,
      getStorage: () => this.contextFactory.getStorage(),
    };
    return this.didactaFactory.build(moduleName, didactaConfig, resolver);
  }
}

/// Extrae `dist/index.js` del paquete ya validado. La presencia del archivo
/// fue verificada en `ModulePackageService` (PR A); aquí solo lo leemos.
/// Lanza `MODULE_BOOT_FAILED` si por algún motivo (corrupción del buffer
/// entre validación y boot) ya no existe.
function extractDistSource(packageBuffer: Buffer): string {
  const zip = new AdmZip(packageBuffer);
  const entry = zip.getEntry('dist/index.js');
  if (!entry) {
    throw new MarketplacePackageError(
      'MODULE_BOOT_FAILED',
      'dist/index.js desapareció del paquete entre validación y boot — paquete corrupto.',
    );
  }
  return entry.getData().toString('utf8');
}

/// Clave estable en object storage para el paquete. Pattern:
///   modules/<name>/<version>-<timestamp>.zip
/// El timestamp evita colisiones cuando se reinstala la misma versión
/// (caso: el operador subió un build corrupto, lo arregló, vuelve a
/// subir). El cleanup de versiones huérfanas no está en MVP.
export function buildStorageKey(name: string, version: string): string {
  // Saneamos chars no permitidos y, además, colapsamos secuencias de puntos
  // (`..`) para que ningún input pueda inyectar un path-traversal en la key del
  // object storage (p.ej. `1.0.0/../etc` → `1.0.0__etc`, sin `..` ni `/etc`).
  const safeName = name.replace(/[^A-Za-z0-9.-]/g, '_').replace(/\.{2,}/g, '_');
  const safeVersion = version.replace(/[^A-Za-z0-9.+-]/g, '_').replace(/\.{2,}/g, '_');
  const ts = Date.now();
  return `modules/${safeName}/${safeVersion}-${ts}.zip`;
}

interface ToInstallResultOptions {
  row: InstalledModule;
  manifest: ModuleManifest;
  source: InstallResult['source'];
  signatureVerified: boolean;
  signatureError?: string;
}

function toInstallResult(opts: ToInstallResultOptions): InstallResult {
  return {
    id: opts.row.id,
    name: opts.row.name,
    version: opts.row.version,
    status: opts.row.status,
    manifest: opts.manifest,
    packageStorageKey: opts.row.packageStorageKey,
    packageSha256: opts.row.packageSha256,
    installedAt: opts.row.installedAt,
    source: opts.source,
    signatureVerified: opts.signatureVerified,
    signatureError: opts.signatureError,
  };
}
