import { describe, expect, it, vi } from 'vitest';
import {
  DB_DEFAULTS,
  SandboxedDbService,
  countNonTrailingSemicolons,
  detectStatementKind,
  extractCteAliases,
  extractTableRefs,
  mapPostgresError,
  maskFromFunctions,
  stripCommentsAndStrings,
  validateSql,
} from '../../src/marketplace/sandboxed-db.service';
import { DbError } from '../../src/marketplace/sandboxed-db.types';
import type { PrismaService } from '../../src/prisma/prisma.service';

/// Tests del SandboxedDbService (alpha.51 task DB-003).
///
/// Capas defensivas (en orden, fail-fast):
///   1. validateSql → DB_INVALID_SQL / DB_STATEMENT_TOO_LONG / DB_PREFIX_VIOLATION
///   2. Wrap en $transaction → SET LOCAL tenant + statement_timeout
///   3. $queryRawUnsafe / $executeRawUnsafe con prepared statements
///   4. Post-check rows.length > maxRows → DB_TOO_MANY_ROWS
///   5. mapPostgresError(err) → DbErrorCode tipado

const PREFIX = 'mod_example_';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros del SQL guard
// ─────────────────────────────────────────────────────────────────────────────

describe('stripCommentsAndStrings', () => {
  it('quita comentario de línea --', () => {
    const out = stripCommentsAndStrings(`SELECT 1 -- secret comment\nFROM mod_x_t`);
    expect(out).not.toContain('secret');
    expect(out).toContain('SELECT');
    expect(out).toContain('mod_x_t');
  });
  it('quita comentario de bloque /* */', () => {
    const out = stripCommentsAndStrings(`SELECT /* drop table users */ 1 FROM mod_x_t`);
    expect(out).not.toContain('drop');
    expect(out).toContain('mod_x_t');
  });
  it('blanquea contenido de strings literales', () => {
    const out = stripCommentsAndStrings(`SELECT 'mod_other_users' FROM mod_x_t`);
    // El string literal queda como espacios — no debe verse como tabla.
    expect(out).not.toContain('mod_other_users');
    expect(out).toContain('mod_x_t');
  });
  it('respeta escape de apóstrofo doble en strings', () => {
    const out = stripCommentsAndStrings(`SELECT 'a''b' FROM mod_x_t`);
    expect(out).toContain('mod_x_t');
    // No debe fallar dejando un string abierto.
  });
  it('preserva quoted identifiers ("foo")', () => {
    // Quoted idents son nombres de tabla — DEBEN quedar visibles para el extractor.
    const out = stripCommentsAndStrings(`SELECT * FROM "mod_x_t"`);
    expect(out).toContain('mod_x_t');
  });
});

describe('countNonTrailingSemicolons', () => {
  it('0 si no hay punto y coma', () => {
    expect(countNonTrailingSemicolons('SELECT 1')).toBe(0);
  });
  it('0 si solo hay trailing ;', () => {
    expect(countNonTrailingSemicolons('SELECT 1;')).toBe(0);
    expect(countNonTrailingSemicolons('SELECT 1;   ')).toBe(0);
  });
  it('1 si hay statement extra', () => {
    expect(countNonTrailingSemicolons('SELECT 1; SELECT 2')).toBe(1);
    expect(countNonTrailingSemicolons('SELECT 1; SELECT 2;')).toBe(1);
  });
  it('cuenta múltiples', () => {
    expect(countNonTrailingSemicolons('A; B; C;')).toBe(2);
  });
});

describe('detectStatementKind', () => {
  it.each([
    ['SELECT * FROM t', 'select'],
    ['  select 1', 'select'],
    ['INSERT INTO t VALUES (1)', 'insert'],
    ['UPDATE t SET x=1', 'update'],
    ['DELETE FROM t', 'delete'],
    ['WITH cte AS (...) SELECT * FROM cte', 'with'],
    ['VALUES (1, 2)', 'values'],
    ['CREATE TABLE x (id int)', 'create'],
    ['DROP TABLE x', 'drop'],
    ['ALTER TABLE x ADD COLUMN y int', 'alter'],
    ['TRUNCATE x', 'truncate'],
    ['GRANT SELECT ON x TO y', 'grant'],
  ])('%s → %s', (sql, expected) => {
    expect(detectStatementKind(sql)).toBe(expected);
  });
});

describe('maskFromFunctions', () => {
  it('enmascara contenido de extract(... FROM ...)', () => {
    const out = maskFromFunctions(`SELECT extract(year FROM created_at) FROM mod_x_t`);
    // El "FROM created_at" interno queda blanqueado — solo el FROM exterior queda visible.
    const inside = out.slice(out.indexOf('('), out.indexOf(')') + 1);
    expect(inside).not.toContain('FROM');
    expect(inside).not.toContain('created_at');
    // El FROM externo (de mod_x_t) sí debe seguir.
    expect(out).toContain('FROM mod_x_t');
  });
  it('soporta substring(s FROM 1 FOR 10)', () => {
    const out = maskFromFunctions(`SELECT substring(name FROM 1 FOR 10) FROM mod_x_t`);
    expect(out).not.toContain('FROM 1');
    expect(out).toContain('FROM mod_x_t');
  });
  it('no enmascara funciones que no usan FROM', () => {
    const out = maskFromFunctions(`SELECT lower(name), upper(email) FROM mod_x_t`);
    expect(out).toContain('lower(name)');
    expect(out).toContain('upper(email)');
  });
  it('soporta parens anidados dentro del enmascarado', () => {
    const out = maskFromFunctions(`SELECT trim(BOTH ' ' FROM coalesce(name, 'x')) FROM mod_x_t`);
    expect(out).toContain('FROM mod_x_t');
    // El inner coalesce queda blanqueado junto con todo el contenido del trim().
    expect(out).not.toMatch(/coalesce\([^)]+\)\s+FROM\s+mod_x/);
  });
});

describe('extractCteAliases', () => {
  it('vacío si no hay WITH', () => {
    expect([...extractCteAliases('SELECT * FROM mod_x_t')]).toEqual([]);
  });
  it('captura un alias', () => {
    const aliases = extractCteAliases('WITH cte AS (SELECT 1) SELECT * FROM cte');
    expect(aliases.has('cte')).toBe(true);
  });
  it('captura múltiples CTEs encadenadas', () => {
    const aliases = extractCteAliases(
      'WITH a AS (SELECT 1), b AS (SELECT 2), c AS (SELECT 3) SELECT * FROM a JOIN b ON true JOIN c ON true',
    );
    expect(aliases.has('a')).toBe(true);
    expect(aliases.has('b')).toBe(true);
    expect(aliases.has('c')).toBe(true);
  });
  it('soporta WITH RECURSIVE', () => {
    const aliases = extractCteAliases(
      'WITH RECURSIVE tree AS (SELECT 1) SELECT * FROM tree',
    );
    expect(aliases.has('tree')).toBe(true);
  });
  it('soporta column list en CTE', () => {
    const aliases = extractCteAliases(
      'WITH agg(total, n) AS (SELECT sum(x), count(*) FROM mod_x_t) SELECT * FROM agg',
    );
    expect(aliases.has('agg')).toBe(true);
  });
});

describe('extractTableRefs', () => {
  it('captura FROM <tabla>', () => {
    expect([...extractTableRefs('SELECT * FROM mod_x_users')]).toEqual(['mod_x_users']);
  });
  it('captura JOIN', () => {
    const refs = extractTableRefs(
      'SELECT * FROM mod_x_a a INNER JOIN mod_x_b b ON a.id=b.id LEFT JOIN mod_x_c c ON b.id=c.id',
    );
    expect(refs.has('mod_x_a')).toBe(true);
    expect(refs.has('mod_x_b')).toBe(true);
    expect(refs.has('mod_x_c')).toBe(true);
  });
  it('captura UPDATE / DELETE FROM / INSERT INTO', () => {
    expect([...extractTableRefs('UPDATE mod_x_t SET name=$1')]).toEqual(['mod_x_t']);
    expect([...extractTableRefs('DELETE FROM mod_x_t WHERE id=$1')]).toEqual(['mod_x_t']);
    expect([...extractTableRefs('INSERT INTO mod_x_t (a, b) VALUES ($1, $2)')]).toEqual([
      'mod_x_t',
    ]);
  });
  it('soporta ONLY en FROM/UPDATE/DELETE', () => {
    expect([...extractTableRefs('SELECT * FROM ONLY mod_x_t')]).toEqual(['mod_x_t']);
    expect([...extractTableRefs('UPDATE ONLY mod_x_t SET a=1')]).toEqual(['mod_x_t']);
  });
  it('soporta qualified schema.table — devuelve solo el último segmento', () => {
    expect([...extractTableRefs('SELECT * FROM public.mod_x_t')]).toEqual(['mod_x_t']);
  });
  it('soporta quoted idents', () => {
    expect([...extractTableRefs('SELECT * FROM "mod_x_t"')]).toEqual(['mod_x_t']);
  });
  it('NO confunde JOIN USING (col) con table ref', () => {
    const refs = extractTableRefs(
      'SELECT * FROM mod_x_a a JOIN mod_x_b b USING (id)',
    );
    expect(refs.has('mod_x_a')).toBe(true);
    expect(refs.has('mod_x_b')).toBe(true);
    expect(refs.has('id')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSql — invariantes del contrato
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSql — happy path', () => {
  it.each([
    'SELECT * FROM mod_example_jobs',
    'SELECT id FROM mod_example_jobs WHERE id = $1',
    'INSERT INTO mod_example_jobs (id, status) VALUES ($1, $2)',
    'UPDATE mod_example_jobs SET status = $1 WHERE id = $2',
    'DELETE FROM mod_example_jobs WHERE id = $1',
    'WITH agg AS (SELECT count(*) FROM mod_example_jobs) SELECT * FROM agg',
    'SELECT extract(year FROM created_at) FROM mod_example_jobs',
    'SELECT * FROM mod_example_a JOIN mod_example_b ON mod_example_a.id = mod_example_b.aid',
    'SELECT * FROM ONLY mod_example_jobs',
    'SELECT * FROM "mod_example_jobs"',
  ])('OK: %s', (sql) => {
    expect(() => validateSql(sql, PREFIX)).not.toThrow();
  });
});

describe('validateSql — DB_INVALID_SQL', () => {
  it.each([
    ['', 'vacío'],
    ['   \n  ', 'solo whitespace'],
    ['CREATE TABLE mod_example_x (id int)', 'CREATE'],
    ['DROP TABLE mod_example_x', 'DROP'],
    ['ALTER TABLE mod_example_x ADD COLUMN y int', 'ALTER'],
    ['TRUNCATE mod_example_x', 'TRUNCATE'],
    ['GRANT SELECT ON mod_example_x TO public', 'GRANT'],
    ['REVOKE SELECT ON mod_example_x FROM public', 'REVOKE'],
    ['COPY mod_example_x FROM stdin', 'COPY'],
    ['DO $$ BEGIN END $$', 'DO block'],
    ['SELECT 1; SELECT 2', 'multi-statement'],
    ['SELECT 1; INSERT INTO mod_example_x VALUES (1)', 'multi-statement con DML'],
  ])('rechaza "%s" (%s)', (sql) => {
    expect(() => validateSql(sql, PREFIX)).toThrowError(DbError);
    try {
      validateSql(sql, PREFIX);
    } catch (err) {
      expect((err as DbError).code).toBe('DB_INVALID_SQL');
    }
  });
});

describe('validateSql — DB_STATEMENT_TOO_LONG', () => {
  it('rechaza SQL > 50 KB', () => {
    const huge = 'SELECT * FROM mod_example_jobs WHERE id IN (' +
      Array.from({ length: 10000 }, (_, i) => `'${i}'`).join(',') +
      ')';
    expect(() => validateSql(huge, PREFIX)).toThrow(DbError);
    try {
      validateSql(huge, PREFIX);
    } catch (err) {
      expect((err as DbError).code).toBe('DB_STATEMENT_TOO_LONG');
    }
  });
});

describe('validateSql — DB_PREFIX_VIOLATION', () => {
  it('rechaza tabla del core (user)', () => {
    expect(() => validateSql('SELECT * FROM "user"', PREFIX)).toThrowError(
      expect.objectContaining({ code: 'DB_PREFIX_VIOLATION' }),
    );
  });
  it('rechaza tabla de OTRO módulo', () => {
    expect(() =>
      validateSql('SELECT * FROM mod_other_jobs', PREFIX),
    ).toThrowError(expect.objectContaining({ code: 'DB_PREFIX_VIOLATION' }));
  });
  it('rechaza JOIN cross-module', () => {
    expect(() =>
      validateSql(
        'SELECT * FROM mod_example_a a JOIN mod_other_b b ON a.id=b.aid',
        PREFIX,
      ),
    ).toThrowError(expect.objectContaining({ code: 'DB_PREFIX_VIOLATION' }));
  });
  it('rechaza UPDATE de tabla del core', () => {
    expect(() =>
      validateSql('UPDATE "user" SET email = $1 WHERE id = $2', PREFIX),
    ).toThrowError(expect.objectContaining({ code: 'DB_PREFIX_VIOLATION' }));
  });
  it('NO rechaza CTE alias que no empieza con prefix', () => {
    // El CTE alias se excluye del check — eso es correcto, es un alias
    // local del query, no toca tabla real.
    expect(() =>
      validateSql(
        'WITH agg AS (SELECT count(*) FROM mod_example_jobs) SELECT * FROM agg',
        PREFIX,
      ),
    ).not.toThrow();
  });
  it('NO se confunde con string literal "mod_other"', () => {
    // El string literal NO debe disparar prefix violation.
    expect(() =>
      validateSql(`SELECT 'mod_other_secret' FROM mod_example_jobs`, PREFIX),
    ).not.toThrow();
  });
  it('NO se confunde con extract(... FROM col)', () => {
    expect(() =>
      validateSql(
        'SELECT extract(year FROM created_at) FROM mod_example_jobs',
        PREFIX,
      ),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SandboxedDbService — integración con Prisma mock
// ─────────────────────────────────────────────────────────────────────────────

interface PrismaMockState {
  txCount: number;
  /// SQL ejecutado dentro de cada $transaction (en orden).
  executed: Array<{ kind: 'queryRawUnsafe' | 'executeRawUnsafe'; sql: string; params: unknown[] }>;
  /// Si está set, la próxima query del kind indicado lanza el error provisto.
  failNextQueryWith?: Error;
  failNextExecuteWith?: Error;
  /// Stub de respuesta para $queryRawUnsafe.
  queryReturn?: unknown[];
  /// Stub de respuesta para $executeRawUnsafe (rowCount).
  executeReturn?: number;
}

function makePrismaMock(opts: PrismaMockState = { txCount: 0, executed: [] }): {
  prisma: PrismaService;
  state: PrismaMockState;
} {
  const state = opts;

  const tx = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      state.executed.push({ kind: 'queryRawUnsafe', sql, params });
      if (state.failNextQueryWith) {
        const err = state.failNextQueryWith;
        state.failNextQueryWith = undefined;
        throw err;
      }
      return state.queryReturn ?? [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      state.executed.push({ kind: 'executeRawUnsafe', sql, params });
      if (state.failNextExecuteWith) {
        const err = state.failNextExecuteWith;
        state.failNextExecuteWith = undefined;
        throw err;
      }
      // SET LOCAL devuelve siempre 0; lo simulamos.
      if (/^SET LOCAL/i.test(sql)) return 0;
      return state.executeReturn ?? 1;
    }),
  };

  const prisma = {
    $transaction: vi.fn(
      async (
        cb: (tx: typeof tx) => Promise<unknown>,
        _opts?: { timeout?: number },
      ) => {
        state.txCount++;
        return cb(tx);
      },
    ),
  } as unknown as PrismaService;

  return { prisma, state };
}

describe('SandboxedDbService.build — guards estructurales', () => {
  it('rechaza tablePrefix inválido', () => {
    const { prisma } = makePrismaMock();
    const svc = new SandboxedDbService(prisma);
    expect(() => svc.build('mod.test', 'invalid_prefix', 'tnt')).toThrow(/tablePrefix inválido/);
  });
  it('acepta tablePrefix válido', () => {
    const { prisma } = makePrismaMock();
    const svc = new SandboxedDbService(prisma);
    expect(() => svc.build('mod.test', 'mod_test_', 'tnt')).not.toThrow();
  });
});

describe('SandboxedDbService — query happy path', () => {
  it('ejecuta SELECT scoped, setea tenant + statement_timeout, devuelve rows', async () => {
    const { prisma, state } = makePrismaMock({
      txCount: 0,
      executed: [],
      queryReturn: [{ id: 1 }, { id: 2 }],
    });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tenant-abc');

    const result = await db.query('SELECT * FROM mod_example_jobs WHERE id = $1', [42]);

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.rowCount).toBe(2);
    expect(state.txCount).toBe(1);

    const sqlExecuted = state.executed.map((e) => e.sql);
    // Debe incluir SET LOCAL app.current_tenant_id y SET LOCAL statement_timeout.
    expect(sqlExecuted.some((s) => /SET LOCAL app\.current_tenant_id/.test(s))).toBe(true);
    expect(sqlExecuted.some((s) => /SET LOCAL statement_timeout/.test(s))).toBe(true);
    // Y la query del usuario, con params.
    const userQuery = state.executed.find((e) => /SELECT \* FROM mod_example_jobs/.test(e.sql));
    expect(userQuery).toBeDefined();
    expect(userQuery!.params).toEqual([42]);
  });

  it('NO setea tenant si tenantId es null', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [], queryReturn: [] });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, null);

    await db.query('SELECT 1 FROM mod_example_jobs');

    const setTenant = state.executed.find((e) => /SET LOCAL app\.current_tenant_id/.test(e.sql));
    expect(setTenant).toBeUndefined();
  });

  it('rechaza tenantId con caracteres peligrosos (defensa SQL injection)', async () => {
    const { prisma } = makePrismaMock();
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, "x'; DROP TABLE foo;--");

    await expect(db.query('SELECT * FROM mod_example_jobs')).rejects.toMatchObject({
      code: 'DB_NETWORK',
      message: expect.stringContaining('tenantId con caracteres no permitidos'),
    });
  });
});

describe('SandboxedDbService — execute', () => {
  it('devuelve rowCount de UPDATE/DELETE/INSERT sin RETURNING', async () => {
    const { prisma } = makePrismaMock({
      txCount: 0,
      executed: [],
      executeReturn: 7,
    });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    const result = await db.execute('UPDATE mod_example_jobs SET status = $1', ['done']);
    expect(result.rowCount).toBe(7);
  });
});

describe('SandboxedDbService — caps', () => {
  it('rechaza con DB_TOO_MANY_ROWS si la query devuelve más que maxRows', async () => {
    const tooMany = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const { prisma } = makePrismaMock({
      txCount: 0,
      executed: [],
      queryReturn: tooMany,
    });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await expect(
      db.query('SELECT * FROM mod_example_jobs', [], { maxRows: 3 }),
    ).rejects.toMatchObject({ code: 'DB_TOO_MANY_ROWS' });
  });

  it('clampa timeoutMs al cap del core (10s)', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [], queryReturn: [] });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await db.query('SELECT 1 FROM mod_example_jobs', [], { timeoutMs: 60_000 });

    const setTimeout = state.executed.find((e) => /SET LOCAL statement_timeout/.test(e.sql));
    expect(setTimeout).toBeDefined();
    // Debe haber clampeado al cap del core (10_000).
    expect(setTimeout!.sql).toContain(`= ${DB_DEFAULTS.MAX_TIMEOUT_MS}`);
  });

  it('usa default timeoutMs si no se pasa', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [], queryReturn: [] });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await db.query('SELECT 1 FROM mod_example_jobs');

    const setTimeout = state.executed.find((e) => /SET LOCAL statement_timeout/.test(e.sql));
    expect(setTimeout!.sql).toContain(`= ${DB_DEFAULTS.TIMEOUT_MS}`);
  });
});

describe('SandboxedDbService — transaction', () => {
  it('commit cuando el callback resuelve', async () => {
    const { prisma, state } = makePrismaMock({
      txCount: 0,
      executed: [],
      queryReturn: [{ ok: true }],
    });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    const result = await db.transaction(async (tx) => {
      const r = await tx.query('SELECT * FROM mod_example_jobs');
      return r.rows[0];
    });

    expect(result).toEqual({ ok: true });
    // Solo un $transaction abierto (no nesting porque la query interna reusa).
    expect(state.txCount).toBe(1);
  });

  it('rollback cuando el callback lanza', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [], queryReturn: [] });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await expect(
      db.transaction(async () => {
        throw new Error('synthetic failure');
      }),
    ).rejects.toMatchObject({ code: 'DB_TX_ABORTED' });
    expect(state.txCount).toBe(1);
  });

  it('rechaza tx anidada con DB_TX_NESTED', async () => {
    const { prisma } = makePrismaMock({ txCount: 0, executed: [], queryReturn: [] });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await expect(
      db.transaction(async (tx) => {
        await tx.transaction(async () => {
          // never reached
          return null;
        });
      }),
    ).rejects.toMatchObject({ code: 'DB_TX_NESTED' });
  });

  it('queries dentro de tx reusan la conexión (no abren nueva $transaction)', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [], queryReturn: [] });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM mod_example_jobs');
      await tx.query('SELECT 2 FROM mod_example_jobs');
      await tx.execute('UPDATE mod_example_jobs SET x=1');
    });

    // Solo 1 $transaction (la outer); las 3 queries internas usan tx directamente.
    expect(state.txCount).toBe(1);
    // El tenant scope se setea UNA vez al inicio de la tx.
    const tenantSets = state.executed.filter((e) =>
      /SET LOCAL app\.current_tenant_id/.test(e.sql),
    );
    expect(tenantSets.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapPostgresError
// ─────────────────────────────────────────────────────────────────────────────

describe('mapPostgresError', () => {
  it('SQLSTATE 23505 → DB_UNIQUE_VIOLATION', () => {
    const err = mapPostgresError({ meta: { code: '23505' }, message: 'duplicate' }, 1000);
    expect(err.code).toBe('DB_UNIQUE_VIOLATION');
  });
  it('SQLSTATE 23503 → DB_FK_VIOLATION', () => {
    const err = mapPostgresError({ meta: { code: '23503' }, message: 'fk' }, 1000);
    expect(err.code).toBe('DB_FK_VIOLATION');
  });
  it('SQLSTATE 23502 → DB_NOT_NULL', () => {
    const err = mapPostgresError({ meta: { code: '23502' }, message: 'null' }, 1000);
    expect(err.code).toBe('DB_NOT_NULL');
  });
  it('SQLSTATE 23514 → DB_CHECK_VIOLATION', () => {
    const err = mapPostgresError({ meta: { code: '23514' }, message: 'check' }, 1000);
    expect(err.code).toBe('DB_CHECK_VIOLATION');
  });
  it('SQLSTATE 57014 → DB_TIMEOUT', () => {
    const err = mapPostgresError({ meta: { code: '57014' }, message: 'cancel' }, 1234);
    expect(err.code).toBe('DB_TIMEOUT');
    expect(err.message).toContain('1234');
  });

  it('Prisma code P2002 → DB_UNIQUE_VIOLATION', () => {
    const err = mapPostgresError({ code: 'P2002', message: 'prisma unique' }, 1000);
    expect(err.code).toBe('DB_UNIQUE_VIOLATION');
  });

  it('mensaje "duplicate key value" → DB_UNIQUE_VIOLATION', () => {
    const err = mapPostgresError({ message: 'duplicate key value violates unique constraint "x_pkey"' }, 1000);
    expect(err.code).toBe('DB_UNIQUE_VIOLATION');
  });
  it('mensaje "foreign key constraint" → DB_FK_VIOLATION', () => {
    const err = mapPostgresError({ message: 'insert or update violates foreign key constraint "x"' }, 1000);
    expect(err.code).toBe('DB_FK_VIOLATION');
  });
  it('mensaje "canceling statement due to statement timeout" → DB_TIMEOUT', () => {
    const err = mapPostgresError({ message: 'canceling statement due to statement timeout' }, 5000);
    expect(err.code).toBe('DB_TIMEOUT');
  });
  it('default → DB_NETWORK', () => {
    const err = mapPostgresError({ message: 'random pg connection lost' }, 1000);
    expect(err.code).toBe('DB_NETWORK');
  });
  it('preserva DbError ya tipado', () => {
    const inner = new DbError('DB_TOO_MANY_ROWS', 'too many');
    const out = mapPostgresError(inner, 1000);
    expect(out).toBe(inner);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping de errores a través del flujo completo
// ─────────────────────────────────────────────────────────────────────────────

describe('SandboxedDbService — error mapping en el flujo completo', () => {
  it('mapea unique violation desde $queryRawUnsafe', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [] });
    state.failNextQueryWith = Object.assign(new Error('duplicate key value violates unique constraint "mod_example_jobs_pkey"'), {
      meta: { code: '23505' },
    });
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await expect(
      db.query('INSERT INTO mod_example_jobs (id) VALUES ($1) RETURNING id', ['x']),
    ).rejects.toMatchObject({ code: 'DB_UNIQUE_VIOLATION' });
  });

  it('mapea timeout cuando Postgres aborta por statement_timeout', async () => {
    const { prisma, state } = makePrismaMock({ txCount: 0, executed: [] });
    state.failNextQueryWith = new Error('canceling statement due to statement timeout');
    const svc = new SandboxedDbService(prisma);
    const db = svc.build('mod.example', PREFIX, 'tnt');

    await expect(
      db.query('SELECT * FROM mod_example_jobs', [], { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
  });
});
