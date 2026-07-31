/* Sanity check: la migration del módulo migrator-learndash pasa el lint SQL del host.
 * Reproduce localmente lo que la instancia hace en /admin/marketplace antes de aplicar la migration.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintMigrationSql } from '../../src/marketplace/sql-lint';

describe('migrator-learndash migration SQL', () => {
  it('pasa lintMigrationSql con su tablePrefix', () => {
    const sqlPath = resolve(
      __dirname,
      '../../../../modules/migrator-learndash/prisma/migrations/20260503000000_init.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    const stmts = lintMigrationSql(sql, 'mod_migrator_learndash_');
    expect(stmts.length).toBeGreaterThan(0);
    const kinds = new Set(stmts.map((s) => s.kind));
    expect(kinds.has('CREATE_TABLE')).toBe(true);
    expect(kinds.has('CREATE_INDEX')).toBe(true);
  });
});
