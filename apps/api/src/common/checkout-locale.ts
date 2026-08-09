/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El idioma con el que el comprador estaba navegando cuando pagó.
 *
 * ── El hueco que cierra ──────────────────────────────────────────────────────
 *
 * Las dos bienvenidas de compra (`membership.welcome`, `billing.welcome`) leen
 * el `locale` de la fila de `user` que el propio webhook acaba de crear. Esa
 * fila tomaba SIEMPRE el default de BD porque nada aguas arriba escribía otro:
 * un comprador anglófono acababa con `es-ES` guardado y recibía el email en
 * español aunque hubiera comprado con la web en inglés — y encima se quedaba
 * con la preferencia equivocada para todo lo demás.
 *
 * ── Por qué la cookie ────────────────────────────────────────────────────────
 *
 * `didacta_locale` es EL idioma activo de la UI: `apps/web/src/i18n/request.ts`
 * la lee para elegir catálogo y `<html lang>`, y en páginas públicas —que es
 * donde vive el checkout anónimo— manda ella («páginas públicas: manda la
 * cookie», `components/locale-sync.tsx`). No es `Accept-Language`, que es el
 * idioma del NAVEGADOR y no el que el visitante eligió en el selector.
 *
 * Llega a la API porque el front pide same-origin (`/api/v1/...`) y Next
 * reescribe a la API reenviando las cabeceras del request (`next.config.mjs`).
 *
 * ── Por qué viaja por la metadata de Stripe ──────────────────────────────────
 *
 * La fila de `user` NO se crea al iniciar el checkout: se crea en el webhook
 * `checkout.session.completed`, después de que el comprador se haya ido a
 * Stripe y haya vuelto. El único canal que sobrevive a ese salto es la
 * metadata de la sesión, que es donde ya viajan `tenantId` y `planId`.
 */

/**
 * Locales que la API acepta persistir. Es la MISMA lista que `ALLOWED_LOCALES`
 * de `auth/me.controller.ts` (y que `SUPPORTED_LOCALES` de la web): se
 * redeclara aquí para no importar un controlador desde `common/`, y hay test de
 * que coinciden.
 */
const CHECKOUT_ALLOWED_LOCALES: readonly string[] = ['es-ES', 'es-AR', 'en-US'];

/** Nombre de la cookie que escribe la web (`apps/web/src/i18n/config.ts`). */
export const LOCALE_COOKIE = 'didacta_locale';

/**
 * Valor de una cookie en la cabecera `Cookie` cruda.
 *
 * Se parsea a mano —y no con `@fastify/cookie`— porque la API no registra ese
 * plugin y esto es lo único que necesita leer una cookie en todo el proyecto:
 * añadir un plugin global para un campo de presentación sería desproporcionado.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Cookie con un `%` suelto: no es nuestra, se ignora.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Locale activo de la UI en este request, o `undefined`.
 *
 * CAMINO DEGRADADO NOMBRADO: devuelve `undefined` —no un locale inventado—
 * cuando (a) no hay cookie (visitante que nunca tocó el selector, que es el
 * caso NORMAL), (b) la cookie trae un tag que la API no persiste (`pt-BR`
 * guardado por un perfil antiguo, o basura). Quien lo consume decide, y todos
 * acaban en `HUB_DEFAULT_LOCALE` por la vía de siempre: omitirlo deja que la
 * columna `user.locale` tome su default de BD, que es exactamente ese valor.
 *
 * No se normaliza («en» → «en-US»): un tag que la API no acepta se descarta
 * entero. Adivinar la región es inventarse la preferencia de alguien.
 */
export function readRequestLocale(headers: {
  cookie?: string | string[] | undefined;
}): string | undefined {
  const raw = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  const value = readCookie(raw, LOCALE_COOKIE)?.trim();
  if (!value) return undefined;
  return CHECKOUT_ALLOWED_LOCALES.includes(value) ? value : undefined;
}

/**
 * `undefined` si el valor no es un locale que la API persista. Es la MISMA
 * guarda que `readRequestLocale`, aplicada del otro lado del salto a Stripe:
 * la metadata de una sesión la puede reenviar cualquiera con el secreto del
 * webhook, así que el valor se vuelve a validar antes de escribirlo en `user`.
 */
export function sanitizeCheckoutLocale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CHECKOUT_ALLOWED_LOCALES.includes(trimmed) ? trimmed : undefined;
}
