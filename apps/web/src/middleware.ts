import { NextResponse, type NextRequest } from 'next/server';

/**
 * First-run gate.
 *
 * Cuando la instancia está virgen (sin tenants), redirige las rutas públicas
 * de entrada al wizard `/setup`. Una vez creado el primer tenant, el
 * middleware no toca nada y se vuelve un no-op (cacheamos `true` en memoria
 * del runtime).
 *
 * Matcher EXPLÍCITO de las únicas rutas que necesitamos interceptar (`/`,
 * `/signin`, `/signup`, `/forgot-password`, `/reset-password`). Cualquier
 * otra cosa — rutas internas de Next, assets, /api, /setup — pasa sin
 * tocarse. Esto evita el problema de capturar `_not-found` u otras rutas
 * internas que rompen la resolución de Next 15.
 */

let initializedCache = false;

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

async function checkInitialized(): Promise<boolean> {
  if (initializedCache) return true;
  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/setup/status`, {
      cache: 'no-store',
    });
    if (!res.ok) return true;
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
  const initialized = await checkInitialized();
  if (initialized) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/setup';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/', '/signin', '/signup', '/forgot-password', '/reset-password'],
};
