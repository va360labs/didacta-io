/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * La IP del cliente reducida a una clave de cubo: la usan el rate limit
 * general (`rate-limit.interceptor.ts`) y el del acceso (`login-limit.*`).
 */

import { createHash } from 'node:crypto';

/**
 * Sal del hash. `AUTH_SECRET` ya es un secreto por instancia, así que dos
 * despliegues no producen las mismas claves y nadie que vea Redis puede
 * revertir el hash por fuerza bruta sobre el espacio IPv4.
 */
export function rateLimitHashSalt(): string {
  return process.env['AUTH_SECRET'] ?? 'didacta-rate-limit';
}

/** Hash corto y con sal de un valor (IP, correo): nada en claro en Redis. */
export function saltedDigest(value: string): string {
  return createHash('sha256')
    .update(rateLimitHashSalt())
    .update(':')
    .update(value)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Reduce una IPv6 a su prefijo /64. Un cliente doméstico con IPv6 tiene una
 * /64 entera para él: limitar por dirección exacta sería regalar miles de
 * cubos a la misma persona. En IPv4 se usa la dirección completa.
 */
export function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  // `::ffff:1.2.3.4` — IPv4 mapeada, se trata como IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  const groups = ip.split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}

/**
 * Clave de la IP del cliente (`request.ip`, que Fastify resuelve con
 * `trustProxy`), o `null` si no hay IP (transporte no-TCP, tests).
 */
export function clientIpKey(ip: unknown): string | null {
  const raw = typeof ip === 'string' ? ip.trim() : '';
  if (!raw) return null;
  return saltedDigest(normalizeIp(raw));
}
