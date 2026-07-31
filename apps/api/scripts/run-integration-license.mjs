#!/usr/bin/env node
/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Orquestador del runner de integración del LicenseGuard (MIG-034).
 *
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. vitest run --config vitest.integration.config.ts
 *   3. docker compose -f docker-compose.test.yml down -v   (incluso si 2. falla)
 *
 * El path al compose es relativo a la raíz del repo. El runner se ejecuta
 * con cwd = apps/api (porque vive ahí), así que subimos dos niveles.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'docker-compose.test.yml');

/**
 * Resuelve el binario de Docker. Cuando este script se invoca desde un shell
 * que no expone PATH completo (e.g. git-bash subshell sobre Windows), el
 * `docker` "puro" puede no encontrarse. Probamos primero el PATH; si no
 * funciona, caemos a la ruta canónica de Docker Desktop en Windows.
 */
function resolveDockerBin() {
  if (process.platform !== 'win32') return 'docker';
  const candidates = [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    process.env.DOCKER_BIN,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'docker';
}

const DOCKER_BIN = resolveDockerBin();

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      ...opts,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function composeUp() {
  console.log('\n[integration] docker compose up -d (postgres-test, redis-test)');
  await run(DOCKER_BIN, ['compose', '-f', COMPOSE_FILE, 'up', '-d']);
}

async function composeDown() {
  console.log('\n[integration] docker compose down -v');
  try {
    await run(DOCKER_BIN, ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  } catch (err) {
    console.error('[integration] down failed (no fatal):', err.message);
  }
}

async function runVitest() {
  console.log('\n[integration] vitest run --config vitest.integration.config.ts');
  // Resolvemos vitest dinámicamente para no depender del PATH del shell.
  const req = createRequire(import.meta.url);
  const vitestPkg = req.resolve('vitest/package.json');
  const vitestEntry = resolve(vitestPkg, '..', 'vitest.mjs');
  await run(process.execPath, [vitestEntry, 'run', '--config', 'vitest.integration.config.ts'], {
    cwd: resolve(__dirname, '..'),
  });
}

let exitCode = 0;
try {
  await composeUp();
  await runVitest();
} catch (err) {
  console.error('[integration] suite failed:', err.message);
  exitCode = 1;
} finally {
  await composeDown();
}

process.exit(exitCode);
