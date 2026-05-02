import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { PrismaService } from '../prisma/prisma.service';
import { MarketplacePackageError } from './module-package.errors';
import { lintMigrationSql, splitStatements } from './sql-lint';

/// Convención: el subdir `prisma/migrations/` del paquete `*.zip`
/// contiene 0+ archivos `.sql` que se aplican en orden alfabético. Cada
/// archivo es un set atómico (todo o nada) — si una migration tiene 5
/// statements y el 4º falla, los 4 anteriores se rollback con savepoint.
///
/// MOTIVACIÓN del orden alfabético (no del orden de Prisma migrate): los
/// paquetes `*.zip` son inmutables tras firmar; no podemos meter
/// un `migration.toml` con `lock` mutable. La convención de timestamp
/// prefix (`20260502000001_xxx.sql`) emerge naturalmente de `prisma
/// migrate dev` del módulo y nos da orden estable.

const MIGRATIONS_PREFIX = 'prisma/migrations/';
const SQL_EXT_REGEX = /\.sql$/i;

export interface MigrationFile {
  /// Path completo dentro del ZIP, ej `prisma/migrations/20260502000001_init.sql`.
  path: string;
  /// Nombre del archivo (último segmento), ej `20260502000001_init.sql`.
  filename: string;
  sql: string;
}

export interface MigrationApplyResult {
  applied: string[]; // filenames aplicados en este install
  skipped: string[]; // filenames ya aplicados en un install anterior
}

@Injectable()
export class ModuleMigrationService {
  private readonly logger = new Logger(ModuleMigrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /// Extrae los `.sql` del subdir `prisma/migrations/` del paquete y los
  /// devuelve ordenados alfabéticamente. Devuelve `[]` si el paquete no
  /// trae el subdir (módulo sin tablas propias) — es válido y NO es error.
  extractMigrations(packageBuffer: Buffer): MigrationFile[] {
    const zip = new AdmZip(packageBuffer);
    const files: MigrationFile[] = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.startsWith(MIGRATIONS_PREFIX)) continue;
      if (!SQL_EXT_REGEX.test(entry.entryName)) continue;
      const filename = entry.entryName.slice(MIGRATIONS_PREFIX.length);
      // Rechazo de subdirs: el contrato es plano (todos los .sql al mismo
      // nivel). Esto evita que un atacante use traversal en los names.
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        throw new MarketplacePackageError(
          'MODULE_LINT_FAILED',
          `Path de migration inválido: "${entry.entryName}". Las migrations deben vivir directamente bajo prisma/migrations/.`,
        );
      }
      files.push({
        path: entry.entryName,
        filename,
        sql: entry.getData().toString('utf8'),
      });
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return files;
  }

  /// Linta TODAS las migrations del paquete contra el `tablePrefix` del
  /// módulo antes de aplicar la primera. Si cualquier statement infringe
  /// la regla, lanza `MODULE_LINT_FAILED` y NO se aplica nada.
  lintAllMigrations(files: MigrationFile[], tablePrefix: string): void {
    for (const file of files) {
      try {
        lintMigrationSql(file.sql, tablePrefix);
      } catch (err) {
        if (err instanceof MarketplacePackageError) {
          // Enriquecemos con el filename para mejor debugging.
          throw new MarketplacePackageError(err.code, `${file.filename}: ${err.message}`, {
            ...err.details,
            filename: file.filename,
          });
        }
        throw err;
      }
    }
  }

  /// Aplica las migrations no aplicadas previamente. La aplicación se hace
  /// dentro de una transacción Prisma — si CUALQUIER statement falla, NADA
  /// del set queda en BD (Postgres soporta DDL transaccional).
  ///
  /// Idempotencia: por filename. Si una migration ya está en
  /// `previouslyApplied`, se salta. Permite upgrades: el paquete v1.1.0
  /// puede traer las migrations de v1.0.0 + las nuevas, y solo se aplican
  /// las nuevas.
  async applyMigrations(
    files: MigrationFile[],
    tablePrefix: string,
    previouslyApplied: string[],
  ): Promise<MigrationApplyResult> {
    if (files.length === 0) {
      return { applied: [], skipped: [] };
    }
    this.lintAllMigrations(files, tablePrefix);

    const previouslyAppliedSet = new Set(previouslyApplied);
    const pending = files.filter((f) => !previouslyAppliedSet.has(f.filename));
    const skipped = files.filter((f) => previouslyAppliedSet.has(f.filename)).map((f) => f.filename);
    if (pending.length === 0) {
      return { applied: [], skipped };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        for (const file of pending) {
          for (const stmt of splitStatements(file.sql)) {
            await tx.$executeRawUnsafe(stmt);
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MarketplacePackageError(
        'MODULE_BOOT_FAILED',
        `Falló aplicación de migrations: ${msg}`,
        { tablePrefix, pendingCount: pending.length },
      );
    }

    return { applied: pending.map((f) => f.filename), skipped };
  }
}
