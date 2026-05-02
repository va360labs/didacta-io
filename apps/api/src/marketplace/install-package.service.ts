import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import type { InstalledModule } from '@didacta/database';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { InstalledModuleService } from './installed-module.service';
import type { ModuleManifest } from './module-manifest.schema';
import { MarketplacePackageError } from './module-package.errors';
import { ModuleMigrationService } from './module-migration.service';
import { ModulePackageService } from './module-package.service';
import { ModuleRouterService } from './module-router.service';
import { ModuleSandboxService } from './module-sandbox.service';

/// Versión del core a la que apunta esta instancia. Inyectada en runtime,
/// no en build time, para permitir overrides en tests sin recompilar. Si
/// `DIDACTA_CORE_VERSION` no está set, asumimos `0.0.0` — eso fuerza a que
/// solo módulos con `coreVersionRequired: ^0.0.0` o exact match se acepten,
/// que es el comportamiento conservador para entornos sin metadata clara.
function resolveCoreVersion(): string {
  return process.env['DIDACTA_CORE_VERSION'] ?? '0.0.0';
}

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
      const sandboxed = this.sandbox.loadModule(distSource, validated.manifest.name);

      // 13. Hook de instalación del módulo, si lo declara.
      await this.sandbox.runOnInstall(
        sandboxed,
        validated.manifest.name,
        validated.manifest.version,
      );

      // 14. Registro de routes en el dispatcher runtime. Si el módulo
      // declara `routes`, el dispatcher las atenderá inmediatamente bajo
      // `/api/v1<apiNamespace>/<route.path>`. Si lanza por shape inválida
      // (validación dentro de `register`), el catch externo marca FAILED.
      if (sandboxed.routes && sandboxed.routes.length > 0) {
        try {
          this.router.registerModule(
            validated.manifest.name,
            validated.manifest.apiNamespace,
            sandboxed.routes,
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

      // 15. Cierre OK.
      const installed = await this.installedModules.markInstalled(row.id);
      this.logger.log(
        `Módulo "${installed.name}@${installed.version}" instalado y booteado en sandbox ` +
          `(vendor=${installed.vendor}). Registro DynamicModule para enrutado HTTP llegará en PR siguiente.`,
      );

      return toInstallResult(installed, validated.manifest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.installedModules.markFailed(row.id, msg).catch(() => {
        this.logger.error(`No se pudo marcar FAILED el row ${row.id}: ${msg}`);
      });
      throw err;
    }
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

function toInstallResult(row: InstalledModule, manifest: ModuleManifest): InstallResult {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    manifest,
    packageStorageKey: row.packageStorageKey,
    packageSha256: row.packageSha256,
    installedAt: row.installedAt,
  };
}
