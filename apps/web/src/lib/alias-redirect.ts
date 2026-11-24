/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Dirección ANTERIOR de un aula (su administrador cambió el subdominio): las
 * páginas pedidas por ahí se mandan con 308 a la dirección de ahora, con la
 * misma ruta y la misma query (`?ref=`, `?token=` de un correo viejo…). La
 * API la marca en `GET /tenancy/resolve` con `redirectTo`.
 *
 * `/api/*` nunca llega aquí (el matcher del middleware lo excluye): webhooks
 * de Stripe o Zoom y clientes MCP registrados con la dirección vieja siguen
 * respondiendo sin redirección.
 */

/** Un hostname y nada más: lo que no lo sea no se usa como destino. */
const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** El `redirectTo` de la API, solo si es un hostname limpio; si no, null. */
export function sanitizeRedirectHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  return host.length <= 253 && HOSTNAME_RE.test(host) ? host : null;
}

interface HeaderReader {
  get(name: string): string | null;
}

function first(value: string | null): string | null {
  const v = value?.split(',')[0]?.trim();
  return v ? v : null;
}

/**
 * La URL de destino: la misma que se pidió con el host de ahora.
 *
 * El esquema sale de `X-Forwarded-Proto` (detrás del proxy la web habla
 * http consigo misma, pero quien navega va por https) y el puerto, del host
 * que se pidió: en producción no lleva, y en local (`vieja.localhost:3010`)
 * la dirección nueva vive en el mismo puerto.
 */
export function aliasRedirectUrl(current: URL, target: string, headers: HeaderReader): URL {
  const url = new URL(current.href);
  const proto = first(headers.get('x-forwarded-proto'));
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const rawHost = first(headers.get('x-forwarded-host')) ?? first(headers.get('host'));
  const port = rawHost && !rawHost.startsWith('[') ? (rawHost.split(':')[1] ?? '') : '';
  url.hostname = target;
  url.port = /^\d{1,5}$/.test(port) ? port : '';
  return url;
}
