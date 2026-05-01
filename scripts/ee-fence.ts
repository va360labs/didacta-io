#!/usr/bin/env tsx
/**
 * ee-fence.ts — Open-core fence validator
 *
 * MODELO WORDPRESS MATIZADO (revisión 2026-04-29):
 * Los archivos `.ee.*` solo pueden vivir DENTRO DEL CORE
 * (`apps/api/src/**`, `packages/core-kernel/**`). Nunca dentro de
 * `modules/*` — todos los módulos son Community y no llevan sufijo.
 *
 * Garantiza que la convención `.ee` no se rompa:
 *
 *   1. Archivos `.ee.*` o dentro de `ee/` solo en paths del CORE.
 *      Si aparecen en `modules/*` → ERROR (módulos siempre CE).
 *   2. Archivos `.ee` están bajo Didacta Enterprise License.
 *   3. Archivos de Community NO pueden importar archivos `.ee` de forma
 *      estática. Solo dynamic imports detrás de LicenseService.
 *   4. Archivos `.ee` deben tener cabecera `LicenseRef-Didacta-Enterprise`.
 *   5. Archivos no-`.ee` no deben tener cabecera EE (typo / rename roto).
 *
 * Uso:
 *   pnpm tsx scripts/ee-fence.ts          # repo entero
 *   pnpm tsx scripts/ee-fence.ts --fix    # añade cabecera EE faltante
 */

import { readFileSync } from 'node:fs';
import { glob } from 'glob';
import { relative, resolve } from 'node:path';

type Severity = 'error' | 'warning';
type Violation = { file: string; severity: Severity; reason: string };

const ROOT = resolve(process.cwd());
const EE_HEADER_MARKER = 'LicenseRef-Didacta-Enterprise';
const SUL_HEADER_MARKER = 'LicenseRef-Didacta-Sustainable-Use';
const FIX = process.argv.includes('--fix');

/**
 * Paths donde un archivo `.ee.*` ES VÁLIDO (CORE).
 * Cualquier `.ee.*` fuera de estos paths se considera violación de modelo.
 */
const EE_ALLOWED_ROOTS = [
  'apps/api/src/',
  'packages/core-kernel/',
  'packages/core-registry/',
  'packages/license-sdk/src/',
];

function isEEAllowedPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return EE_ALLOWED_ROOTS.some((root) => p.startsWith(root));
}

const EE_HEADER_TEMPLATE = `/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Enterprise
 *
 * This file is part of Didacta Enterprise Edition and is licensed under the
 * Didacta Enterprise License (LICENSE_EE). It cannot be used in production
 * without a valid Didacta Enterprise license key. See LICENSE_EE for details.
 */
`;

function isEEPath(filePath: string): boolean {
  // Normaliza separadores
  const p = filePath.replace(/\\/g, '/');
  if (/\.ee\.[a-z]+$/i.test(p)) return true;
  if (/\/ee\//.test(p)) return true;
  if (/\.ee\//.test(p)) return true;
  return false;
}

function checkEEHeader(content: string): boolean {
  // Mira las primeras 30 líneas — debe contener el marker EE
  const head = content.split('\n').slice(0, 30).join('\n');
  return head.includes(EE_HEADER_MARKER);
}

function hasSULHeaderInEE(content: string): boolean {
  const head = content.split('\n').slice(0, 30).join('\n');
  return head.includes(SUL_HEADER_MARKER);
}

function hasEEHeaderInCE(content: string): boolean {
  const head = content.split('\n').slice(0, 30).join('\n');
  return head.includes(EE_HEADER_MARKER);
}

function extractStaticImports(content: string): string[] {
  const imports: string[] = [];
  // import ... from '...' / require('...')
  const importRegex = /^\s*import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/gm;
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) imports.push(m[1]);
  while ((m = requireRegex.exec(content)) !== null) imports.push(m[1]);
  return imports;
}

function importTargetIsEE(target: string): boolean {
  // No detectamos imports de paquetes npm (no nuestros). Solo paths relativos / aliases.
  if (!target.startsWith('.') && !target.startsWith('@didacta/')) return false;
  return /\.ee(\b|\/|$)/.test(target);
}

/**
 * Excepción aceptada del modelo: un archivo `*.module.ts` (NestJS) puede
 * importar siblings `*.ee.ts` para registrarlos en el array `controllers` /
 * `providers` del @Module. Los endpoints EE registrados allí están gateados
 * a runtime por @RequiresCapability — sin licencia válida el LicenseGuard
 * rechaza con 402, así que el bundle puede contener el código EE sin
 * comprometer el modelo.
 *
 * Restricción: solo archivos que terminan en `.module.ts` y solo pueden
 * importar de paths relativos (mismo directorio o subdirectorios).
 */
function isAllowedModuleEEImport(filePath: string, target: string): boolean {
  const isModuleFile = filePath.endsWith('.module.ts') || filePath.endsWith('.module.tsx');
  const isRelative = target.startsWith('./') || target.startsWith('../');
  return isModuleFile && isRelative;
}

async function main() {
  const violations: Violation[] = [];

  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: ROOT,
    ignore: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      '.next/**',
      '**/.next/**',
      'build/**',
      '**/build/**',
      'coverage/**',
      '**/coverage/**',
      '.turbo/**',
      '**/.turbo/**',
      'scripts/ee-fence.ts',
    ],
  });

  for (const relPath of files) {
    const fullPath = resolve(ROOT, relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const isEE = isEEPath(relPath);

    if (isEE) {
      // Regla 1 (modelo WordPress matizado): los archivos .ee solo pueden
      // vivir en paths del CORE. Cualquier .ee dentro de modules/* es violación.
      if (!isEEAllowedPath(relPath)) {
        violations.push({
          file: relPath,
          severity: 'error',
          reason: `EE file outside of allowed core paths. Modules are always Community — move this capability into the core (apps/api/src/, packages/core-kernel/, etc.) or remove the .ee suffix.`,
        });
      }

      // Regla 3: cabecera EE obligatoria
      if (!checkEEHeader(content)) {
        if (FIX) {
          // Añade cabecera al inicio si el archivo no la tiene
          const writeBack = EE_HEADER_TEMPLATE + content;
          require('node:fs').writeFileSync(fullPath, writeBack, 'utf8');
          // continue silently
        } else {
          violations.push({
            file: relPath,
            severity: 'error',
            reason: `EE file missing "${EE_HEADER_MARKER}" header (run --fix to add)`,
          });
        }
      }
      // Cabecera SUL en archivo EE = típico typo
      if (hasSULHeaderInEE(content)) {
        violations.push({
          file: relPath,
          severity: 'error',
          reason: `EE file has SUL header — was the file renamed? Replace SUL header with EE header.`,
        });
      }
    } else {
      // Regla 4: cabecera EE en archivo CE = nombre incorrecto
      if (hasEEHeaderInCE(content)) {
        violations.push({
          file: relPath,
          severity: 'error',
          reason: `Non-EE file has EE header. Either rename the file with .ee suffix or remove the EE header.`,
        });
      }

      // Regla 2: import estático de archivo EE desde archivo CE
      const imports = extractStaticImports(content);
      for (const target of imports) {
        if (importTargetIsEE(target)) {
          if (isAllowedModuleEEImport(relPath, target)) {
            // *.module.ts puede registrar controllers/providers EE — patrón aceptado.
            continue;
          }
          violations.push({
            file: relPath,
            severity: 'error',
            reason: `Static import of EE target "${target}" from non-EE file. Use dynamic import behind LicenseService, or move the import into a *.module.ts that only registers controllers/providers (the accepted exception).`,
          });
        }
      }
    }
  }

  // Salida
  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  if (violations.length === 0) {
    console.log(`✅ ee-fence: ${files.length} files scanned, 0 violations.`);
    process.exit(0);
  }

  console.log(
    `ee-fence: ${files.length} files scanned, ${errors.length} error(s), ${warnings.length} warning(s).\n`,
  );
  for (const v of violations) {
    const icon = v.severity === 'error' ? '❌' : '⚠️ ';
    console.log(`${icon} ${v.file}\n   → ${v.reason}\n`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('ee-fence failed:', err);
  process.exit(2);
});
