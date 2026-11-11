/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE } from './i18n/config';
import { SITE_PATH_PREFIX } from './lib/site-routing';
import {
  pickSuspendedCatalog,
  renderTenantSuspendedPage,
  TENANT_SUSPENDED_STATUS,
  tenantSuspendedHeaders,
} from './lib/tenant-suspended-page';

/**
 * Dos puertas, en este orden.
 *
 * 1. **First-run gate.** Instancia sin tenants → cualquier ruta al wizard
 *    `/setup`. Una vez creado el primer tenant se vuelve un no-op (cacheamos
 *    `true` en memoria del runtime — se invalida solo al restart del worker).
 *
 *    Bug previo: el matcher solo cubría rutas de auth (`/`, `/signin`, etc.).
 *    Las rutas autenticadas dentro de `(app)` (`/cursos`, `/admin`, etc.)
 *    pasaban directo y el shell de la app se renderizaba aunque el sistema no
 *    tuviera tenants, dejando un estado roto pero accesible.
 *
 * 2. **Host gate (UC-C403 AC2).** Host que no pertenece a ningún tenant → 404.
 *
 *    Antes NO existía: en cuanto la instancia estaba inicializada el middleware
 *    no miraba nada más, así que **cualquier** hostname enrutado hasta aquí
 *    renderizaba la app entera. En el pool, con el comodín `*.didacta.io` y su
 *    certificado válido, eso convertía cada subdominio libre en un login de
 *    Didacta funcional y con HTTPS bueno — la superficie de phishing que
 *    `tenant-resolver.service.ts` dice querer evitar en su propio comentario.
 *
 *    No se puede arreglar en Traefik: el comodín es justo lo que hace que un
 *    aula recién aprovisionada funcione sin tocar el proxy. La capa correcta es
 *    esta.
 *
 *    Dentro de esta puerta hay un tercer caso: el host de un tenant que existe
 *    pero está SUSPENDIDO. Antes caía en el mismo 404 que un host desconocido,
 *    y al cliente con la suscripción vencida le parecía que su dominio estaba
 *    mal o que el producto se había caído. Ahora recibe una página propia que
 *    se lo dice (`tenant-suspended-page.ts`), en CUALQUIER ruta — `/signin`
 *    incluida, así que desde ahí no se puede ni intentar entrar.
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/**
 * Escape hatch para volver al comportamiento anterior (servir la app en
 * cualquier host). Existe porque esto es software que se autoaloja: si a
 * alguien le rompe un acceso legítimo que no supimos prever, tiene que poder
 * seguir trabajando hoy y abrir el issue mañana, no al revés.
 */
const ALLOW_UNKNOWN_HOSTS = process.env['DIDACTA_ALLOW_UNKNOWN_HOSTS'] === 'true';

let initializedCache = false;

/** host → (¿es de algún tenant?, ¿está suspendido?, cuándo caduca la respuesta). */
const hostCache = new Map<
  string,
  { known: boolean; surface: HostSurface; suspended: boolean; expiresAt: number }
>();

/// Qué sirve un dominio. `null` = no lo sabemos (host siempre válido, o la
/// API no contestó): en ese caso se sirve el aula, que es lo que ya había.
type HostSurface = 'APP' | 'SITE' | null;

/**
 * Un «sí» se cachea cinco minutos y un «no» solo treinta segundos.
 *
 * Asimétrico a propósito: el «no» es el que caduca mal. Un aula recién
 * aprovisionada por el plano de control estrena hostname, y si su primer
 * visitante se lleva un 404 cacheado cinco minutos, el cliente estrena su aula
 * viendo que no existe.
 *
 * «Suspendida» caduca igual de rápido que el «no», por el mismo motivo: quien
 * acaba de regularizar su suscripción no puede seguir viendo el aviso cinco
 * minutos más.
 */
const TTL_CONOCIDO_MS = 5 * 60_000;
const TTL_DESCONOCIDO_MS = 30_000;

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

/**
 * Hosts que nunca se gatean: `localhost` y las IP desnudas.
 *
 * Un self-hoster entra a su instalación por `http://<ip>:3000` constantemente
 * —antes de tener DNS, desde la red local, por un túnel SSH— y ese host no es
 * ni será un `TenantDomain`. Gatearlo convertiría este arreglo en «actualicé y
 * ya no entro en mi propio servidor». La regla de fondo: aquí se cierran los
 * nombres que un atacante puede APUNTAR a esta máquina, y una IP no se apunta.
 */
function esHostSiempreValido(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.startsWith('[')) return true; // IPv6 entre corchetes
  return false;
}

async function resolverHost(
  host: string,
): Promise<{ known: boolean; surface: HostSurface; suspended: boolean }> {
  const ahora = Date.now();
  const cacheado = hostCache.get(host);
  if (cacheado && cacheado.expiresAt > ahora) {
    return { known: cacheado.known, surface: cacheado.surface, suspended: cacheado.suspended };
  }

  try {
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/tenancy/resolve`, {
      cache: 'no-store',
      // El host del visitante viaja explícito: esta llamada la hace el servidor
      // del web contra la API, así que su propio `Host` es el del salto interno
      // y no dice nada. Es la misma cabecera que Next pone al reescribir
      // `/api/*`, así que la API la lee por el mismo camino que en producción.
      headers: { 'x-forwarded-host': host },
    });
    // La API no contesta lo que esperábamos: dejar pasar. Un fallo de la API no
    // debe convertirse en un 404 global — el modo degradado tiene que ser
    // «como antes», no «el producto no existe».
    if (!res.ok) return { known: true, surface: null, suspended: false };
    const data = (await res.json()) as {
      known?: boolean;
      surface?: HostSurface;
      suspended?: boolean;
    };
    const known = data.known === true;
    const surface = data.surface === 'SITE' ? 'SITE' : data.surface === 'APP' ? 'APP' : null;
    // Solo un `true` explícito y solo si la API NO lo da por conocido: una API
    // anterior a este campo no lo manda (y se sigue contestando el 404 de
    // antes), y un aula en marcha nunca puede acabar tapada por este aviso.
    const suspended = !known && data.suspended === true;
    hostCache.set(host, {
      known,
      surface,
      suspended,
      expiresAt: ahora + (known ? TTL_CONOCIDO_MS : TTL_DESCONOCIDO_MS),
    });
    return { known, surface, suspended };
  } catch {
    return { known: true, surface: null, suspended: false };
  }
}

export async function middleware(req: NextRequest) {
  const initialized = await checkInitialized();
  if (!initialized) {
    const url = req.nextUrl.clone();
    url.pathname = '/setup';
    url.search = '';
    return NextResponse.redirect(url);
  }

  // El prefijo interno del sitio NO es una URL pública: solo existe como
  // destino de la reescritura de más abajo. Una petición que lo pida
  // directamente viene de fuera. La reescritura interna no vuelve a pasar por
  // el middleware, así que este corte no toca el tráfico legítimo.
  if (
    req.nextUrl.pathname === SITE_PATH_PREFIX ||
    req.nextUrl.pathname.startsWith(`${SITE_PATH_PREFIX}/`)
  ) {
    return new NextResponse('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (ALLOW_UNKNOWN_HOSTS) return NextResponse.next();

  const rawHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!rawHost) return NextResponse.next();
  const host = (rawHost.split(',')[0] ?? rawHost).trim().toLowerCase();
  const hostname = host.startsWith('[') ? host : (host.split(':')[0] ?? host);
  if (esHostSiempreValido(hostname)) return NextResponse.next();

  const { known, surface, suspended } = await resolverHost(host);
  if (suspended) {
    // El aula existe pero está suspendida. Se contesta aquí, con un documento
    // autocontenido, en vez de dejar pasar a la app: no se sirve el shell, ni
    // el login, ni nada del tenant. Lo único que entra en la página es el
    // idioma de quien la pide.
    const catalog = pickSuspendedCatalog(
      req.cookies.get(LOCALE_COOKIE)?.value,
      req.headers.get('accept-language'),
    );
    return new NextResponse(renderTenantSuspendedPage(catalog), {
      status: TENANT_SUSPENDED_STATUS,
      headers: tenantSuspendedHeaders(catalog),
    });
  }
  if (known) {
    // Reparto por dominio: el mismo despliegue sirve el aula y el sitio
    // público, y lo único que los distingue es por dónde entró la petición.
    if (surface === 'SITE') {
      const url = req.nextUrl.clone();
      url.pathname = `${SITE_PATH_PREFIX}${
        req.nextUrl.pathname === '/' ? '' : req.nextUrl.pathname
      }`;
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  // 404 pelado, sin marca: si este nombre no es de nadie, no hay nada que
  // contar sobre qué corre por debajo.
  return new NextResponse('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
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
///     `readyz` / `livez` → probes del orquestador (k8s/PaaS), no UI.
export const config = {
  matcher: ['/((?!api|_next|_not-found|_error|favicon\\.ico|setup|healthz|readyz|livez).*)'],
};
