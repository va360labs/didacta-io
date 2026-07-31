/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { FastifyRequest } from 'fastify';

/**
 * Datos del cliente HTTP que enriquecen los registros de audit log.
 *
 * - `ip`: IP del cliente. Si la request llegó a través de un proxy reverso
 *   (Nginx, Traefik, Cloudflare), se respeta el primer valor de
 *   `x-forwarded-for` antes de caer al socket. Truncamos a 64 chars para
 *   acotar el tamaño del campo en DB.
 * - `userAgent`: header `user-agent` tal cual llega del cliente, truncado a
 *   500 chars (UA strings de bots y navegadores legacy pueden ser absurdamente
 *   largas).
 *
 * Si la cabecera `x-forwarded-for` trae varios valores separados por coma
 * (`client, proxy1, proxy2`), nos quedamos con el PRIMERO — la IP original
 * del cliente. El resto son saltos intermedios.
 *
 * Devuelve null en cada campo si la información no está disponible (tests
 * sin Fastify, requests internas, etc.). El caller decide si propaga null
 * o lo convierte en undefined.
 */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

const IP_MAX = 64;
const UA_MAX = 500;

export function extractClientContext(req: Pick<FastifyRequest, 'headers' | 'ip'>): ClientContext {
  const headers = req.headers ?? {};
  const xff = headers['x-forwarded-for'];
  let ip: string | null = null;

  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) ip = first;
  } else if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0]?.split(',')[0]?.trim();
    if (first) ip = first;
  }

  if (!ip && typeof req.ip === 'string' && req.ip.length > 0) {
    ip = req.ip;
  }

  if (ip && ip.length > IP_MAX) ip = ip.slice(0, IP_MAX);

  let userAgent: string | null = null;
  const ua = headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) {
    userAgent = ua.length > UA_MAX ? ua.slice(0, UA_MAX) : ua;
  }

  return { ip, userAgent };
}
