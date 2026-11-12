/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Primera tanda de pruebas del sandbox (2026-11-12): comparación de los tres
 * modelos de Connect —cargos directos (A), cargos de destino (B) y cobro y
 * transferencia separados (C)— antes de elegir el C. Se conserva como
 * evidencia de por qué se descartaron A y B (ADR-049). La serie `c*` prueba
 * la compra de extremo a extremo contra una API local.
 *
 * La clave y la llamada a Stripe son las de `../lib.mjs`; aquí solo cambia el
 * fichero de estado, que es propio de esta carpeta.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { stripe, sleep, log, testKey } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const stateFile = path.join(HERE, 'state.json');
export const seedFile = path.join(HERE, 'state.seed.json');

export function loadState() {
  for (const file of [stateFile, seedFile]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // siguiente
    }
  }
  return {};
}

export function saveState(s) {
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}
