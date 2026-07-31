#!/usr/bin/env -S node --import tsx
/* eslint-disable no-console */
/**
 * scripts/local-validate-zip.ts — Validador local del pipeline marketplace.
 *
 * Reproduce TODO lo que `apps/api/src/marketplace/install-package.service.ts`
 * hace ANTES de aceptar un ZIP en `/admin/modules/install`. Sirve para que
 * publishers detecten en local (segundos, sin gastar KMS calls ni ciclos
 * de drag&drop UI) si su ZIP es instalable.
 *
 * Pasos validados (mismo orden y código que el host):
 *   1. Estructura mínima del ZIP (manifest.jwt + package.json + dist/index.js).
 *   2. Verify firma ES256 del `manifest.jwt` contra la pubkey embebida en el repo.
 *   3. Schema `.strict()` del manifest contra `moduleManifestSchema`.
 *   4. Consistencia cruzada `name ↔ tablePrefix ↔ apiNamespace`.
 *   5. `vendor === 'didacta'`.
 *   6. `coreVersionRequired` compatible con la versión target.
 *   7. Migrations: planas (sin subdir/traversal).
 *   8. `lintMigrationSql` por cada migration con el `tablePrefix` del manifest.
 *
 * Si algo falla, imprime el error tipado del host con detalle.
 *
 * Uso:
 *   pnpm tsx scripts/local-validate-zip.ts <ruta-zip> [coreVersion]
 *
 * Ejemplo:
 *   pnpm tsx scripts/local-validate-zip.ts \
 *     ./output/mod.foo-1.0.0.zip 0.0.0
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';
import { jwtVerify, importSPKI } from 'jose';
import {
  moduleManifestSchema,
  validateManifestConsistency,
} from '../src/marketplace/module-manifest.schema';
import { lintMigrationSql } from '../src/marketplace/sql-lint';

const REQUIRED_ZIP_FILES = ['manifest.jwt', 'package.json', 'dist/index.js'];
const MIGRATIONS_PREFIX = 'prisma/migrations/';
const SQL_RE = /\.sql$/i;

const PUBKEY_CANDIDATES = [
  '../../packages/license-sdk/src/public-keys/didacta-issuer-2026.pem',
  '../../packages/license-sdk/public-keys/didacta-issuer-2026.pem',
  'packages/license-sdk/src/public-keys/didacta-issuer-2026.pem',
  'packages/license-sdk/public-keys/didacta-issuer-2026.pem',
];

interface CliArgs {
  zipPath: string;
  coreVersion: string;
}

function parseArgs(argv: string[]): CliArgs {
  const zipPath = argv[0];
  if (!zipPath) {
    console.error('uso: pnpm tsx scripts/local-validate-zip.ts <ruta-zip> [coreVersion]');
    process.exit(2);
  }
  return {
    zipPath: resolve(zipPath),
    coreVersion: argv[1] ?? '0.0.0',
  };
}

function loadPubkey(): string {
  for (const candidate of PUBKEY_CANDIDATES) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error(
    `No encontré la pubkey en ningún path conocido. Probé: ${PUBKEY_CANDIDATES.join(', ')}`,
  );
}

/// Reproduce `isCoreVersionCompatible` de `module-package.service.ts`.
/// Soporta `^X.Y.Z`, `~X.Y.Z` y exact match. Cualquier otro operador =
/// no compatible (mismo comportamiento defensivo del host).
function isCoreVersionCompatible(required: string, current: string): boolean {
  const m = required.match(/^([\^~])?\s?(\d+)\.(\d+)\.(\d+)/);
  const c = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m || !c) return false;
  const op = m[1] ?? '';
  const mMaj = Number(m[2]);
  const mMin = Number(m[3]);
  const mPat = Number(m[4]);
  const cMaj = Number(c[1]);
  const cMin = Number(c[2]);
  const cPat = Number(c[3]);
  if (op === '^') {
    if (mMaj === 0 && mMin === 0) {
      // ^0.0.x acepta solo exact en x: comportamiento "estricto" para 0.0.x
      // En la práctica el host de alpha.38 trata ^0.0.0 contra '0.0.0' como compatible.
      return cMaj === 0 && cMin === 0 && cPat >= mPat;
    }
    if (mMaj === 0) return cMaj === 0 && cMin === mMin && cPat >= mPat;
    return cMaj === mMaj && (cMin > mMin || (cMin === mMin && cPat >= mPat));
  }
  if (op === '~') return cMaj === mMaj && cMin === mMin && cPat >= mPat;
  return required === current;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.zipPath)) {
    console.error(`✗ ZIP no encontrado: ${args.zipPath}`);
    process.exit(1);
  }

  const buf = readFileSync(args.zipPath);
  const zip = new AdmZip(buf);
  const entryNames = zip.getEntries().map((e) => e.entryName);

  // 1. Estructura mínima
  const missing = REQUIRED_ZIP_FILES.filter((f) => !entryNames.includes(f));
  if (missing.length) {
    console.error(`✗ PACKAGE_INVALID: faltan archivos requeridos: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ estructura mínima (${entryNames.length} entries)`);

  // 2. Firma ES256
  const jwt = zip.readAsText('manifest.jwt').trim();
  const pem = loadPubkey();
  const key = await importSPKI(pem, 'ES256');
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(jwt, key, {
      issuer: 'didacta.io',
      audience: 'didacta-marketplace',
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ SIGNATURE_VERIFY_FAILED: ${msg}`);
    process.exit(1);
  }
  console.log('✓ firma ES256 (kid didacta-issuer-2026)');

  // 3. Schema strict
  const { iss, aud, iat, exp, nbf, sub, jti, ...stripped } = payload;
  const parsed = moduleManifestSchema.safeParse(stripped);
  if (!parsed.success) {
    console.error('✗ MANIFEST_SCHEMA_INVALID:');
    for (const issue of parsed.error.issues) {
      console.error(`    ${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    process.exit(1);
  }
  console.log('✓ manifest schema (strict)');

  // 4. Consistencia cruzada
  const consistencyErrors = validateManifestConsistency(parsed.data);
  if (consistencyErrors.length) {
    console.error('✗ MANIFEST_INCONSISTENT:');
    for (const e of consistencyErrors) console.error(`    ${e}`);
    process.exit(1);
  }
  console.log('✓ consistencia name ↔ tablePrefix ↔ apiNamespace');

  // 5. Vendor
  if (parsed.data.vendor !== 'didacta') {
    console.error(`✗ VENDOR_NOT_TRUSTED: vendor "${parsed.data.vendor}" no aceptado en MVP.`);
    process.exit(1);
  }
  console.log(`✓ vendor: ${parsed.data.vendor}`);

  // 6. Core version
  if (!isCoreVersionCompatible(parsed.data.coreVersionRequired, args.coreVersion)) {
    console.error(
      `✗ CORE_VERSION_INCOMPATIBLE: módulo requiere ${parsed.data.coreVersionRequired}; instancia corre ${args.coreVersion}.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ coreVersionRequired ${parsed.data.coreVersionRequired} compatible con ${args.coreVersion}`,
  );

  // 7. Migrations planas (anti-traversal)
  const migrations: { filename: string; sql: string }[] = [];
  for (const e of zip.getEntries()) {
    if (!e.entryName.startsWith(MIGRATIONS_PREFIX)) continue;
    const filename = e.entryName.slice(MIGRATIONS_PREFIX.length);
    if (!SQL_RE.test(filename)) continue;
    const slash = String.fromCharCode(47);
    const bslash = String.fromCharCode(92);
    if (filename.includes(slash) || filename.includes(bslash) || filename.includes('..')) {
      console.error(
        `✗ MODULE_LINT_FAILED: path de migration inválido "${e.entryName}". Las migrations deben vivir directamente bajo prisma/migrations/.`,
      );
      process.exit(1);
    }
    migrations.push({ filename, sql: zip.readAsText(e) });
  }
  if (migrations.length === 0) {
    console.log('✓ migrations: ninguna (módulo sin tablas propias)');
  } else {
    console.log(`✓ migrations planas: ${migrations.map((m) => m.filename).join(', ')}`);
  }

  // 8. SQL lint por archivo
  for (const m of migrations) {
    try {
      const stmts = lintMigrationSql(m.sql, parsed.data.tablePrefix);
      const counts: Record<string, number> = {};
      for (const s of stmts) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
      console.log(
        `✓ sql-lint ${m.filename}: ${stmts.length} statements (${JSON.stringify(counts)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ MODULE_LINT_FAILED en ${m.filename}: ${msg}`);
      process.exit(1);
    }
  }

  console.log('');
  console.log('✓ TODO el pipeline pasa. ZIP listo para subir a /admin/marketplace.');
}

main().catch((err) => {
  console.error('FAIL inesperado:', err);
  process.exit(1);
});
