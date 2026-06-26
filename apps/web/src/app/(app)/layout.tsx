'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { AppSidebar, type SidebarGroup } from '@/components/app-sidebar';
import { Icon } from '@/components/icon';
import { LicenseProvider } from '@/components/license-provider';
import { NotificationsBell } from '@/components/notifications-bell';
import { authStorage, type StoredSession } from '@/lib/auth-storage';
import { meApi } from '@/lib/me';
import { formatTenantName } from '@/lib/tenant-name';
import { useTenantContext } from '@/lib/tenant-context';
import { mergeExtensionSidebarItems } from '@/lib/sidebar-extensions-merge';
import { filterByActiveModules } from '@/lib/sidebar-modules-filter';
import { moduleExtensions } from '@/modules';
import { useCommunitySpaces, invalidateCommunitySpacesCache } from '@/modules/community';
import { themeCache, requestThemeRefresh } from '@/lib/theming';
import { isIconName } from '@/components/space-icon';
import type { IconName } from '@/components/icon';
import { CreateSpaceModal } from '@/components/create-space-modal';

/**
 * Shell de la app autenticada — sidebar persistente Didacta + main canvas.
 *
 * Las páginas siguen renderizando su propio `<h1>` y contenido. El shell solo
 * provee navegación + bell de notificaciones. Esto evita refactorizar
 * cada page y permite aplicar el UI kit progresivamente.
 */
/**
 * Destino del cambio de contraseña: la pestaña Seguridad del perfil
 * (`/cuenta?tab=seguridad`). El usuario con contraseña temporal
 * (`mustChangePassword`) es forzado a `/cuenta`; esa ruta queda exenta del
 * redirect para no entrar en bucle. (Antes había una página dedicada
 * `/cuenta/seguridad`; se consolidó en el tab.)
 */
const ACCOUNT_PATH = '/cuenta';
const CHANGE_PASSWORD_REDIRECT = '/cuenta?tab=seguridad';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<StoredSession | null>(null);

  useEffect(() => {
    const current = authStorage.getSession();
    if (!current) {
      router.replace('/signin');
      return;
    }
    // Contraseña temporal (p.ej. alta por `POST /inscribe`): forzamos el cambio
    // antes de dejar usar el resto de la app. Al cambiarla, la pantalla de
    // seguridad limpia la sesión y redirige a /signin → el nuevo login ya viene
    // sin el flag, así que no hay bucle.
    if (current.user.mustChangePassword && pathname !== ACCOUNT_PATH) {
      router.replace(CHANGE_PASSWORD_REDIRECT);
      return;
    }
    // Onboarding OBLIGATORIO para todos los usuarios actuales: mientras
    // `onboardingCompletedAt` no sea un timestamp real, forzamos el asistente
    // `/onboarding` (ruta fuera del shell, sin sidebar). Cubrimos también
    // `undefined` (sesiones guardadas antes del flag) y `null` (usuarios sin
    // backfill), de modo que también se gatea a quienes NO entran por primera
    // vez. Solo se libera al completar el onboarding (timestamp truthy).
    if (!current.user.onboardingCompletedAt) {
      router.replace('/onboarding');
      return;
    }
    setSession(current);
  }, [router, pathname]);

  // Refresco en caliente de la sesión: /cuenta (y el onboarding) actualizan el
  // nombre/avatar en localStorage y disparan este evento para que el sidebar se
  // re-renderice al instante sin navegar ni recargar.
  useEffect(() => {
    function refresh() {
      const s = authStorage.getSession();
      if (s) setSession(s);
    }
    window.addEventListener('didacta:session-updated', refresh);
    return () => window.removeEventListener('didacta:session-updated', refresh);
  }, []);

  if (!session) return null;

  function logout() {
    const tenantId = session?.user.tenantId;
    authStorage.clear();
    // Evita que el cache en memoria de espacios de un tenant se filtre al
    // siguiente login (navegación SPA sin recargar).
    invalidateCommunitySpacesCache();
    // Limpia el branding del tenant que cerró sesión: borra el cache y resetea
    // el TenantThemeProvider a los defaults (sin token, el handler pone null),
    // para que las pantallas de auth no muestren la marca del tenant anterior.
    if (tenantId) themeCache.clear(tenantId);
    requestThemeRefresh();
    router.replace('/signin');
  }

  return (
    <LicenseProvider>
      {/*
       * TenantThemeProvider vive ahora en el ROOT layout (apps/web/src/app/
       * layout.tsx) para cubrir también las pantallas de auth. Acá solo
       * envolvemos el shell autenticado en LicenseProvider.
       */}
      <Shell session={session} onLogout={logout}>
        {children}
      </Shell>
    </LicenseProvider>
  );
}

/**
 * Inner shell — vive dentro de `LicenseProvider` para poder consultar las
 * capabilities EE activas y mostrar/ocultar items del sidebar acordemente
 * (ej. "Dominios propios" → gateado por `feat:custom_domains`).
 *
 * Importante: estos toggles del sidebar son SOLO UX. El backend gatea cada
 * endpoint con @RequiresCapability — un usuario que conozca la URL siempre
 * va a recibir 402 si no tiene la licencia.
 */
function Shell({
  session,
  onLogout,
  children,
}: {
  session: StoredSession;
  onLogout: () => void;
  children: ReactNode;
}) {
  const pathname = usePathname();

  const isAdminOrFormador = session.user.roles.some((r) =>
    ['super_admin', 'tenant_admin', 'formador'].includes(r),
  );
  const isAdmin = session.user.roles.some((r) => ['super_admin', 'tenant_admin'].includes(r));
  const isSuperAdmin = session.user.roles.includes('super_admin');

  // Módulos activos para el tenant del usuario. Mientras está null (primer
  // render) no filtramos — el sidebar se pinta completo y se reordena al
  // resolver la promesa. El backend sigue gateando con ModuleAccessInterceptor
  // aunque el usuario haga clic antes de que llegue la respuesta.
  // Cargamos el estado de módulos UNA vez al montar. Antes se re-pedía en cada
  // cambio de pathname, lo que añadía una llamada al API a CADA navegación
  // (latencia perceptible al cambiar de página). El caso de "admin desactiva un
  // módulo y se refleja sin recargar" ya lo cubre el listener de
  // `didacta:modules-changed` de abajo, que se dispara desde el toggle.
  const [activeModules, setActiveModules] = useState<Set<string> | null>(null);
  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    let cancelled = false;
    meApi
      .getMyModules(token)
      .then((res) => {
        if (!cancelled) setActiveModules(new Set(res.activeModules));
      })
      .catch(() => {
        // Si falla (red, 401 expirado, módulo registry indisponible), dejamos
        // null para no romper el sidebar — el usuario verá items que tal vez
        // no tengan módulo activo y el backend devolverá 403 al click.
        if (!cancelled) setActiveModules(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listener para actualización en caliente desde la misma página: cuando
  // /admin/configuracion termina un toggle, dispatchea
  // `window.dispatchEvent(new Event('didacta:modules-changed'))` y el
  // sidebar se refresca sin esperar a la próxima navegación.
  useEffect(() => {
    function refresh() {
      const token = authStorage.getAccessToken();
      if (!token) return;
      meApi
        .getMyModules(token)
        .then((res) => setActiveModules(new Set(res.activeModules)))
        .catch(() => {
          /* mantener estado anterior si el refresh falla */
        });
    }
    window.addEventListener('didacta:modules-changed', refresh);
    return () => window.removeEventListener('didacta:modules-changed', refresh);
  }, []);

  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  const rawSpaces = useCommunitySpaces();
  const espaciosGroup: SidebarGroup = {
    label: 'Espacios',
    icon: 'hash',
    canAdd: isAdmin,
    onAdd: isAdmin ? () => setCreateSpaceOpen(true) : undefined,
    items: rawSpaces.map((s) => ({
      href: `/espacios/${s.slug}`,
      label: s.title,
      icon: (isIconName(s.icon) ? s.icon : 'hash') as IconName,
      emoji: isIconName(s.icon) ? undefined : s.icon,
    })),
  };

  const baseGroups = buildGroups({
    isAdminOrFormador,
    isAdmin,
    isSuperAdmin,
    espacios: espaciosGroup,
  });
  const userRoles = new Set(session.user.roles);
  const mergedGroups = mergeExtensionSidebarItems(baseGroups, moduleExtensions, userRoles);
  const groups = filterByActiveModules(mergedGroups, activeModules);

  // `<title>` del documento: "Sección actual | Nombre del Tenant | Didacta".
  // Antes todas las páginas mostraban solo "Didacta" (default del root layout):
  // este shell es client component, así que en vez de metadata sincronizamos
  // document.title. La sección se deriva del pathname contra el mapa ruta→label
  // del propio sidebar (mergedGroups, sin filtrar por módulo para que el label
  // resuelva aunque activeModules aún no haya cargado). Si la ruta no está en el
  // sidebar (p.ej. detalle), cae a "Tenant | Didacta". El nombre del tenant usa
  // el nombre REAL resuelto por host (useTenantContext, igual que el sidebar),
  // con fallback al slug title-cased.
  const { tenant: hostTenant } = useTenantContext();
  const tenantName = hostTenant?.name?.trim() || formatTenantName(session.user.tenantSlug);
  const sectionLabel = resolveSectionLabel(mergedGroups, pathname ?? '');
  useEffect(() => {
    const parts = [sectionLabel, tenantName, 'Didacta'].filter((p): p is string => Boolean(p));
    document.title = parts.join(' | ');
  }, [sectionLabel, tenantName]);

  return (
    <div className="flex min-h-dvh bg-bg-subtle">
      <CreateSpaceModal open={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />
      <AppSidebar
        groups={groups}
        pathname={pathname ?? null}
        session={session}
        onLogout={onLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-sticky flex h-14 items-center justify-end gap-2 border-b border-border-soft bg-surface/95 px-6 backdrop-blur">
          <a
            href="/mensajes"
            className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text"
            aria-label="Mensajes"
          >
            <Icon name="messages" size={18} />
          </a>
          <NotificationsBell />
        </div>

        <main className="flex-1 px-8 py-6">
          <div className="mx-auto max-w-[1280px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

/**
 * Rutas del shell que NO tienen item en el sidebar pero merecen un nombre de
 * sección en el `<title>` (se acceden desde el menú de perfil, banners, etc.).
 */
const SECTION_TITLE_EXTRAS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/cuenta', label: 'Mi perfil' },
];

/**
 * Deriva el label de la sección actual a partir del pathname, reutilizando el
 * mapa ruta→label del sidebar (más SECTION_TITLE_EXTRAS). Match por prefijo más
 * largo (la ruta más específica gana); respeta `exactMatch`. Devuelve null si
 * ninguna ruta coincide (el `<title>` cae a "Tenant | Didacta").
 */
function resolveSectionLabel(groups: SidebarGroup[], pathname: string): string | null {
  if (!pathname) return null;
  const candidates: Array<{ href: string; label: string; exact?: boolean }> = [];
  for (const g of groups) {
    for (const it of g.items) {
      if (it.href) candidates.push({ href: it.href, label: it.label, exact: it.exactMatch });
    }
  }
  candidates.push(...SECTION_TITLE_EXTRAS);

  let best: { href: string; label: string } | null = null;
  for (const c of candidates) {
    const match = c.exact
      ? pathname === c.href
      : pathname === c.href || pathname.startsWith(`${c.href}/`);
    if (match && (!best || c.href.length > best.href.length)) {
      best = { href: c.href, label: c.label };
    }
  }
  return best?.label ?? null;
}

function buildGroups({
  isAdminOrFormador,
  isSuperAdmin,
  isAdmin,
  espacios,
}: {
  isAdminOrFormador: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  espacios: SidebarGroup;
}): SidebarGroup[] {
  // ── Inicio ─────────────────────────────────────────────────────────────────
  const inicio: SidebarGroup = {
    label: 'Inicio',
    icon: 'home',
    items: [
      { href: '/comunidad', label: 'Feed de la comunidad', icon: 'globe', exactMatch: true },
      { href: '/inicio/mi-panel', label: 'Mi panel', icon: 'chart', exactMatch: true },
    ],
  };

  // ── Aprendizaje ────────────────────────────────────────────────────────────
  const aprendizaje: SidebarGroup = {
    label: 'Aprendizaje',
    icon: 'book',
    items: [
      { href: '/cursos', label: 'Cursos', icon: 'book' },
      { href: '/rutas', label: 'Rutas de aprendizaje', icon: 'route' },
      { href: '/mis-certificados', label: 'Certificados', icon: 'award' },
    ],
  };

  // ── Grupos ─────────────────────────────────────────────────────────────────
  const grupos: SidebarGroup = {
    label: 'Grupos',
    icon: 'users',
    items: [{ href: '/grupos', label: 'Grupos', icon: 'users' }],
  };

  // ── Agenda ─────────────────────────────────────────────────────────────────
  const agenda: SidebarGroup = {
    label: 'Agenda',
    icon: 'calendar',
    items: [
      { href: '/calendario', label: 'Calendario', icon: 'calendar' },
      { href: '/eventos', label: 'Eventos en directo', icon: 'video' },
    ],
  };

  // ── Personas ───────────────────────────────────────────────────────────────
  const personas: SidebarGroup = {
    label: 'Personas',
    icon: 'users',
    items: [
      { href: '/miembros', label: 'Miembros', icon: 'users' },
      { href: '/leaderboard', label: 'Leaderboard', icon: 'trophy' },
      { href: '/mensajes', label: 'Mensajes', icon: 'messages' },
    ],
  };

  if (!isAdminOrFormador) {
    return [inicio, espacios, aprendizaje, grupos, agenda, personas];
  }

  // ── Profesor ───────────────────────────────────────────────────────────────
  // El item "Aula virtual" del módulo `mod.zoom-live` y "Correcciones" de
  // `mod.ai-grader` NO se hardcodean acá — los aporta cada extensión vía
  // `moduleExtensions[].sidebarItems`. El core no debe conocer features de
  // un módulo (rompe el contrato de módulo).
  const profesor: SidebarGroup = {
    label: 'Profesor',
    icon: 'edit',
    items: [
      { href: '/formador', label: 'Panel', icon: 'chart', exactMatch: true },
      { href: '/formador/cursos', label: 'Mis cursos', icon: 'book' },
      { href: '/formador/rutas', label: 'Mis rutas', icon: 'route' },
      { href: '/formador/correcciones', label: 'Correcciones', icon: 'check' },
    ],
  };

  if (!isAdmin) {
    return [inicio, espacios, aprendizaje, grupos, agenda, personas, profesor];
  }

  // ── Administración ─────────────────────────────────────────────────────────
  // Consolida lo que antes eran 4 grupos separados (Tenant, Seguridad,
  // Integraciones, Facturación) en un único grupo Admin para reducir el ruido
  // en el rail. El admin ve una sola área "Administración" con todos los items.
  const administracion: SidebarGroup = {
    label: 'Administración',
    icon: 'building',
    items: [
      { href: '/admin', label: 'Panel', icon: 'chart', exactMatch: true },
      { href: '/admin/usuarios', label: 'Usuarios y roles', icon: 'users' },
      { href: '/admin/grupos-acceso', label: 'Grupos de acceso', icon: 'lock' },
      { href: '/admin/impagos', label: 'Impagos', icon: 'shield' },
      { href: '/admin/configuracion', label: 'Configuración', icon: 'cog' },
      { href: '/admin/comunidad/espacios', label: 'Espacios comunidad', icon: 'hash' },
      { href: '/admin/comunidad/tags', label: 'Tags comunidad', icon: 'message' },
      { href: '/admin/competencias', label: 'Competencias', icon: 'award' },
      { href: '/admin/branding', label: 'Branding', icon: 'palette' },
      { href: '/admin/seguridad', label: 'Seguridad', icon: 'shield' },
      { href: '/admin/auditoria', label: 'Auditoría', icon: 'shield' },
      // Features Enterprise con UI: SIEMPRE visibles (patrón EeGate, ver
      // docs/UI-EE-GATING.md). Cada página muestra upsell si la capability
      // no está activa; el backend mantiene @RequiresCapability → 402.
      { href: '/admin/sso', label: 'SSO (OIDC)', icon: 'lock' },
      { href: '/admin/sso-saml', label: 'SSO (SAML)', icon: 'lock' },
      { href: '/admin/scim', label: 'SCIM Provisioning', icon: 'users' },
      { href: '/admin/rate-limit', label: 'Límites API', icon: 'trending' },
      { href: '/admin/webhooks', label: 'Webhooks API', icon: 'package' },
      { href: '/admin/api-keys', label: 'Claves API', icon: 'code' },
      { href: '/admin/dominios', label: 'Dominios propios', icon: 'building' },
    ],
  };
  if (isSuperAdmin) {
    administracion.items.push({ href: '/admin/tenants', label: 'Tenants', icon: 'building' });
    administracion.items.push({
      href: '/super/users',
      label: 'Usuarios cross-tenant',
      icon: 'users',
    });
    administracion.items.push({
      href: '/admin/marketplace',
      label: 'Marketplace módulos',
      icon: 'package',
    });
  }

  return [inicio, espacios, aprendizaje, grupos, agenda, personas, profesor, administracion];
}
