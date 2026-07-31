import { describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { ModuleMigrationService } from '../../src/marketplace/module-migration.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

const PREFIX = 'mod_example_';

interface PrismaMockOptions {
  /// Si lanza, simula fallo en `$executeRawUnsafe`. Útil para test de
  /// rollback transaccional.
  failOnStatement?: number;
}

interface PrismaMock {
  prisma: PrismaService;
  executed: string[];
  transactionsCommitted: number;
  transactionsRolledBack: number;
}

function makePrismaMock(opts: PrismaMockOptions = {}): PrismaMock {
  const executed: string[] = [];
  let transactionsCommitted = 0;
  let transactionsRolledBack = 0;
  let stmtCount = 0;

  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      stmtCount++;
      if (opts.failOnStatement && stmtCount === opts.failOnStatement) {
        throw new Error('synthetic SQL error');
      }
      executed.push(sql.trim());
      return 1;
    }),
  };

  const prisma = {
    $transaction: vi.fn(async (cb: (tx: typeof tx) => Promise<void>) => {
      const buffer = [...executed];
      try {
        await cb(tx);
        transactionsCommitted++;
      } catch (err) {
        // Simulamos rollback: descartamos lo ejecutado en este transaction.
        executed.length = 0;
        executed.push(...buffer);
        transactionsRolledBack++;
        throw err;
      }
    }),
  } as unknown as PrismaService;

  return {
    prisma,
    executed,
    get transactionsCommitted() {
      return transactionsCommitted;
    },
    get transactionsRolledBack() {
      return transactionsRolledBack;
    },
  } as unknown as PrismaMock;
}

function buildZipWithMigrations(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from('{}'));
  for (const [name, sql] of Object.entries(files)) {
    zip.addFile(`prisma/migrations/${name}`, Buffer.from(sql, 'utf8'));
  }
  return zip.toBuffer();
}

describe('ModuleMigrationService.extractMigrations', () => {
  it('devuelve [] si el ZIP no trae el subdir', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    const svc = new ModuleMigrationService(makePrismaMock().prisma);
    expect(svc.extractMigrations(zip.toBuffer())).toEqual([]);
  });

  it('extrae .sql del subdir y los ordena alfabéticamente', () => {
    const buffer = buildZipWithMigrations({
      '20260502000002_b.sql': '-- b',
      '20260502000001_a.sql': '-- a',
      'README.md': 'no me incluyas', // no .sql, debe ignorarse
    });
    const svc = new ModuleMigrationService(makePrismaMock().prisma);
    const files = svc.extractMigrations(buffer);
    expect(files.map((f) => f.filename)).toEqual(['20260502000001_a.sql', '20260502000002_b.sql']);
  });

  it('rechaza paths con traversal o subdirs', () => {
    const zip = new AdmZip();
    zip.addFile('prisma/migrations/sub/foo.sql', Buffer.from('-- nested'));
    const svc = new ModuleMigrationService(makePrismaMock().prisma);
    expect(() => svc.extractMigrations(zip.toBuffer())).toThrowError(/Path de migration inválido/);
  });
});

describe('ModuleMigrationService.applyMigrations', () => {
  it('aplica migrations pendientes en orden y marca las skipped', async () => {
    const mock = makePrismaMock();
    const svc = new ModuleMigrationService(mock.prisma);
    const files = [
      { path: '', filename: '01_a.sql', sql: 'CREATE TABLE mod_example_a (id INT);' },
      { path: '', filename: '02_b.sql', sql: 'CREATE TABLE mod_example_b (id INT);' },
      { path: '', filename: '03_c.sql', sql: 'CREATE TABLE mod_example_c (id INT);' },
    ];
    const result = await svc.applyMigrations(files, PREFIX, ['01_a.sql']);
    expect(result.applied).toEqual(['02_b.sql', '03_c.sql']);
    expect(result.skipped).toEqual(['01_a.sql']);
    expect(mock.executed).toHaveLength(2);
    expect(mock.executed[0]).toMatch(/CREATE TABLE mod_example_b/);
  });

  it('si hay 0 archivos devuelve {applied:[], skipped:[]} sin tocar BD', async () => {
    const mock = makePrismaMock();
    const svc = new ModuleMigrationService(mock.prisma);
    const result = await svc.applyMigrations([], PREFIX, []);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(mock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('todas ya aplicadas: no abre transaction', async () => {
    const mock = makePrismaMock();
    const svc = new ModuleMigrationService(mock.prisma);
    const files = [{ path: '', filename: '01_a.sql', sql: 'CREATE TABLE mod_example_a (id INT);' }];
    const result = await svc.applyMigrations(files, PREFIX, ['01_a.sql']);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['01_a.sql']);
    expect(mock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lint falla → no abre transaction', async () => {
    const mock = makePrismaMock();
    const svc = new ModuleMigrationService(mock.prisma);
    const files = [{ path: '', filename: 'bad.sql', sql: 'CREATE TABLE other_thing (id INT);' }];
    await expect(svc.applyMigrations(files, PREFIX, [])).rejects.toMatchObject({
      code: 'MODULE_LINT_FAILED',
    });
    expect(mock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rollback transaccional si un statement falla a mitad', async () => {
    const mock = makePrismaMock({ failOnStatement: 2 });
    const svc = new ModuleMigrationService(mock.prisma);
    const files = [
      {
        path: '',
        filename: '01_multi.sql',
        sql:
          'CREATE TABLE mod_example_x (id INT);\n' +
          'CREATE TABLE mod_example_y (id INT);\n' +
          'CREATE TABLE mod_example_z (id INT);',
      },
    ];
    await expect(svc.applyMigrations(files, PREFIX, [])).rejects.toMatchObject({
      code: 'MODULE_BOOT_FAILED',
    });
    // Tras el rollback simulado el array `executed` solo refleja los que
    // sobrevivieron al snapshot pre-transacción (vacío).
    expect(mock.executed).toEqual([]);
  });

  it('mensaje de lint enriquecido con filename', async () => {
    const mock = makePrismaMock();
    const svc = new ModuleMigrationService(mock.prisma);
    const files = [{ path: '', filename: 'broken.sql', sql: 'CREATE TABLE other_thing (id INT);' }];
    await expect(svc.applyMigrations(files, PREFIX, [])).rejects.toMatchObject({
      code: 'MODULE_LINT_FAILED',
      message: expect.stringMatching(/^broken\.sql:/),
    });
  });
});
