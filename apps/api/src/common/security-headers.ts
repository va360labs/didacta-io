/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { FastifyInstance } from 'fastify';

/**
 * Cabeceras de seguridad para las respuestas de la API.
 *
 * La aplicación no emitía ninguna globalmente: sólo
 * `storage-file.controller.ts` ponía `CSP: sandbox` y `nosniff` para los
 * ficheros servidos desde disco. El resto se daba por delegado al reverse
 * proxy, y un self-host que no lo configure se queda desnudo sin enterarse.
 *
 * Reportado por Bruno (ingenierosindustriales.com), ver SECURITY-CREDITS.md.
 *
 * Notas de las decisiones:
 *
 *  · `Content-Security-Policy: default-src 'none'` es lo correcto para una
 *    respuesta JSON: no hay nada que cargar. Si un navegador acaba
 *    interpretando una respuesta de la API como documento —que es justo el
 *    escenario que aprovecha un XSS reflejado—, no puede ejecutar nada.
 *  · Se EXCLUYE `/api/docs`: el Swagger UI es un documento real con sus
 *    scripts y estilos, y esa CSP lo dejaría en blanco.
 *  · Se excluyen también los assets de módulos y los ficheros de storage, que
 *    ya declaran las suyas (más restrictivas: `sandbox`).
 *  · `X-Frame-Options: DENY` porque ninguna respuesta de la API debería
 *    pintarse dentro de un frame.
 *  · HSTS sólo se emite si la petición llegó por HTTPS —directamente o vía
 *    `X-Forwarded-Proto` de un proxy en el que confiamos (ver
 *    `resolveTrustProxy` en `main.ts`)—. Emitirla sobre HTTP plano dejaría a
 *    un despliegue interno sin acceso durante todo el `max-age`.
 */

/**
 * Prefijos que sirven documentos o ya traen su propia política.
 *
 * `/api/v1/storage/file` va aquí porque `storage-file.controller.ts` fija una
 * CSP MÁS restrictiva (`sandbox`) para los ficheros subidos, y este hook corre
 * después: sin la exención se la pisaríamos por una más laxa.
 */
const EXEMPT_PREFIXES = ['/api/docs', '/api/v1/storage/file'];

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Un año, el valor que exige la lista de precarga de HSTS. */
const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * `WEB_HSTS=off` apaga la cabecera también aquí, para que un operador la
 * desactive en un solo sitio.
 */
function hstsEnabled(): boolean {
  return process.env['WEB_HSTS'] !== 'off';
}

/**
 * Registra el hook `onSend` que añade las cabeceras. Se usa `onSend` y no un
 * interceptor de Nest a propósito: así también cubre las respuestas que no
 * pasan por el pipeline de Nest (404 del router de Fastify, errores del
 * parser de body, 413 por `bodyLimit`), que son precisamente las que se
 * escapan cuando esto se implementa como interceptor.
 */
export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', (request, reply, payload, done) => {
    const url = (request.url ?? '').split('?')[0] ?? '';

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');

    if (!EXEMPT_PREFIXES.some((p) => url.startsWith(p))) {
      reply.header('Content-Security-Policy', API_CSP);
      reply.header('X-Frame-Options', 'DENY');
    }

    // `request.protocol` ya tiene en cuenta `X-Forwarded-Proto` cuando
    // `trustProxy` lo permite; si no confiamos en el proxy, no nos creemos la
    // cabecera y no emitimos HSTS.
    if (hstsEnabled() && request.protocol === 'https') {
      reply.header('Strict-Transport-Security', HSTS_VALUE);
    }

    done(null, payload);
  });
}
