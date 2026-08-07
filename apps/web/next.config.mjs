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
import createNextIntlPlugin from 'next-intl/plugin';

// i18n sin routing por URL (cookie `didacta_locale`): el plugin NO añade
// segmentos de idioma; solo registra `src/i18n/request.ts` para que las APIs
// server de next-intl (getLocale/getMessages/getTranslations) lo encuentren.
const withNextIntl = createNextIntlPlugin();

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const SKIP_TYPE_CHECK = process.env.SKIP_TYPE_CHECK === '1';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
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
