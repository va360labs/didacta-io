import { describe, expect, it } from 'vitest';
import { lintMigrationSql, parseStatement, splitStatements } from '../../src/marketplace/sql-lint';

const PREFIX = 'mod_example_';

/**
 * Asevera que `fn` lanza un MarketplacePackageError con code MODULE_LINT_FAILED.
 * El code va en `.code` (el mensaje es narrativo), así que `toThrowError(/regex/)`
 * —que mira solo el message— no sirve para este caso.
 */
function expectSqlLintFailed(fn: () => unknown) {
  try {
    fn();
    expect.fail('debería haber lanzado MODULE_LINT_FAILED');
  } catch (err) {
    expect((err as { code?: string }).code).toBe('MODULE_LINT_FAILED');
  }
}

describe('splitStatements', () => {
  it('separa por ; ignorando comentarios', () => {
    const sql = `
      -- comentario
      CREATE TABLE mod_example_foo (id UUID);
      /* multi
         line */
      CREATE INDEX mod_example_foo_idx ON mod_example_foo(id);
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/CREATE TABLE/);
    expect(stmts[1]).toMatch(/CREATE INDEX/);
  });

  it('no parte ; dentro de strings', () => {
    const sql = `INSERT INTO mod_example_foo (label) VALUES ('a;b');`;
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('devuelve array vacío para sql vacío o solo comentarios', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('-- solo comentario\n/* nada */')).toEqual([]);
  });
});

describe('parseStatement', () => {
  it.each([
    ['CREATE TABLE mod_example_foo (id UUID)', 'CREATE_TABLE', 'mod_example_foo'],
    [
      'CREATE UNIQUE INDEX mod_example_foo_idx ON mod_example_foo(id)',
      'CREATE_INDEX',
      'mod_example_foo_idx',
    ],
    ['ALTER TABLE mod_example_foo ADD COLUMN x INT', 'ALTER_TABLE', 'mod_example_foo'],
    ['DROP TABLE IF EXISTS mod_example_foo', 'DROP_TABLE', 'mod_example_foo'],
    ['CREATE SEQUENCE mod_example_seq', 'CREATE_SEQUENCE', 'mod_example_seq'],
    ["CREATE TYPE mod_example_status AS ENUM ('a', 'b')", 'CREATE_TYPE', 'mod_example_status'],
    ["INSERT INTO mod_example_foo (id) VALUES ('x')", 'INSERT', 'mod_example_foo'],
  ])('parsea %s como %s/%s', (raw, kind, ident) => {
    const stmt = parseStatement(raw);
    expect(stmt.kind).toBe(kind);
    expect(stmt.primaryIdentifier).toBe(ident);
  });

  it('detecta REFERENCES en CREATE TABLE', () => {
    const stmt = parseStatement(
      'CREATE TABLE mod_example_child (parent_id UUID REFERENCES mod_example_parent(id))',
    );
    expect(stmt.referencedTables).toContain('mod_example_parent');
  });

  it.each([
    'CREATE FUNCTION foo() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql',
    'CREATE EXTENSION pgcrypto',
    'GRANT SELECT ON foo TO public',
    'TRUNCATE TABLE mod_example_foo',
    "COPY foo FROM '/etc/passwd'",
  ])('rechaza statement prohibido: %s', (raw) => {
    expectSqlLintFailed(() => parseStatement(raw));
  });

  it('rechaza statement no parseable', () => {
    expectSqlLintFailed(() => parseStatement('NOT A SQL STATEMENT'));
  });
});

describe('lintMigrationSql', () => {
  it('acepta migration con identifiers bajo prefix', () => {
    const sql = `
      CREATE TABLE mod_example_foo (id UUID PRIMARY KEY);
      CREATE INDEX mod_example_foo_idx ON mod_example_foo(id);
      ALTER TABLE mod_example_foo ADD COLUMN status TEXT;
    `;
    expect(() => lintMigrationSql(sql, PREFIX)).not.toThrow();
  });

  it('rechaza CREATE TABLE fuera del prefix', () => {
    const sql = `CREATE TABLE other_thing (id UUID);`;
    expect(() => lintMigrationSql(sql, PREFIX)).toThrowError(/no usa el tablePrefix/);
  });

  it('rechaza ALTER TABLE en tabla del core', () => {
    const sql = `ALTER TABLE "user" ADD COLUMN gamification_score INT;`;
    expectSqlLintFailed(() => lintMigrationSql(sql, PREFIX));
  });

  it('rechaza REFERENCES a tabla fuera del prefix', () => {
    const sql = `
      CREATE TABLE mod_example_link (
        user_id UUID REFERENCES "user"(id)
      );
    `;
    expect(() => lintMigrationSql(sql, PREFIX)).toThrowError(/REFERENCES/);
  });

  it('acepta REFERENCES dentro del prefix', () => {
    const sql = `
      CREATE TABLE mod_example_parent (id UUID PRIMARY KEY);
      CREATE TABLE mod_example_child (
        parent_id UUID REFERENCES mod_example_parent(id)
      );
    `;
    expect(() => lintMigrationSql(sql, PREFIX)).not.toThrow();
  });

  it('rechaza DDL prohibido', () => {
    const sql = `CREATE EXTENSION pg_trgm;`;
    expect(() => lintMigrationSql(sql, PREFIX)).toThrowError(/Statement SQL prohibido/);
  });

  it('valida tablePrefix con su propio regex', () => {
    expect(() => lintMigrationSql('CREATE TABLE foo (id INT);', 'mal_prefix')).toThrowError(
      /tablePrefix inválido/,
    );
  });
});
