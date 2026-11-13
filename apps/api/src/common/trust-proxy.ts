/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Resolución de `trustProxy` de Fastify a partir del entorno.
 *
 * Desde Fastify 5.12 un `trustProxy` NUMÉRICO falla cerrado: `request.ip`
 * deja de leer `X-Forwarded-For` y `request.protocol` / `request.hostname`
 * ignoran `X-Forwarded-Proto` / `X-Forwarded-Host`. Con el default de esta
 * API (1 salto, el proxy de terminación TLS) eso hacía que todo el tráfico
 * pareciera venir de la IP del proxy (rate limit anónimo y auditoría
 * rotos) y que HSTS no se emitiera nunca. Por eso el número de saltos se
 * convierte aquí en una función de confianza explícita, con la semántica de
 * siempre: se confían los `n` primeros saltos de la cadena.
 */

export type TrustProxy = boolean | string | ((address: string, hop: number) => boolean);

/**
 * `hops` proxies propios delante de la API. `0` = ninguno: no te creas ningún
 * `X-Forwarded-*`.
 */
export function hopsTrustProxy(hops: number): TrustProxy {
  if (hops <= 0) return false;
  return (_address: string, hop: number) => hop < hops;
}

/**
 * Cuánto del `X-Forwarded-For` entrante nos creemos.
 *
 * Estaba en `true`, que significa "confía en la cadena entera": cualquiera
 * desde internet podía mandar `X-Forwarded-For: 1.2.3.4` y Fastify resolvía
 * `request.ip` a lo que el cliente dijera. Eso vale para falsear la IP del
 * log de auditoría y, desde que el rate limit anónimo va por IP, para
 * saltarse el límite rotando direcciones inventadas o para tirar a otro
 * gastando su cubo.
 *
 * Configurable porque el número de proxies propios depende del despliegue:
 *
 *   - `TRUSTED_PROXY_HOPS=<n>` — número de proxies TUYOS delante de la API.
 *     Fastify descarta las `n` últimas entradas del XFF y se queda con la
 *     anterior. Es lo que quieres con Traefik/Caddy/nginx delante.
 *   - `TRUSTED_PROXY_IPS=<csv>` — IPs o CIDR de los proxies de confianza,
 *     si prefieres declararlos explícitamente.
 *
 * Default 1: un único proxy de terminación TLS, que es el despliegue estándar
 * de las plantillas de `deploy/`. Si tu cadena es más larga, súbelo; si la API
 * está expuesta directamente sin proxy, pon `TRUSTED_PROXY_HOPS=0`.
 */
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): TrustProxy {
  const ips = (env['TRUSTED_PROXY_IPS'] ?? '').trim();
  if (ips) return ips;

  const raw = (env['TRUSTED_PROXY_HOPS'] ?? '').trim();
  if (!raw) return hopsTrustProxy(1);
  const hops = Number.parseInt(raw, 10);
  if (!Number.isFinite(hops) || hops < 0) return hopsTrustProxy(1);
  return hopsTrustProxy(hops);
}
