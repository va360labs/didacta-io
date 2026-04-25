import type { NextConfig } from 'next';

/**
 * En el deploy de Easypanel, API y Web corren en el mismo contenedor pero
 * Easypanel solo proxea un puerto al dominio público. Apuntamos el dominio a :3000
 * (Next.js) y dejamos que Next reescriba los requests a /api/* al servicio
 * interno de la API en :4000. Para clientes (browser), el origin único es
 * https://<dominio>; no hay CORS ni mismatch de cookies.
 *
 * En dev, si la API corre en otro puerto se puede sobreescribir con API_INTERNAL_URL.
 */
const API_INTERNAL_URL = process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
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

export default config;
