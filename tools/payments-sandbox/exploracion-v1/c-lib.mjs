/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Utilidades de la serie `c*`: la compra de extremo a extremo contra una API
 * LOCAL de Didacta (no contra producción). El patrón que reutilizan las etapas
 * siguientes es el de `c4-webhook.mjs`: pagar el checkout, leer el evento real
 * de `/v1/events`, firmarlo con el secreto local y enviarlo, con un control de
 * firma mala.
 *
 * `c-state.json` (fuera de git) guarda el token de sesión del admin de pruebas
 * y el secreto de webhook generado para la API local.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { testKey } from '../lib.mjs';

/** API local contra la que se prueba (ver `scripts/e2e-stack.sh`). */
export const API = process.env.PAYMENTS_SANDBOX_API ?? 'http://localhost:4177';
/** Contenedor del Postgres de esa API, para leer el resultado con psql. */
export const PG_CONTAINER = process.env.PAYMENTS_SANDBOX_PG_CONTAINER ?? 'aud-pagos-pg';
export const HOST_DEMO = 'localhost'; // tenant «demo» (la víctima / el creador)
export const HOST_SMOKE = '127.0.0.1'; // tenant «e2e-smoke» (el otro creador)

export async function api(
  pathname,
  { method = 'GET', body, bearer, host = HOST_DEMO, raw, headers = {} } = {},
) {
  const h = { 'X-Forwarded-Host': host, ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (bearer) h['Authorization'] = `Bearer ${bearer}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: h,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

/** Cabecera `Stripe-Signature` de un cuerpo crudo. */
export function sign(rawBody, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export const stFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'c-state.json');
export const load = () => {
  try {
    return JSON.parse(fs.readFileSync(stFile, 'utf8'));
  } catch {
    return {};
  }
};
export const save = (s) => fs.writeFileSync(stFile, JSON.stringify(s, null, 2));
export const log = (l, o) => console.log(l, JSON.stringify(o));
