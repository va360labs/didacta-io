/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { MIGRATIONS_PREFIX, MIGRATION_FILENAME_REGEX } from '@didacta/module-package-spec';
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
///
/// FUENTE DE VERDAD: el contrato de paths/extensiones vive en
/// `@didacta/module-package-spec` (ADR-013). Las reglas se importan de
/// allí — defense-in-depth: el validador upstream (`ModulePackageService`)
/// ya rechazó subdirs antes de llegar acá, pero mantenemos el chequeo
/// local para que `extractMigrations` sea seguro de invocar aislado.

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
      // Rechazo de subdirs: el contrato del spec es plano (todos los .sql
      // al mismo nivel). Esto evita path-traversal en los names.
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        throw new MarketplacePackageError(
          'MODULE_LINT_FAILED',
          `Path de migration inválido: "${entry.entryName}". Las migrations deben vivir directamente bajo prisma/migrations/.`,
        );
      }
      // Whitelist estricto del filename (mismo regex que el spec). Defensa
      // contra caracteres raros que el packager pudiera dejar pasar.
      if (!MIGRATION_FILENAME_REGEX.test(filename)) {
        throw new MarketplacePackageError(
          'MODULE_LINT_FAILED',
          `Nombre de migration inválido: "${filename}". Permitido: alfanuméricos, guion, underscore, punto, terminando en .sql.`,
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
    const skipped = files
      .filter((f) => previouslyAppliedSet.has(f.filename))
      .map((f) => f.filename);
    if (pending.length === 0) {
      return { applied: [], skipped };
    }

    // ¿Existe el escape auditado? En el compose estándar sí; en un cluster de
    // test donde solo corrió `db push` (sin rls.sql/grants.sql), no. Se
    // comprueba ANTES de abrir la transacción: un `SET LOCAL ROLE` que falla
    // aborta la transacción entera en Postgres, y no hay forma de recuperarse
    // desde dentro.
    const conEscalada = await this.superRoleExists();

    try {
      await this.prisma.$transaction(async (tx) => {
        if (conEscalada) {
          // Las migraciones del módulo crean tablas, y la DATABASE_URL de
          // runtime es `didacta_app`: NOSUPERUSER, NOBYPASSRLS, solo USAGE +
          // DML sobre `public`. Desde Postgres 15 `public` ya no concede
          // CREATE a los no-owner, así que cualquier módulo con un
          // `CREATE TABLE` fallaba con "permission denied for schema public"
          // → MODULE_BOOT_FAILED → instalación FAILED, siempre, en el
          // despliegue por defecto. La escalada dura lo que dura esta
          // transacción.
          await tx.$executeRawUnsafe('SET LOCAL ROLE didacta_super');
        }
        for (const file of pending) {
          for (const stmt of splitStatements(file.sql)) {
            await tx.$executeRawUnsafe(stmt);
          }
        }
        // Los permisos de `didacta_app` sobre lo que acaba de crearse NO se
        // conceden aquí: los da `ALTER DEFAULT PRIVILEGES FOR ROLE
        // didacta_super` en `grants.sql`, que aplica solo a los objetos que
        // crea ese rol. Se probó primero con un `GRANT ... ON ALL TABLES IN
        // SCHEMA public` dentro de esta transacción y NO vale: al contrario de
        // lo que parece, Postgres no se salta en silencio las tablas ajenas —
        // lanza "permission denied for table" sobre la primera que no es suya
        // y tumba la transacción entera, con las migraciones dentro.
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

  /**
   * ¿Está creado el rol `didacta_super`? Solo lo está donde se aplicaron
   * `rls.sql` + `grants.sql`, que es todo despliegue real. Donde no (un
   * cluster de test levantado con `db push` a secas), se aplica sin escalada:
   * ahí el usuario de la conexión suele ser el superuser y no hace falta.
   */
  private async superRoleExists(): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'didacta_super') AS "exists"`,
      );
      return rows[0]?.exists === true;
    } catch (err) {
      this.logger.warn(
        `No se pudo comprobar el rol didacta_super (${err instanceof Error ? err.message : String(err)}); se aplican las migraciones sin escalada.`,
      );
      return false;
    }
  }
}
