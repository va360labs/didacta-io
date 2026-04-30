#!/usr/bin/env node
/**
 * Wrapper de didacta-community para invocar el linter del contrato de
 * módulo desde `didacta-skills/scripts/audit-module-contract.mjs`.
 *
 * Asume que didacta-skills está clonado como sibling de didacta-community:
 *   D:/Test/didacta-community/
 *   D:/Test/didacta-skills/
 *
 * Si no está, falla con un mensaje claro.
 *
 * Uso:
 *   node scripts/audit-modules.mjs                    # audita todos los módulos
 *   node scripts/audit-modules.mjs --module fundae    # uno solo
 *   node scripts/audit-modules.mjs --json             # JSON para CI
 *
 * Pass-through de cualquier flag adicional al linter (--only, --skip).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const skillsRoot = resolve(repoRoot, '..', 'didacta-skills');
const linterScript = resolve(skillsRoot, 'scripts', 'audit-module-contract.mjs');
const modulesDir = resolve(repoRoot, 'modules');

if (!existsSync(linterScript)) {
  console.error(`No encuentro el linter en ${linterScript}.`);
  console.error(`Necesitas clonar didacta-skills como sibling:`);
  console.error(`  cd ${resolve(repoRoot, '..')}`);
  console.error(`  git clone <didacta-skills-url>`);
  console.error(``);
  console.error(`Cuando didacta-skills esté disponible públicamente, este wrapper`);
  console.error(`podría sustituirse por una dep npm.`);
  exit(2);
}

if (!existsSync(modulesDir)) {
  console.error(`No existe ${modulesDir}.`);
  exit(2);
}

const linterArgs = ['--modules-dir', modulesDir, ...argv.slice(2)];
const child = spawn(process.execPath, [linterScript, ...linterArgs], {
  stdio: 'inherit',
});

child.on('exit', (code) => {
  exit(code ?? 1);
});
