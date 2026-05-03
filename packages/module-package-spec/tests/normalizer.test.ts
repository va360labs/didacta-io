import { describe, expect, it } from 'vitest';
import { normalizeMigrations } from '../src/normalizer';
import type { SourceFile } from '../src/types';

const buf = (s: string) => Buffer.from(s, 'utf8');

function src(relativePath: string, content = `-- sql for ${relativePath}`): SourceFile {
  return { relativePath, content: buf(content) };
}

describe('normalizeMigrations', () => {
  describe('Prisma native layout (subdir/migration.sql) → flat', () => {
    it('flattens a single Prisma-native migration', () => {
      const result = normalizeMigrations([src('prisma/migrations/20260503000000_init/migration.sql')]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.zipPath).toBe('prisma/migrations/20260503000000_init.sql');
    });

    it('flattens multiple Prisma-native migrations and preserves content', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260101000000_init/migration.sql', '-- init'),
        src('prisma/migrations/20260201000000_users/migration.sql', '-- users'),
        src('prisma/migrations/20260301000000_courses/migration.sql', '-- courses'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(3);
      const paths = result.files.map((f) => f.zipPath).sort();
      expect(paths).toEqual([
        'prisma/migrations/20260101000000_init.sql',
        'prisma/migrations/20260201000000_users.sql',
        'prisma/migrations/20260301000000_courses.sql',
      ]);
      expect(result.files.find((f) => f.zipPath.endsWith('_init.sql'))!.content.toString()).toBe('-- init');
    });
  });

  describe('Flat layout (already canonical)', () => {
    it('preserves a flat .sql file as-is', () => {
      const result = normalizeMigrations([src('prisma/migrations/20260503000000_init.sql')]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.zipPath).toBe('prisma/migrations/20260503000000_init.sql');
    });

    it('handles a mix of flat and Prisma-native layouts', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260101000000_init.sql', '-- A'),
        src('prisma/migrations/20260201000000_users/migration.sql', '-- B'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(2);
    });
  });

  describe('Stripping of Prisma meta files', () => {
    it('strips migration_lock.toml silently', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260503000000_init/migration.sql'),
        src('prisma/migrations/migration_lock.toml', '[provider]\nprovider = "postgresql"'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.stripped).toContain('prisma/migrations/migration_lock.toml');
    });

    it('strips README.md inside prisma/migrations/', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260503000000_init.sql'),
        src('prisma/migrations/README.md', '# migrations'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.stripped).toContain('prisma/migrations/README.md');
    });

    it('strips hidden files (.DS_Store, .gitkeep) from anywhere', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260503000000_init.sql'),
        src('prisma/migrations/.DS_Store'),
        src('prisma/migrations/20260503000000_init/.gitkeep'),
        src('.git/HEAD'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.stripped).toContain('prisma/migrations/.DS_Store');
      expect(result.stripped).toContain('prisma/migrations/20260503000000_init/.gitkeep');
      expect(result.stripped).toContain('.git/HEAD');
    });
  });

  describe('Files outside prisma/migrations/ are preserved', () => {
    it('preserves manifest.jwt, package.json, dist/index.js as-is', () => {
      const result = normalizeMigrations([
        src('manifest.jwt', 'jwt-content'),
        src('package.json', '{}'),
        src('dist/index.js', 'module.exports = {}'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(3);
      expect(result.files.map((f) => f.zipPath).sort()).toEqual([
        'dist/index.js',
        'manifest.jwt',
        'package.json',
      ]);
    });

    it('preserves UI bundles under dist/ui/', () => {
      const result = normalizeMigrations([src('dist/ui/admin.js', 'iife-bundle')]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.zipPath).toBe('dist/ui/admin.js');
    });
  });

  describe('Error cases (fatal)', () => {
    it('rejects unexpected subdir under prisma/migrations/ (not Prisma native pattern)', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/sub/folder/with/migration.sql'),
      ]);

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('MODULE_LINT_FAILED');
      expect(result.errors[0]!.message).toContain('prisma/migrations/');
    });

    it('rejects non-.sql file directly under prisma/migrations/', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260503000000_init.sql'),
        src('prisma/migrations/random.txt', 'not sql'),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('MODULE_LINT_FAILED');
      expect(result.errors[0]!.message).toContain('no-SQL');
    });

    it('detects collision after flatten: two Prisma-native dirs producing same flattened name', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/20260503000000_init/migration.sql', '-- A'),
        src('prisma/migrations/20260503000000_init.sql', '-- B'),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('MODULE_LINT_FAILED');
      expect(result.errors[0]!.message).toContain('Colisión');
    });

    it('rejects filenames with illegal characters after flatten', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/bad name with spaces/migration.sql'),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('MODULE_LINT_FAILED');
      expect(result.errors[0]!.message).toMatch(/inválido/i);
    });

    it('rejects filenames with illegal characters in flat layout', () => {
      const result = normalizeMigrations([
        src('prisma/migrations/with spaces.sql'),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('MODULE_LINT_FAILED');
    });
  });

  describe('Empty / edge cases', () => {
    it('returns empty result for empty input', () => {
      const result = normalizeMigrations([]);
      expect(result.files).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.stripped).toEqual([]);
    });

    it('handles backend-only module (no migrations) correctly', () => {
      const result = normalizeMigrations([
        src('manifest.jwt'),
        src('package.json'),
        src('dist/index.js'),
      ]);

      expect(result.errors).toEqual([]);
      expect(result.files).toHaveLength(3);
    });
  });
});
