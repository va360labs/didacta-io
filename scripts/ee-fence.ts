#!/usr/bin/env tsx
/**
 * ee-fence.ts — Open-core fence validator
 *
 * Garantiza que la convención `.ee` no se rompa:
 *
 *   1. Archivos con sufijo `.ee.ts/tsx/js/jsx/json` o dentro de carpetas
 *      `ee/` o `*.ee/` están bajo Didacta Enterprise License.
 *   2. Archivos de Community NO pueden importar archivos `.ee` de forma
 *      estática. Solo dynamic imports detrás de LicenseService.
 *   3. Archivos `.ee` deben tener cabecera `LicenseRef-Didacta-Enterprise`.
 *   4. Archivos no-`.ee` no deben tener cabecera EE (typo / rename roto).
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
          violations.push({
            file: relPath,
            severity: 'error',
            reason: `Static import of EE target "${target}" from non-EE file. Use dynamic import behind LicenseService.`,
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

  console.log(`ee-fence: ${files.length} files scanned, ${errors.length} error(s), ${warnings.length} warning(s).\n`);
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
