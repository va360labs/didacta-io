/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { isReservedSubdomain } from './reserved-subdomains';

/**
 * Reglas puras de la «Dirección de tu academia»: el subdominio con el que se
 * entra al aula (`<etiqueta>.<sufijo>`), que su administrador puede cambiar él
 * solo. Sin base de datos ni Nest: lo que se decide aquí se prueba sin nada.
 */

/** Variable que enciende la función. Sin ella, no existe (ni API útil ni UI). */
export const SUBDOMAIN_SUFFIX_ENV = 'TENANT_SUBDOMAIN_SUFFIX';

/** Cuántos cambios caben en la ventana. */
export const MAX_ADDRESS_CHANGES = 3;
/** Ventana deslizante del límite, en días. */
export const ADDRESS_CHANGE_WINDOW_DAYS = 30;

/** Acción del audit log con la que se registra cada cambio (y se cuentan). */
export const ADDRESS_CHANGED_ACTION = 'academy.address.changed';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Etiqueta DNS que se admite como dirección: minúsculas, números y guiones,
 * sin guion al principio ni al final, de 3 a 63 caracteres. Más estrecha que el
 * `SLUG_RE` del alta (que admite 1 carácter): una dirección de una o dos letras
 * no le sirve a nadie y es la que primero se intentaría acaparar.
 */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/;

/** Sufijo en forma de nombre DNS: `didacta.io`, `localhost`, `aulas.midominio.es`. */
const SUFFIX_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * El sufijo configurado, normalizado, o `null` si la instancia no lo configura
 * (o lo configura mal: un valor que no es un nombre DNS apaga la función en vez
 * de ofrecer direcciones que no resolverían).
 */
export function resolveSubdomainSuffix(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env[SUBDOMAIN_SUFFIX_ENV]?.trim().toLowerCase();
  if (!raw) return null;
  const suffix = raw.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!suffix || suffix.length > 190 || !SUFFIX_RE.test(suffix)) return null;
  return suffix;
}

/** Lo que el administrador escribió, como se compara: sin espacios y en minúsculas. */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase();
}

export type LabelCheck = 'ok' | 'invalid' | 'reserved';

/**
 * ¿Vale como dirección, sin mirar quién la tiene? `invalid` también para las
 * etiquetas punycode (`xn--…`): con ellas se escriben nombres que se parecen a
 * otros con letras de otro alfabeto, que es la suplantación que se quiere
 * evitar.
 */
export function checkLabel(label: string): LabelCheck {
  if (!LABEL_RE.test(label) || label.startsWith('xn--')) return 'invalid';
  if (isReservedSubdomain(label)) return 'reserved';
  return 'ok';
}

export function hostnameFor(label: string, suffix: string): string {
  return `${label}.${suffix}`;
}

/**
 * La etiqueta de un hostname que cuelga directamente del sufijo, o `null` si no
 * es una dirección del sufijo (un dominio propio, el `localhost` de una
 * instalación, un nivel de más).
 */
export function labelOf(hostname: string | null | undefined, suffix: string): string | null {
  if (!hostname) return null;
  const host = hostname.trim().toLowerCase();
  const tail = `.${suffix}`;
  if (!host.endsWith(tail)) return null;
  const label = host.slice(0, -tail.length);
  if (!label || label.includes('.')) return null;
  return label;
}

/**
 * El límite de cambios a partir de las fechas de los cambios recientes.
 *
 * Ventana deslizante: cuenta los de los últimos `ADDRESS_CHANGE_WINDOW_DAYS`
 * días. Si ya no quedan, `nextChangeAt` es cuándo sale de la ventana el más
 * antiguo de los que cuentan (y con él, vuelve a quedar uno).
 */
export function changeAllowance(
  recentChanges: readonly Date[],
  now: Date = new Date(),
): { used: number; left: number; nextChangeAt: Date | null } {
  const since = now.getTime() - ADDRESS_CHANGE_WINDOW_DAYS * DAY_MS;
  const inWindow = recentChanges
    .map((d) => d.getTime())
    .filter((t) => t > since)
    .sort((a, b) => a - b);
  const used = inWindow.length;
  const left = Math.max(0, MAX_ADDRESS_CHANGES - used);
  const oldestThatCounts = inWindow[used - MAX_ADDRESS_CHANGES];
  const nextChangeAt =
    left === 0 && oldestThatCounts !== undefined
      ? new Date(oldestThatCounts + ADDRESS_CHANGE_WINDOW_DAYS * DAY_MS)
      : null;
  return { used, left, nextChangeAt };
}

/** Desde cuándo hay que mirar el audit log para contar los cambios. */
export function changeWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - ADDRESS_CHANGE_WINDOW_DAYS * DAY_MS);
}
