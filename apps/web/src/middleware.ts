import { NextResponse, type NextRequest } from 'next/server';

/**
 * First-run gate.
 *
 * Antes de servir cualquier ruta, consulta `GET /api/setup/status`. Si la
 * instancia está virgen (sin ningún tenant), redirige a `/setup` para que el
 * operador cree el primer tenant + super_admin desde la UI. Una vez que la
 * plataforma queda inicializada, el middleware deja pasar todo y se vuelve
 * efectivamente un no-op (cacheamos `true` en memoria del runtime para no
 * pegarle al backend en cada navegación).
 *
 * El middleware NO toca:
 *   - `_next/*`, assets estáticos: matcher los excluye.
 *   - `/api/*`: los rewrites de Next ya envían esos requests al API directamente.
 *   - `/setup/*`: la propia página del wizard.
 *   - `/healthz`, `/readyz`: load-balancer paths.
 */

let initializedCache = false;

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

async function checkInitialized(): Promise<boolean> {
  if (initializedCache) return true;
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/setup/status`, {
      // Sin cache: el middleware Next ya cachea en `initializedCache` el caso
      // estable. Sin esto, Next podría reusar respuestas del fetch anterior
      // cuando aún no había tenant.
      cache: 'no-store',
    });
    if (!res.ok) {
      // Si la API no responde, NO bloqueamos navegación (mejor degradar a
      // login que romper el primer arranque cuando todavía está levantando).
      return true;
    }
    const data = (await res.json()) as { initialized?: boolean };
    if (data.initialized) {
      initializedCache = true;
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rutas que jamás deben quedar bloqueadas por el setup gate.
  if (
    pathname.startsWith('/setup') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname === '/healthz' ||
    pathname === '/readyz' ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  const initialized = await checkInitialized();
  if (!initialized) {
    const url = req.nextUrl.clone();
    url.pathname = '/setup';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match todas las rutas EXCEPTO:
     * - _next/static  (archivos del bundler)
     * - _next/image   (optimizador de imágenes)
     * - favicon.ico
     * - assets de public/ (svg/png/jpg/webp/etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)).*)',
  ],
};
