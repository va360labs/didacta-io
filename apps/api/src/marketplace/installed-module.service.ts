import { Injectable, Logger } from '@nestjs/common';
import type {
  InstalledModule,
  InstalledModuleStatus,
  InstalledModuleVendor,
  Prisma,
} from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import type { ModuleManifest } from './module-manifest.schema';

/// Wrapper Prisma sobre la tabla `installed_module` (ADR-009 PR A).
///
/// Mantiene el ciclo de vida de un row durante la instalación: se crea con
/// `INSTALLING` antes de tocar storage o ejecutar nada; transiciona a
/// `INSTALLED` cuando el pipeline termina, o a `FAILED` si algo va mal.
///
/// Por qué no usamos `prisma.installedModule.upsert` directo en el
/// orquestador: queremos un único punto donde mapear `manifest → row` para
/// que la auditoría y los tests no se rompan si añadimos columnas.

export interface CreateInstallingInput {
  manifest: ModuleManifest;
  signatureB64: string;
  packageStorageKey: string;
  packageSha256: string;
  packageSizeBytes: number;
  installedById: string;
  /// Si la instalación reemplaza una versión previa (upgrade in-place),
  /// guardamos el número de la versión anterior para permitir revert.
  prevVersion?: string | null;
}

export interface ListFilters {
  status?: InstalledModuleStatus;
  vendor?: InstalledModuleVendor;
}

@Injectable()
export class InstalledModuleService {
  private readonly logger = new Logger(InstalledModuleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findByName(name: string): Promise<InstalledModule | null> {
    return this.prisma.installedModule.findUnique({ where: { name } });
  }

  async list(filters: ListFilters = {}): Promise<InstalledModule[]> {
    return this.prisma.installedModule.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.vendor ? { vendor: filters.vendor } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /// Crea (o reemplaza) el row con `INSTALLING`. Usamos upsert porque un
  /// retry de install para el mismo `name` debe sobreescribir el row
  /// anterior — los rows FAILED no bloquean reintentos.
  async createInstalling(input: CreateInstallingInput): Promise<InstalledModule> {
    const data: Prisma.InstalledModuleUncheckedCreateInput = {
      name: input.manifest.name,
      version: input.manifest.version,
      prevVersion: input.prevVersion ?? null,
      vendor: input.manifest.vendor.toUpperCase() as InstalledModuleVendor,
      displayName: input.manifest.displayName,
      description: input.manifest.description ?? null,
      manifestJson: input.manifest as unknown as Prisma.InputJsonValue,
      signatureB64: input.signatureB64,
      signedAt: new Date(input.manifest.signedAt),
      packageStorageKey: input.packageStorageKey,
      packageSha256: input.packageSha256,
      packageSizeBytes: input.packageSizeBytes,
      coreVersionRequired: input.manifest.coreVersionRequired,
      tablePrefix: input.manifest.tablePrefix,
      apiNamespace: input.manifest.apiNamespace,
      requiredCapabilities: input.manifest.requiredCapabilities,
      requiredEnvVars: input.manifest.requiredEnvVars,
      isolation: input.manifest.isolation,
      status: 'INSTALLING',
      errorMessage: null,
      installedById: input.installedById,
      installedAt: null,
    };

    return this.prisma.installedModule.upsert({
      where: { name: input.manifest.name },
      create: data,
      update: { ...data, errorMessage: null, installedAt: null },
    });
  }

  async markInstalled(id: string): Promise<InstalledModule> {
    return this.prisma.installedModule.update({
      where: { id },
      data: { status: 'INSTALLED', errorMessage: null, installedAt: new Date() },
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<InstalledModule> {
    return this.prisma.installedModule.update({
      where: { id },
      data: { status: 'FAILED', errorMessage: errorMessage.slice(0, 4000) },
    });
  }

  /// Registra qué migraciones SQL del paquete se aplicaron con éxito. El
  /// array es append-only y se mergea con lo que ya hubiera (importante en
  /// upgrades donde el paquete nuevo trae migrations viejas + nuevas).
  async appendMigrationsApplied(id: string, filenames: string[]): Promise<InstalledModule> {
    if (filenames.length === 0) {
      return this.prisma.installedModule.update({
        where: { id },
        data: { migrationsAppliedAt: new Date() },
      });
    }
    const current = await this.prisma.installedModule.findUnique({
      where: { id },
      select: { migrationsApplied: true },
    });
    const merged = Array.from(new Set([...(current?.migrationsApplied ?? []), ...filenames])).sort();
    return this.prisma.installedModule.update({
      where: { id },
      data: { migrationsApplied: merged, migrationsAppliedAt: new Date() },
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.installedModule.delete({ where: { id } });
  }
}
