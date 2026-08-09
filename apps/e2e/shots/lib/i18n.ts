/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Resolución de copy por idioma para los selectores de las capturas.
 *
 * Un selector `getByRole('button', { name: 'Publicar' })` solo funciona en
 * español. En vez de duplicar los recorridos, se leen los MISMOS catálogos que
 * consume la app (`apps/web/src/i18n/messages/<es|en>/<namespace>.json`) y se
 * pide la clave: la tanda inglesa busca por el texto inglés de verdad, sin
 * listas paralelas que se desincronicen.
 *
 * Efecto secundario útil: si una clave existe en `es` y falta en `en`, esto
 * revienta con un error explícito — que es justo lo que quieres saber antes de
 * publicar una captura inglesa a medio traducir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CATALOG } from './config';

const MESSAGES_DIR = path.resolve(__dirname, '..', '..', '..', 'web', 'src', 'i18n', 'messages');

const cache = new Map<string, Record<string, unknown>>();

function loadNamespace(namespace: string): Record<string, unknown> {
  const cacheKey = `${CATALOG}/${namespace}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const file = path.join(MESSAGES_DIR, CATALOG, `${namespace}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`[shots] No existe el catálogo ${CATALOG}/${namespace}.json (${file})`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  cache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Devuelve el texto de `namespace` + `key` (con puntos) en el idioma activo.
 *
 * ```ts
 * t('auth', 'setup.welcomeCta') // es → "Empezar configuración" · en → "Start setup"
 * ```
 */
export function t(namespace: string, key: string, values?: Record<string, string>): string {
  let node: unknown = loadNamespace(namespace);
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`[shots] Clave i18n inexistente: ${namespace}.${key} (${CATALOG})`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'string') {
    throw new Error(
      `[shots] Clave i18n inexistente o no textual: ${namespace}.${key} (${CATALOG})`,
    );
  }
  if (!values) return node;
  // Interpolación mínima estilo ICU simple: `{nombre}`.
  return node.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * Igual que `t()` pero escapando el resultado para usarlo dentro de un regex
 * (`getByLabel(new RegExp(...))`), que es lo que hace falta cuando el label
 * lleva un asterisco de obligatorio o paréntesis.
 */
export function tRe(namespace: string, key: string): RegExp {
  const literal = t(namespace, key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(literal, 'i');
}
