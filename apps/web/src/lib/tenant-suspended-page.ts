/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La página que ve quien llega a un aula SUSPENDIDA.
 *
 * La pinta el middleware, entera y sin pasar por la app: un tenant suspendido
 * no debe servir ni el shell, ni el login, ni un solo dato suyo. Por eso es un
 * documento autocontenido (sin bundle, sin llamadas, sin marca) y por eso esta
 * función no recibe NADA del tenant: lo único que se sabe de él aquí es que
 * existe y que está suspendido, y así no hay nada que se pueda escapar.
 *
 * Solo importa `common.json` de cada idioma, no el catálogo entero: esto se
 * empaqueta con el middleware, que corre en cada navegación.
 */

import { catalogOf, toSupportedLocale } from '@/i18n/config';
import en from '@/i18n/messages/en/common.json';
import es from '@/i18n/messages/es/common.json';
import pt from '@/i18n/messages/pt/common.json';

const COPY = { es: es.tenantSuspended, en: en.tenantSuspended, pt: pt.tenantSuspended } as const;
type Catalog = keyof typeof COPY;

/**
 * 503 y no 404 ni 403.
 *
 *  - 404 es mentira (el aula existe) y es lo que había: parecía que el dominio
 *    estaba mal o que el producto se había caído.
 *  - 200 diría a navegadores, cachés y buscadores que esto ES la página.
 *  - Un 4xx se indexa como «aquí ya no hay nada»: un aula suspendida unos días
 *    por un impago perdería su sitio público en los buscadores.
 *
 * 503 + `Retry-After` es lo que dice la verdad: está, ahora no se sirve, vuelve
 * luego.
 */
export const TENANT_SUSPENDED_STATUS = 503;
const RETRY_AFTER_SECONDS = 3600;

/**
 * Idioma de la página: la cookie de idioma si la hay (la misma que usa la app),
 * si no `Accept-Language`, si no español.
 *
 * `Accept-Language` no forma parte del modelo de idioma de la app (cookie →
 * perfil → es-ES), pero aquí no hay perfil que consultar: quien llega a un aula
 * suspendida no puede iniciar sesión, y si nunca la abrió tampoco tiene cookie.
 */
export function pickSuspendedCatalog(
  cookieLocale: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Catalog {
  if (cookieLocale) return catalogOf(toSupportedLocale(cookieLocale));
  const preferidos = (acceptLanguage ?? '')
    .split(',')
    .map((parte, orden) => {
      const [tag = '', ...params] = parte.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const peso = q ? Number.parseFloat(q.slice(2)) : 1;
      return { base: tag.trim().toLowerCase().split('-')[0] ?? '', peso, orden };
    })
    .filter((l) => Number.isFinite(l.peso) && l.peso > 0)
    .sort((a, b) => b.peso - a.peso || a.orden - b.orden);
  for (const { base } of preferidos) {
    if (base === 'en') return 'en';
    if (base === 'es') return 'es';
    if (base === 'pt') return 'pt';
  }
  return 'es';
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderTenantSuspendedPage(catalog: Catalog): string {
  const t = COPY[catalog];
  return `<!doctype html>
<html lang="${catalog}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(t.metaTitle)}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #f6f7f9; color: #1f2933; }
main { max-width: 440px; text-align: center; }
h1 { margin: 0 0 12px; font-size: 1.5rem; line-height: 1.3; font-weight: 600; }
p { margin: 0 0 8px; font-size: 1rem; line-height: 1.6; color: #52606d; }
@media (prefers-color-scheme: dark) {
  body { background: #14181d; color: #e4e7eb; }
  p { color: #9aa5b1; }
}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(t.title)}</h1>
<p>${escapeHtml(t.body)}</p>
<p>${escapeHtml(t.owner)}</p>
</main>
</body>
</html>
`;
}

/** Cabeceras de la respuesta de aula suspendida. */
export function tenantSuspendedHeaders(catalog: Catalog): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-language': catalog,
    // Ni el navegador ni un proxy intermedio pueden quedarse con esto: el día
    // que el aula se reactive tiene que verse a la primera.
    'cache-control': 'no-store',
    'retry-after': String(RETRY_AFTER_SECONDS),
    'x-robots-tag': 'noindex, nofollow',
  };
}
