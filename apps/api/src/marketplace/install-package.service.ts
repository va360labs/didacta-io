import { Injectable, Logger } from '@nestjs/common';
import type { StorageService } from '@didacta/core-kernel';
import type { InstalledModule } from '@didacta/database';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { InstalledModuleService } from './installed-module.service';
import type { ModuleManifest } from './module-manifest.schema';
import { MarketplacePackageError } from './module-package.errors';
import { ModulePackageService } from './module-package.service';

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

/// Orquestador del pipeline de instalación de un `*.didactamod` (ADR-009 §3,
/// pasos 1-9). NO ejecuta el módulo todavía — los pasos de migración Prisma,
/// boot en VM y registro NestJS llegan en PR C. El estado final aquí es
/// `INSTALLED` solo en el sentido de "paquete validado y persistido en
/// storage"; el módulo aún no responde a peticiones.
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
  ) {}

  async install(packageBuffer: Buffer, installedById: string): Promise<InstallResult> {
    // 1-8. Validación end-to-end (PR A).
    const validated = await this.packageService.validatePackage(packageBuffer, {
      coreVersion: resolveCoreVersion(),
    });

    const previous = await this.installedModules.findByName(validated.manifest.name);
    if (previous && previous.version === validated.manifest.version && previous.status === 'INSTALLED') {
      // Idempotencia explícita: misma versión ya instalada y sana.
      // Devolvemos el row existente sin re-subir el ZIP. El caller decide
      // si esto es 200 (ok, no-op) o 409 (conflict).
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
      signatureB64: validated.signatureB64,
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

      // 11-12. Boot en VM + registro NestJS — TODO en PR C. De momento
      // marcamos INSTALLED para reflejar que el paquete está aceptado y
      // persistido. La activación real per-tenant sigue requiriendo el
      // boot que llegará en PR C.
      const installed = await this.installedModules.markInstalled(row.id);
      this.logger.log(
        `Módulo "${installed.name}@${installed.version}" instalado (vendor=${installed.vendor}). ` +
          `Boot en VM pendiente — llega en PR C de ADR-009.`,
      );

      return toInstallResult(installed, validated.manifest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.installedModules.markFailed(row.id, msg).catch(() => {
        // Si BD también falla, hay poco más que loguear — el resto del
        // sistema sigue operativo y el siguiente retry verá el row
        // anterior y lo reescribirá.
        this.logger.error(`No se pudo marcar FAILED el row ${row.id}: ${msg}`);
      });
      throw err;
    }
  }
}

/// Clave estable en object storage para el paquete. Pattern:
///   modules/<name>/<version>-<timestamp>.didactamod
/// El timestamp evita colisiones cuando se reinstala la misma versión
/// (caso: el operador subió un build corrupto, lo arregló, vuelve a
/// subir). El cleanup de versiones huérfanas no está en MVP.
export function buildStorageKey(name: string, version: string): string {
  const safeName = name.replace(/[^A-Za-z0-9.-]/g, '_');
  const safeVersion = version.replace(/[^A-Za-z0-9.+-]/g, '_');
  const ts = Date.now();
  return `modules/${safeName}/${safeVersion}-${ts}.didactamod`;
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
