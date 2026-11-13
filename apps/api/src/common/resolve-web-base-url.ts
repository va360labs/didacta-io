/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Resuelve la URL base pública del frontend (web) para construir links
 * absolutos en emails (reset de contraseña, invitación, bienvenida).
 *
 * Motivación: depender únicamente de `WEB_PUBLIC_URL` es frágil — si la env
 * var no está set (o quedó con un valor de dev), los links de email salen como
 * `http://localhost:3000`, inservibles en producción. Esta función pura
 * resuelve la base con una cascada robusta:
 *
 *   1. `tenantPrimaryHostname` si se pasa: el dominio primario **verificado**
 *      del tenant (`TenantDomain.isPrimary`), resuelto por el caller (ver
 *      `TenantResolverService.resolveTenantWebBaseUrl`). Sale de nuestra base,
 *      no de la petición. Incluye el subdominio de plataforma
 *      (`<slug>.didacta.io`) que crea el aprovisionamiento: nace verificado.
 *   2. `process.env.WEB_PUBLIC_URL` si está set y es una URL http/https válida
 *      (la dirección del DESPLIEGUE: respaldo cuando el aula no tiene dominio).
 *   3. Derivar del request entrante: `${proto}://${host}` usando los headers
 *      `X-Forwarded-Proto` / `X-Forwarded-Host` que Traefik (el reverse proxy
 *      delante de la API) inyecta — p.ej. `x-forwarded-host=dev.didacta.io`,
 *      `x-forwarded-proto=https`. Si no están, cae a los headers normales
 *      (`host` + el protocolo del propio request).
 *   4. Fallback final `http://localhost:3000` (solo dev / tests sin proxy).
 *
 * Importante: el host derivado del request apunta al dominio del **frontend**
 * solo si la API y el web comparten dominio (caso de Traefik con un único host
 * por tenant, que es el setup de Didacta). Por eso la env var gana al Host
 * cuando está bien configurada — la derivación es la red de seguridad.
 *
 * Un enlace que lleva un token (bienvenida, restablecer contraseña, acceso de
 * soporte, callbacks de SSO) no usa esta función tal cual: o le pasa el
 * dominio del aula, o usa `resolveWebBaseUrlForAuthRedirect`, que nunca se fía
 * del Host sin allowlist.
 */

/** Forma mínima del request que la función necesita. Compatible con FastifyRequest. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  /** Fastify expone `protocol` ('http' | 'https'); puede no estar en mocks. */
  protocol?: string;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `localhost` (con o sin puerto) usa http; cualquier otro dominio real usa https. */
function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.startsWith('localhost:');
}

/**
 * Devuelve la base URL del web SIN trailing slash. Pura: no lee globals salvo
 * `process.env.WEB_PUBLIC_URL`, no muta nada. `tenantPrimaryHostname` (si se
 * pasa) es el dominio primario verificado del tenant, ya resuelto por el
 * caller — esta función no hace I/O.
 */
export function resolveWebBaseUrl(
  req?: RequestLike,
  tenantPrimaryHostname?: string | null,
): string {
  // 1) Dominio primario VERIFICADO del tenant (TenantDomain.isPrimary).
  //
  // Va primero, y el orden importa: antes ganaba `WEB_PUBLIC_URL` y este bloque
  // era código muerto en cuanto la variable estuviera puesta — que es siempre en
  // un despliegue multi-tenant. Resultado: los correos de TODAS las aulas
  // (restablecer contraseña, invitaciones, avisos) enlazaban al dominio del
  // pool, así que el cliente aterrizaba en un aula que no es la suya, ponía la
  // contraseña y luego el login le decía «credenciales inválidas» porque su
  // usuario no existe en ese tenant.
  //
  // `WEB_PUBLIC_URL` es la dirección del DESPLIEGUE, no la del tenant: sirve
  // como respaldo cuando no hay dominio de tenant (instalación de un solo
  // inquilino), no como override de uno que sí lo tiene.
  //
  // No abre un vector de suplantación: este hostname no lo elige quien llama,
  // sale de nuestra base y solo si está marcado primario y verificado. Los
  // redirects que llevan tokens usan `resolveWebBaseUrlForAuthRedirect`, que
  // mantiene su propia allowlist y no cambia aquí.
  if (tenantPrimaryHostname) {
    const proto = isLocalHostname(tenantPrimaryHostname) ? 'http' : 'https';
    return `${proto}://${tenantPrimaryHostname}`;
  }

  // 2) Env var explícita del despliegue.
  const fromEnv = process.env.WEB_PUBLIC_URL?.trim();
  if (fromEnv && isValidHttpUrl(fromEnv)) {
    return stripTrailingSlash(fromEnv);
  }

  // 3) Derivar del request (Traefik inyecta X-Forwarded-*).
  if (req) {
    const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers['host']);
    if (host && host.length > 0) {
      const proto =
        firstHeader(req.headers['x-forwarded-proto']) ??
        (req.protocol && req.protocol.length > 0 ? req.protocol : 'https');
      // Si el cliente manda una lista en X-Forwarded-Proto ('https, http'),
      // nos quedamos con el primer valor.
      const cleanProto = (proto.split(',')[0] ?? proto).trim();
      return stripTrailingSlash(`${cleanProto}://${host}`);
    }
  }

  // 4) Fallback dev.
  return 'http://localhost:3000';
}

/**
 * Variante de `resolveWebBaseUrl` para envíos SIN PETICIÓN: workers, bridges de
 * eventos y el hub de notificaciones. Misma prioridad —el dominio primario
 * verificado del tenant gana a `WEB_PUBLIC_URL`— pero con dos diferencias que
 * salen de no tener `req`:
 *
 *   - no hay Host del que derivar nada;
 *   - sin dominio de tenant ni `WEB_PUBLIC_URL` devuelve `''`, no
 *     `http://localhost:3000`. Las plantillas de fondo envuelven cada enlace en
 *     una sección (`{{#classUrl}}…{{/classUrl}}`) y el hub omite el botón cuando
 *     no hay base: un correo sin enlace es mejor que uno que manda al alumno a
 *     `localhost`.
 *
 * Devuelve la base SIN barra final.
 */
export function resolveWebBaseUrlForBackground(tenantPrimaryHostname?: string | null): string {
  if (tenantPrimaryHostname) {
    const proto = isLocalHostname(tenantPrimaryHostname) ? 'http' : 'https';
    return `${proto}://${tenantPrimaryHostname}`;
  }
  const fromEnv = process.env.WEB_PUBLIC_URL?.trim();
  if (fromEnv && isValidHttpUrl(fromEnv)) {
    return fromEnv.replace(/\/+$/, '');
  }
  return '';
}

/**
 * Variante ENDURECIDA de `resolveWebBaseUrl` para redirects que PORTAN TOKENS de
 * sesión (callbacks SSO: WP-SSO, etc.). A diferencia de `resolveWebBaseUrl` —que
 * deriva del host del request a propósito para los links de email—, esta NUNCA
 * confía en el header `Host`/`X-Forwarded-Host` salvo que el host esté en una
 * allowlist explícita (`WEB_PUBLIC_ALLOWED_HOSTS`, CSV). Así un atacante que
 * controle el `Host` del request NO puede desviar `accessToken`/`refreshToken`
 * a un host arbitrario (open-redirect con exfiltración de tokens). Cascada:
 *
 *   1. `tenantPrimaryHostname`: el dominio primario verificado del aula a la
 *      que pertenece el token. Sale de una fila de NUESTRA base (el
 *      aprovisionamiento la crea verificada; un dominio propio pasa antes por
 *      DNS), no de un header que el cliente controla, así que se acepta sin
 *      pasar por la allowlist.
 *   2. `WEB_PUBLIC_URL` si es una URL http/https válida: el respaldo de una
 *      instalación cuyo tenant no tiene dominio.
 *   3. Derivar del request SOLO si el host está en `WEB_PUBLIC_ALLOWED_HOSTS`.
 *   4. Fallback dev `http://localhost:3000` (constante, no controlable por el atacante).
 *
 * El dominio del aula va ANTES que `WEB_PUBLIC_URL` (hasta noviembre de 2026
 * iba después). En un servidor con varias aulas `WEB_PUBLIC_URL` es la del
 * despliegue —en Didacta Cloud, `pool.didacta.io`—, y un enlace con el token de
 * un aula apuntando ahí no sirve: el acceso de soporte y los callbacks de SSO
 * aterrizaban en un aula que no era la suya. Es el mismo arreglo que
 * `resolveWebBaseUrl` recibió en agosto, y no relaja nada: el Host de la
 * petición sigue sin decidir adónde va un token.
 */
export function resolveWebBaseUrlForAuthRedirect(
  req?: RequestLike,
  tenantPrimaryHostname?: string | null,
): string {
  if (tenantPrimaryHostname) {
    const proto = isLocalHostname(tenantPrimaryHostname) ? 'http' : 'https';
    return `${proto}://${tenantPrimaryHostname}`;
  }

  const fromEnv = process.env.WEB_PUBLIC_URL?.trim();
  if (fromEnv && isValidHttpUrl(fromEnv)) {
    return stripTrailingSlash(fromEnv);
  }

  if (req) {
    const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers['host']);
    if (host && isAllowedWebHost(host)) {
      const proto =
        firstHeader(req.headers['x-forwarded-proto']) ??
        (req.protocol && req.protocol.length > 0 ? req.protocol : 'https');
      const cleanProto = (proto.split(',')[0] ?? proto).trim();
      return stripTrailingSlash(`${cleanProto}://${host}`);
    }
  }

  // Sin env válida y host no confiable: NO emitir tokens a un host arbitrario.
  return 'http://localhost:3000';
}

/**
 * True si `host` está en la allowlist `WEB_PUBLIC_ALLOWED_HOSTS` (CSV). Sin la
 * env definida, ningún host derivado del request es confiable para tokens.
 */
function isAllowedWebHost(host: string): boolean {
  const raw = process.env.WEB_PUBLIC_ALLOWED_HOSTS;
  if (!raw) return false;
  const normalized = host.trim().toLowerCase();
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
    .includes(normalized);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
