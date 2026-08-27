/**
 * En un deploy de un solo contenedor, API y Web corren juntos pero el reverse
 * proxy solo publica un puerto al dominio público. Apuntamos el dominio a :3000
 * (Next.js) y dejamos que Next reescriba los requests a /api/* al servicio
 * interno de la API en :4000. Para clientes (browser), el origin único es
 * https://<dominio>; no hay CORS ni mismatch de cookies.
 *
 * En dev, si la API corre en otro puerto se puede sobreescribir con API_INTERNAL_URL.
 *
 * NOTA: este config está en `.mjs` (no `.ts`) a propósito. Si fuera `.ts`,
 * Next.js intentaría cargar TypeScript en runtime de producción y fallaría
 * con `Cannot find module 'typescript'` cuando devDeps están purgadas.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

// Versión del producto: se INYECTA en build desde el `version` del package.json
// RAÍZ, que es la única fuente de verdad viva del repo — es lo que bumpea cada
// commit `chore(release): corte X` y lo que apunta el tag `vX` que dispara
// `.github/workflows/release.yml`. Antes era una constante a mano en
// `src/lib/version.ts` y se quedó 13 releases atrás (alpha.88 vs alpha.101).
//
// Los `version` de `apps/*/package.json` NO son fuente de verdad: son manifests
// privados de workspace que nadie bumpea (siguen en alpha.88 desde hace 13
// releases). Ver el cuerpo del PR.
const ROOT_PACKAGE_JSON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json',
);
const APP_VERSION = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')).version;

// i18n sin routing por URL (cookie `didacta_locale`): el plugin NO añade
// segmentos de idioma; solo registra `src/i18n/request.ts` para que las APIs
// server de next-intl (getLocale/getMessages/getTranslations) lo encuentren.
const withNextIntl = createNextIntlPlugin();

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const SKIP_TYPE_CHECK = process.env.SKIP_TYPE_CHECK === '1';

/**
 * Cabeceras de seguridad servidas por la PROPIA aplicación.
 *
 * Antes no se emitía ninguna globalmente y se daban por delegadas al reverse
 * proxy. El problema de delegar es que un self-host que no las configure se
 * queda sin ellas y no se entera. Que el proxy las ponga encima no molesta:
 * si las duplica, gana la suya.
 *
 * Qué compra y qué no, sin adornos:
 *
 *  · `object-src 'none'`, `base-uri 'self'` y `form-action 'self'` cortan las
 *    vías con las que un XSS escala a robo de datos (inyectar un `<base>` para
 *    secuestrar rutas relativas, o un `<form>` que postea la sesión fuera).
 *  · `frame-ancestors` corta el clickjacking; `X-Frame-Options` repite lo
 *    mismo para navegadores viejos.
 *  · `script-src` lleva `'unsafe-inline'` porque Next inyecta scripts inline
 *    en el arranque; sin nonces por middleware no se puede quitar. Es decir:
 *    esta CSP NO es la defensa contra XSS —esa es el saneado del contenido en
 *    `packages/core-kernel/src/html/sanitize.ts`—, pero sí impide cargar
 *    script desde otro origen.
 *  · Los orígenes de recursos (`img-src`, `media-src`, `frame-src`) se dejan
 *    abiertos a `https:` a propósito: el almacenamiento puede ser S3, MinIO o
 *    un CDN del operador, y una lista cerrada aquí rompería SCORM, los PDF y
 *    los vídeos de instalaciones que no conocemos.
 *
 * Todo el valor se puede sustituir con `WEB_CSP` si el operador quiere una
 * política más estricta.
 */
const CSP = (
  process.env.WEB_CSP ??
  [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "frame-src 'self' https:",
  ].join('; ')
).trim();

/**
 * HSTS sólo tiene sentido donde termina TLS. Se emite en producción y se
 * puede apagar con `WEB_HSTS=off` — que existe porque un despliegue interno
 * servido por HTTP plano se quedaría sin acceso: el navegador recuerda la
 * cabecera y fuerza HTTPS durante `max-age`.
 */
const HSTS_ENABLED = process.env.WEB_HSTS !== 'off' && process.env.NODE_ENV === 'production';

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
  ...(HSTS_ENABLED
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Inlined en el bundle en build-time (no se lee del entorno en runtime).
  env: { NEXT_PUBLIC_APP_VERSION: APP_VERSION },
  typescript: {
    // En dev-deploy saltamos el type-check de Next.js para reducir el tiempo
    // de build (~3 min menos). Los types se validan en CI con tsc --noEmit.
    ignoreBuildErrors: SKIP_TYPE_CHECK,
  },
  eslint: {
    ignoreDuringBuilds: SKIP_TYPE_CHECK,
  },
  experimental: {
    typedRoutes: !SKIP_TYPE_CHECK,
  },
  async headers() {
    return [
      {
        // Se excluyen las rutas que reescribimos hacia la API: sus respuestas
        // ya llevan sus propias cabeceras (`security-headers.ts`), y la CSP de
        // un documento HTML no le sirve a un JSON ni al Swagger UI.
        source: '/:path((?!api/|healthz|readyz).*)',
        headers: SECURITY_HEADERS,
      },
    ];
  },
  async rewrites() {
    return [
      { source: '/healthz', destination: `${API_INTERNAL_URL}/healthz` },
      { source: '/readyz', destination: `${API_INTERNAL_URL}/readyz` },
      { source: '/api/docs', destination: `${API_INTERNAL_URL}/api/docs` },
      { source: '/api/docs.json', destination: `${API_INTERNAL_URL}/api/docs.json` },
      { source: '/api/:path*', destination: `${API_INTERNAL_URL}/api/:path*` },
    ];
  },
};

export default withNextIntl(config);
