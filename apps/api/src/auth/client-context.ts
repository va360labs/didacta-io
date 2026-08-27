/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { FastifyRequest } from 'fastify';

/**
 * Datos del cliente HTTP que enriquecen los registros de audit log.
 *
 * - `ip`: la IP que resuelve Fastify (`request.ip`), truncada a 64 chars para
 *   acotar el campo en DB.
 * - `userAgent`: header `user-agent` tal cual llega, truncado a 500 chars (las
 *   UA de bots y navegadores legacy pueden ser absurdamente largas).
 *
 * ── Por qué NO se lee `x-forwarded-for` ─────────────────────────────────────
 *
 * Antes esta función leía el header crudo y se quedaba con su primera entrada,
 * cayendo a `request.ip` solo si no había header. Eso significaba que **la IP
 * del registro de auditoría la elegía quien hacía la petición**: basta con
 * mandar `X-Forwarded-For: 1.2.3.4` para que el rastro diga 1.2.3.4. Un log de
 * auditoría cuyo contenido escribe el auditado no es un log de auditoría.
 *
 * `request.ip` no es lo mismo: Fastify lo deriva del XFF **solo hasta donde
 * `trustProxy` le autoriza**, y ese valor se declara en `main.ts` con
 * `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_IPS` según cuántos proxies propios haya
 * delante. Con la configuración correcta, las entradas que añade un cliente
 * quedan fuera; sin proxy declarado, se usa la IP del socket, que no se puede
 * falsificar en una conexión TCP establecida.
 *
 * Es el mismo defecto que se corrigió en el cubo del rate limit, en otro
 * sumidero: allí la IP falseada dejaba elegir cubo, aquí deja firmar el rastro
 * con el nombre de otro. Si alguna vez hace falta el XFF crudo para diagnóstico,
 * va a un campo APARTE y marcado como no fiable — nunca al que se audita.
 *
 * Devuelve null si la información no está disponible (tests sin Fastify,
 * llamadas internas). El caller decide si propaga null o lo pasa a undefined.
 */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

const IP_MAX = 64;
const UA_MAX = 500;

export function extractClientContext(req: Pick<FastifyRequest, 'headers' | 'ip'>): ClientContext {
  const headers = req.headers ?? {};

  // Solo `request.ip`. El header crudo NO se mira: ver la nota de arriba.
  let ip: string | null = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : null;

  if (ip && ip.length > IP_MAX) ip = ip.slice(0, IP_MAX);

  let userAgent: string | null = null;
  const ua = headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) {
    userAgent = ua.length > UA_MAX ? ua.slice(0, UA_MAX) : ua;
  }

  return { ip, userAgent };
}
