/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { NextResponse, type NextRequest } from 'next/server';

/**
 * First-run gate.
 *
 * Cuando la instancia está virgen (sin tenants), redirige CUALQUIER ruta
 * de la app al wizard `/setup`. Una vez creado el primer tenant, el
 * middleware no toca nada y se vuelve un no-op (cacheamos `true` en memoria
 * del runtime — se invalida sólo al restart del worker).
 *
 * Bug previo: el matcher solo cubría rutas de auth (`/`, `/signin`, etc.).
 * Las rutas autenticadas dentro de `(app)` (`/cursos`, `/admin`, etc.)
 * pasaban directo y el shell de la app se renderizaba aunque el sistema
 * no tuviera tenants, dejando un estado roto pero accesible.
 *
 * Fix: el matcher ahora cubre TODO excepto rutas que NO deben gatearse
 * (api, internals de Next, assets estáticos, el propio /setup). Sin
 * tenants, cualquier path → /setup. Con tenants, cero overhead.
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

/// Matcher negativo: capturamos cualquier path EXCEPTO los listados.
///
///   - `api`            → endpoints REST del propio API, no UI.
///   - `_next` (todo)   → bundle, optimización imágenes, data RSC, etc.
///   - `_not-found` /
///     `_error`         → páginas internas de Next (rompe routing si las
///                        capturamos).
///   - `favicon.ico`    → asset.
///   - `setup`          → el destino del redirect (sin loop).
///   - `healthz` /
///     `readyz` / `livez` → probes Easypanel/k8s, no UI.
export const config = {
  matcher: ['/((?!api|_next|_not-found|_error|favicon\\.ico|setup|healthz|readyz|livez).*)'],
};
