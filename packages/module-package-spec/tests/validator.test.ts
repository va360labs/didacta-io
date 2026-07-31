import { describe, expect, it } from 'vitest';
import { validatePackageLayout } from '../src/validator';
import type { PackageEntries } from '../src/types';

const buf = (s: string) => Buffer.from(s, 'utf8');

/// Helper para construir un ZIP "mínimo válido" sobre el que cada test añade
/// o muta entries específicos.
function baseEntries(): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ['manifest.jwt', buf('eyJ.payload.sig')],
    ['package.json', buf('{"name":"mod.example","version":"1.0.0","main":"dist/index.js"}')],
    ['dist/index.js', buf('module.exports = {};')],
  ]);
}

describe('validatePackageLayout', () => {
  describe('Required files', () => {
    it('passes for minimal valid package', () => {
      const result = validatePackageLayout(baseEntries() as PackageEntries);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('fails when manifest.jwt is missing', () => {
      const entries = baseEntries();
      entries.delete('manifest.jwt');
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'PACKAGE_MISSING_FILE')).toBeDefined();
      expect(result.errors.find((e) => e.message.includes('manifest.jwt'))).toBeDefined();
    });

    it('fails when package.json is missing', () => {
      const entries = baseEntries();
      entries.delete('package.json');
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.message.includes('package.json'))).toBeDefined();
    });

    it('fails when dist/index.js is missing', () => {
      const entries = baseEntries();
      entries.delete('dist/index.js');
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.message.includes('dist/index.js'))).toBeDefined();
    });

    it('reports all missing files in one pass', () => {
      const result = validatePackageLayout(new Map() as PackageEntries);
      const missing = result.errors.filter((e) => e.code === 'PACKAGE_MISSING_FILE');
      expect(missing).toHaveLength(3);
    });
  });

  describe('prisma/migrations/ rules', () => {
    it('accepts flat .sql files', () => {
      const entries = baseEntries();
      entries.set('prisma/migrations/20260101000000_init.sql', buf('-- sql'));
      entries.set('prisma/migrations/20260201000000_users.sql', buf('-- sql'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(true);
    });

    it('rejects subdir layout (Prisma native)', () => {
      const entries = baseEntries();
      entries.set('prisma/migrations/20260503000000_init/migration.sql', buf('-- sql'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      const lintErr = result.errors.find((e) => e.code === 'MODULE_LINT_FAILED');
      expect(lintErr).toBeDefined();
      expect(lintErr!.message).toContain('directamente bajo prisma/migrations/');
    });

    it('rejects non-.sql files in prisma/migrations/', () => {
      const entries = baseEntries();
      entries.set('prisma/migrations/migration_lock.toml', buf('[provider]'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'MODULE_LINT_FAILED')).toBeDefined();
    });

    it('rejects filenames with spaces or illegal chars', () => {
      const entries = baseEntries();
      entries.set('prisma/migrations/has spaces.sql', buf('-- sql'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'MODULE_LINT_FAILED')).toBeDefined();
    });

    it('rejects path traversal via ..', () => {
      const entries = baseEntries();
      entries.set('prisma/migrations/../etc/passwd', buf('haha'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'PACKAGE_INVALID_ZIP')).toBeDefined();
    });
  });

  describe('dist/ui/ rules', () => {
    it('accepts flat .js bundles', () => {
      const entries = baseEntries();
      entries.set('dist/ui/admin.js', buf('iife-bundle'));
      entries.set('dist/ui/formador.js', buf('iife-bundle'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(true);
    });

    it('rejects subdir under dist/ui/', () => {
      const entries = baseEntries();
      entries.set('dist/ui/admin/index.js', buf('bundle'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'MODULE_LINT_FAILED')).toBeDefined();
    });

    it('rejects non-.js files under dist/ui/', () => {
      const entries = baseEntries();
      entries.set('dist/ui/admin.css', buf('body{}'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'MODULE_LINT_FAILED')).toBeDefined();
    });
  });

  describe('Path safety', () => {
    it('rejects absolute paths', () => {
      const entries = baseEntries();
      entries.set('/etc/passwd', buf('root:x:0:0'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'PACKAGE_INVALID_ZIP')).toBeDefined();
    });

    it('rejects backslash in paths', () => {
      const entries = baseEntries();
      entries.set('dist\\windows\\bundle.js', buf('bundle'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'PACKAGE_INVALID_ZIP')).toBeDefined();
    });

    it('rejects drive letter paths', () => {
      const entries = baseEntries();
      entries.set('C:Users/admin/file.js', buf('bundle'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'PACKAGE_INVALID_ZIP')).toBeDefined();
    });
  });

  describe('Size limits', () => {
    it('rejects packages over 50 MB', () => {
      const entries = baseEntries();
      entries.set('dist/index.js', Buffer.alloc(51 * 1024 * 1024));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.find((e) => e.code === 'PACKAGE_TOO_LARGE')).toBeDefined();
    });

    it('accepts packages just under 50 MB', () => {
      const entries = baseEntries();
      entries.set('dist/index.js', Buffer.alloc(49 * 1024 * 1024));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(true);
    });
  });

  describe('End-to-end realistic packages', () => {
    it('accepts a complete migrator-learndash-shaped ZIP', () => {
      const entries = baseEntries();
      entries.set('dist/ui/admin.js', buf('// admin bundle'));
      entries.set('prisma/migrations/20260503000000_init.sql', buf('-- create tables'));
      entries.set('prisma/migrations/20260504000000_indexes.sql', buf('-- create indexes'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(true);
    });

    it('reports MULTIPLE errors in one pass (not just the first)', () => {
      const entries = new Map<string, Buffer>();
      // Missing all required files + bad migration
      entries.set('prisma/migrations/20260503000000_init/migration.sql', buf('-- sql'));
      entries.set('dist/ui/admin/index.js', buf('bundle'));
      const result = validatePackageLayout(entries as PackageEntries);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });
});
