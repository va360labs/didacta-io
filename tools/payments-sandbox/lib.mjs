/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Utilidades de los scripts del SANDBOX de cobros de plataforma.
 *
 * Estos scripts hablan con la API de Stripe de verdad, en MODO DE PRUEBA. Con
 * ellos se verificó el diseño de mod.payouts el 2026-11-12 (cobro y
 * transferencia separados, comisión del 5 %) y de ellos salen los importes de
 * `modules/payouts/tests/fixtures/sandbox-2026-11-12.json`.
 *
 * La clave NO vive en el repo. Se lee de `~/.config/didacta/stripe-test.key`
 * (un fichero con la clave y nada más) y el script se para si no empieza por
 * `sk_test_` o `rk_test_`: aquí no se usa nunca una clave de producción. La
 * clave no se imprime ni se escribe en ningún fichero.
 *
 * Estado: cada script apunta lo que crea (cuentas, cobros, transferencias) en
 * `state.json`, que está fuera de git porque acaba conteniendo URLs de alta,
 * de checkout y de portal que caducan y dan acceso. Si no existe, se parte de
 * `state.seed.json`: la copia saneada (sin esas URLs) del estado con el que
 * se hizo la verificación, con las cuentas conectadas de prueba ya dadas de
 * alta.
 *
 * Uso:   node tools/payments-sandbox/10-venta-unica.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_FILE = path.join(os.homedir(), '.config/didacta/stripe-test.key');

function readTestKey() {
  let value;
  try {
    value = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    console.error(`PARADA: no se puede leer la clave de prueba en ${KEY_FILE}`);
    process.exit(2);
  }
  if (!(value.startsWith('sk_test_') || value.startsWith('rk_test_'))) {
    console.error('PARADA: la clave no es de prueba');
    process.exit(2);
  }
  return value;
}

const key = readTestKey();

/** La clave de prueba, para quien necesite construir su propio cliente. */
export function testKey() {
  return key;
}

function enc(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v))
      v.forEach((item, i) =>
        typeof item === 'object'
          ? enc(item, `${name}[${i}]`, out)
          : out.push([`${name}[${i}]`, String(item)]),
      );
    else if (typeof v === 'object') enc(v, name, out);
    else out.push([name, String(v)]);
  }
  return out;
}

/** Llamada a la API v1 (formulario). `opts.soft`: devuelve `{ __error }` en vez de lanzar. */
export async function stripe(method, p, params, opts = {}) {
  const headers = { Authorization: `Bearer ${key}` };
  if (opts.account) headers['Stripe-Account'] = opts.account;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  if (opts.version) headers['Stripe-Version'] = opts.version;
  let url = `https://api.stripe.com${p}`;
  let body;
  const pairs = enc(params);
  if (method === 'GET') {
    if (pairs.length) url += '?' + new URLSearchParams(pairs);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(pairs).toString();
  }
  const res = await fetch(url, { method, headers, body });
  const json = await res.json();
  if (!res.ok) {
    const e = new Error(json?.error?.message ?? res.statusText);
    e.stripe = json?.error;
    e.status = res.status;
    if (opts.soft) return { __error: json.error, status: res.status };
    throw e;
  }
  return json;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Estado de trabajo (fuera de git). */
export const stateFile = path.join(HERE, 'state.json');
/** Estado saneado de la verificación del 2026-11-12 (en git). */
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

export function log(label, obj) {
  console.log(label, JSON.stringify(obj));
}
