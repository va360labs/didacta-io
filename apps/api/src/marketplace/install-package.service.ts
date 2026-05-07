import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import type { InstalledModule } from '@didacta/database';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { AdminUsersService } from '../admin/admin-users.service';
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

/// Versión del core a la que apunta esta instancia. Inyectada en runtime,
/// no en build time, para permitir overrides en tests sin recompilar. Si
/// `DIDACTA_CORE_VERSION` no está set, asumimos `0.0.0` — eso fuerza a que
/// solo módulos con `coreVersionRequired: ^0.0.0` o exact match se acepten,
/// que es el comportamiento conservador para entornos sin metadata clara.
function resolveCoreVersion(): string {
  return process.env['DIDACTA_CORE_VERSION'] ?? '0.0.0';
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
///   - Aplicación de las migraciones Prisma `prisma/migrations/` del paquete.
///     Hoy ignoramos ese subdir; un módulo que necesite tablas propias se
///     limita a las que ya estén en BD. Esto se aborda en un PR siguiente
///     junto con el linter SQL `tablePrefix`.
///   - Registro `DynamicModule` para que el módulo responda a HTTP — un PR
///     más adelante. La VM ya ejecuta el código pero los exports quedan en
///     memoria sin enrutar.
///
/// Idempotencia: si un install para el mismo `name` se reintenta tras un
/// FAILED previo, sobreescribimos el row y subimos un nuevo objeto en
/// storage con clave nueva (la antigua se queda huérfana — la limpia un
/// worker fuera de scope MVP).

@Injectable()
export class InstallPackageService {
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
  ) {}

  async install(packageBuffer: Buffer, installedById: string): Promise<InstallResult> {
    // 1-8. Validación end-to-end (PR A).
    const validated = await this.packageService.validatePackage(packageBuffer, {
      coreVersion: resolveCoreVersion(),
    });

    const previous = await this.installedModules.findByName(validated.manifest.name);
    if (previous && previous.version === validated.manifest.version && previous.status === 'INSTALLED') {
      // Idempotencia explícita: misma versión ya instalada y sana.
      throw new MarketplacePackageError(
        'ALREADY_INSTALLED',
        `El módulo "${validated.manifest.name}" ya está instalado en esta versión.`,
        { name: validated.manifest.name, version: validated.manifest.version, existingId: previous.id },
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
      const installDidacta = this.buildScopedDidacta(
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
  private buildScopedDb(
    moduleName: string,
    requiresDb: boolean,
    tablePrefix: string,
  ): SandboxedDb {
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
  private buildScopedDidacta(
    moduleName: string,
    didactaConfig: ModuleDidactaConfig | null,
  ): DidactaApi {
    if (!didactaConfig) return new BlockedDidactaApi(moduleName);
    const resolver: CoreServicesResolver = {
      getCoursesService: () => this.moduleRegistry.getCoursesService(),
      getLearningService: () => this.moduleRegistry.getLearningService(),
      getAssessmentsService: () => this.moduleRegistry.getAssessmentsService(),
      getWebBaseUrl: () => process.env['WEB_BASE_URL'] ?? 'http://localhost:3000',
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
  const safeName = name.replace(/[^A-Za-z0-9.-]/g, '_');
  const safeVersion = version.replace(/[^A-Za-z0-9.+-]/g, '_');
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
