/**
 * Guard anti-huérfanas del sidebar (regresión).
 *
 * El sidebar/admin-nav está hardcodeado en `app/(app)/layout.tsx` y los módulos
 * añaden items vía `sidebarItems`. Nada garantizaba que una ruta nueva tuviera
 * su entrada de menú: features reales quedaban inaccesibles (p.ej. el bug del
 * label 'Profesor' vs 'Formador' que ocultó /formador/aula-virtual, o
 * /admin/fundae/grupos sin enlace). Y al revés: un item de menú podía apuntar a
 * una página que no existe (p.ej. /super/users → 404).
 *
 * Este test es ESTÁTICO (lee los archivos de rutas + la nav), corre en CI sin
 * credenciales y falla cuando:
 *   1) Existe una ruta `(app)/**` que no está ni en la nav ni en la ALLOWLIST.
 *   2) Una entrada ALLOWLIST `reachable` dejó de estar enlazada (link borrado).
 *   3) Un item de menú apunta a una ruta que no existe.
 *
 * Para añadir una ruta nueva: o la pones en la nav (layout/módulo) o la
 * documentas aquí en ALLOWLIST con su vía de acceso. No hay tercera opción
 * silenciosa — ese era justo el problema.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/src/lib
const WEB_SRC = join(HERE, '..'); // apps/web/src
const APP_DIR = join(WEB_SRC, 'app', '(app)');
const LAYOUT = join(APP_DIR, 'layout.tsx');
/** El árbol de navegación se extrajo del layout a `lib/sidebar-nav.ts`. */
const SIDEBAR_NAV = join(WEB_SRC, 'lib', 'sidebar-nav.ts');
const MODULES_DIR = join(WEB_SRC, 'modules');

/**
 * Rutas que NO viven en el sidebar pero SÍ son accesibles (o un gap conocido).
 * kind:
 *   - 'reachable': se llega por un link/botón/tab en otra página → el test
 *     verifica que la ruta sigue referenciada en el código (si borras el link,
 *     falla).
 *   - 'external': la alcanza un redirect externo (Stripe, etc.); no exigimos
 *     link interno.
 *   - 'knownGap': la página existe pero AÚN no tiene punto de entrada. No falla
 *     el test, pero queda documentada y la imprimimos para no olvidarla.
 */
type AllowKind = 'reachable' | 'external' | 'knownGap';
const ALLOWLIST: Record<string, { kind: AllowKind; reason: string }> = {
  '/admin/fundae/empresas': {
    kind: 'reachable',
    reason: 'botón "Empresas bonificadas" en /admin/fundae',
  },
  '/admin/fundae/grupos': {
    kind: 'reachable',
    reason: 'botón "Grupos bonificables" en /admin/fundae',
  },
  '/admin/tenants/nuevo': { kind: 'reachable', reason: 'acción "Nuevo tenant" en /admin/tenants' },
  '/admin/usuarios/invitar': { kind: 'reachable', reason: 'acción "Invitar" en /admin/usuarios' },
  '/admin/usuarios/importar': {
    kind: 'reachable',
    reason: 'acción "Importar CSV" en /admin/usuarios',
  },
  '/formador/cursos/nuevo': {
    kind: 'reachable',
    reason: 'acción "Nuevo curso" en /formador/cursos',
  },
  '/formador/rutas/nueva': { kind: 'reachable', reason: 'acción "Nueva ruta" en /formador/rutas' },
  '/inicio': {
    kind: 'reachable',
    reason: 'redirige a /comunidad (stub histórico, referenciado en layout)',
  },
  '/notificaciones': { kind: 'reachable', reason: 'icono de campana (notifications-bell)' },
  '/admin/integraciones/api': {
    kind: 'reachable',
    reason: 'enlace "Integración API" en /admin/api-keys (documentación en vivo para integradores)',
  },
  '/admin/cursos/imagenes': {
    kind: 'external',
    reason:
      'redirect legacy a /admin/imagenes: se mantiene para no romper enlaces guardados, por eso no está en la nav',
  },
  // ── Fusiones de la reordenación del panel admin ────────────────────────────
  // Cuatro pantallas se convirtieron en pestañas de otra. Las rutas viejas
  // sobreviven como redirect para enlaces guardados y documentación ya
  // repartida, y por eso NO están en la nav (tenerlas duplicaría la entrada).
  '/admin/metricas': {
    kind: 'external',
    reason: 'redirect a /admin?tab=negocio (las métricas son pestaña del panel)',
  },
  '/admin/sso-saml': {
    kind: 'external',
    reason: 'redirect a /admin/sso?tab=saml (los tres protocolos SSO se unificaron con pestañas)',
  },
  '/admin/sso-wordpress': {
    kind: 'external',
    reason:
      'redirect a /admin/sso?tab=wordpress; la ruta se cita en las instrucciones de wp-config.php',
  },
  '/admin/zoom/webhook-events': {
    kind: 'external',
    reason: 'redirect a /admin/webhooks?tab=zoom (entregas de Zoom como pestaña de Webhooks)',
  },
  '/cursos/checkout/success': { kind: 'external', reason: 'redirect de Stripe (success_url)' },
  '/cursos/checkout/cancel': { kind: 'external', reason: 'redirect de Stripe (cancel_url)' },
  '/eventos': {
    kind: 'reachable',
    reason:
      'redirige a /calendario?vista=eventos (bloque 9: fusionado en la pestaña "Eventos" del calendario; la ruta se conserva para enlaces guardados)',
  },
  '/cuenta/suscripciones': {
    kind: 'reachable',
    reason:
      'redirige a /cuenta?tab=suscripcion (la gestión vive en la pestaña "Suscripción" de /cuenta). La ruta se conserva como success_url/cancel_url del checkout de Stripe.',
  },
};

/** Rutas de menú externas/dinámicas que no corresponden a un page.tsx local. */
const NAV_EXTERNAL: ReadonlySet<string> = new Set<string>([]);

// ---------------- helpers ----------------

function walk(dir: string, onFile: (abs: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist')
        continue;
      walk(abs, onFile);
    } else {
      onFile(abs);
    }
  }
}

/** abs path de un page.tsx → ruta pública (sin grupos `(...)`, sin /page.tsx). */
function routeOf(absPageFile: string): string {
  const rel = absPageFile.slice(APP_DIR.length).split(sep).join('/'); // /admin/foo/page.tsx
  const noPage = rel.replace(/\/page\.tsx$/, '');
  const segments = noPage.split('/').filter((s) => s && !/^\(.+\)$/.test(s));
  return '/' + segments.join('/');
}

function collectRoutes(): string[] {
  const routes: string[] = [];
  walk(APP_DIR, (abs) => {
    if (abs.endsWith(`${sep}page.tsx`)) routes.push(routeOf(abs));
  });
  return [...new Set(routes)].sort();
}

/** hrefs literales (comilla simple) de sidebar-nav.ts + layout.tsx + modules/<m>/index.ts. */
function collectNavHrefs(): Set<string> {
  const files = [SIDEBAR_NAV, LAYOUT];
  for (const m of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (m.isDirectory()) {
      const idx = join(MODULES_DIR, m.name, 'index.ts');
      try {
        if (statSync(idx).isFile()) files.push(idx);
      } catch {
        /* sin index.ts */
      }
    }
  }
  const hrefs = new Set<string>();
  for (const f of files) {
    for (const match of readFileSync(f, 'utf8').matchAll(/href:\s*'([^']+)'/g)) {
      hrefs.add(match[1]);
    }
  }
  return hrefs;
}

/** Todo el código fuente de web (para verificar reachability de allowlist). */
function loadSourceCorpus(): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  walk(WEB_SRC, (abs) => {
    if (/\.(ts|tsx)$/.test(abs) && !abs.endsWith('.test.ts') && !abs.endsWith('.test.tsx')) {
      out.push({ path: abs, content: readFileSync(abs, 'utf8') });
    }
  });
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ¿`route` aparece (con frontera de path) en algún archivo distinto a `ownPage`? */
function referencedElsewhere(
  route: string,
  ownPage: string,
  corpus: Array<{ path: string; content: string }>,
): boolean {
  const re = new RegExp(escapeRe(route) + '(?![\\w-])');
  return corpus.some((f) => f.path !== ownPage && re.test(f.content));
}

const isDynamic = (route: string) => route.includes('[');

// ---------------- tests ----------------

describe('guard anti-huérfanas del sidebar', () => {
  const routes = collectRoutes();
  const nav = collectNavHrefs();
  const corpus = loadSourceCorpus();

  it('toda ruta (app) es accesible: en la nav o documentada en ALLOWLIST', () => {
    const orphans = routes.filter((r) => !isDynamic(r) && !nav.has(r) && !(r in ALLOWLIST));
    expect(
      orphans,
      `Rutas HUÉRFANAS (existen pero nada las enlaza). Añádelas a la nav ` +
        `(layout.tsx o modules/<m>/index.ts) o documenta su vía de acceso en ` +
        `ALLOWLIST de este test:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('las entradas ALLOWLIST "reachable" siguen enlazadas (no se borró el link)', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([, v]) => v.kind === 'reachable')
      .map(([route]) => route)
      .filter((route) => {
        const ownPage = join(APP_DIR, ...route.split('/').filter(Boolean), 'page.tsx');
        return !referencedElsewhere(route, ownPage, corpus);
      });
    expect(
      stale,
      `Rutas marcadas "reachable" en ALLOWLIST que ya NO están enlazadas en ` +
        `ningún sitio (el link se borró → quedaron huérfanas):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('ningún item de menú apunta a una página inexistente (caso /super/users)', () => {
    const routeSet = new Set(routes);
    const broken = [...nav].filter((href) => {
      if (!href.startsWith('/') || href.includes('[') || href.includes('${')) return false;
      return !routeSet.has(href) && !NAV_EXTERNAL.has(href);
    });
    expect(
      broken,
      `Items de menú que apuntan a rutas SIN page.tsx (enlaces rotos → 404):\n  ${broken.join('\n  ')}`,
    ).toEqual([]);
  });

  it('documenta los gaps conocidos (páginas sin punto de entrada todavía)', () => {
    const gaps = Object.entries(ALLOWLIST).filter(([, v]) => v.kind === 'knownGap');
    // No falla: solo deja constancia. Si la lista crece, revísala.
    for (const [route, v] of gaps) {
      console.warn(`[gap conocido] ${route} — ${v.reason}`);
    }
    expect(gaps.length).toBeLessThanOrEqual(3);
  });
});
