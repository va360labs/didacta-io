'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AppSidebar, type SidebarGroup } from '@/components/app-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Icon } from '@/components/icon';
import { LicenseProvider } from '@/components/license-provider';
import { NotificationsBell } from '@/components/notifications-bell';
import { ReferralsPromoButton } from '@/components/referrals-promo-button';
import { NotificationsProvider } from '@/components/notifications-provider';
import { NotificationsToaster } from '@/components/notifications-toaster';
import { FloatingChat, MessagingProvider } from '@/modules/messaging';
import { authStorage, type StoredSession } from '@/lib/auth-storage';
import { clearIntendedPath, rememberIntendedPath } from '@/lib/post-login-redirect';
import { meApi } from '@/lib/me';
import { labelOr } from '@/lib/i18n/labels';
import { formatTenantName } from '@/lib/tenant-name';
import { useTenantContext } from '@/lib/tenant-context';
import { mergeExtensionSidebarItems } from '@/lib/sidebar-extensions-merge';
import { filterByActiveModules } from '@/lib/sidebar-modules-filter';
import {
  buildGroups,
  buildAdminGroups,
  applyAdminBadges,
  ADMIN_BACK_LINK,
} from '@/lib/sidebar-nav';
import { useAdminPendingCounts } from '@/lib/admin-pending-counts';
import { moduleExtensions } from '@/modules';
import { useCommunitySpaces, invalidateCommunitySpacesCache } from '@/modules/community';
import { themeCache, requestThemeRefresh } from '@/lib/theming';
import { isIconName } from '@/components/space-icon';
import type { IconName } from '@/components/icon';
import { CreateSpaceModal } from '@/components/create-space-modal';
import { MobileNavDrawer } from '@/components/mobile-nav-drawer';
import { MobileTabBar } from '@/components/mobile-tab-bar';

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
      // Deep link (p. ej. enlace compartido de un post): guardamos la ruta que
      // intentaba abrir para volver a ella al completar el login.
      rememberIntendedPath(window.location.pathname + window.location.search);
      router.replace('/signin');
      return;
    }
    // Contraseña temporal (p.ej. alta por `POST /inscribe`): forzamos el cambio
    // antes de dejar usar el resto de la app. Al cambiarla, la pantalla de
    // seguridad limpia la sesión y redirige a /signin → el nuevo login ya viene
    // sin el flag, así que no hay bucle.
    if (current.user.mustChangePassword && pathname !== ACCOUNT_PATH) {
      // El gate desvía la navegación: re-guardamos el destino pedido para que
      // sobreviva al ciclo cambio-de-contraseña → re-login y se abra al final.
      rememberIntendedPath(window.location.pathname + window.location.search);
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
      // Ídem: el asistente de onboarding consume este destino al terminar.
      // Cubre también el login SSO/WP-SSO, cuya sesión no trae el flag y pasa
      // SIEMPRE por este gate antes de llegar al deep link.
      rememberIntendedPath(window.location.pathname + window.location.search);
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
    // Un destino pendiente huérfano no debe redirigir al próximo login de esta
    // pestaña (posiblemente otro usuario) al post que miraba el anterior.
    clearIntendedPath();
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
  const t = useTranslations('alumnoSocial');

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

  // Drawer de navegación móvil. Se cierra ante CUALQUIER cambio de ruta (tap en
  // un item, botón atrás del navegador, navegación programática): el `onNavigate`
  // de los links da el cierre inmediato y este efecto es la red de seguridad.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Command palette (⌘K / Ctrl+K) — buscador de navegación global.
  const [cmdOpen, setCmdOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Cierra el palette al navegar.
  useEffect(() => {
    setCmdOpen(false);
  }, [pathname]);

  const rawSpaces = useCommunitySpaces();
  // Bloque 9 (simplificar navegación): los canales tipo foro se agrupan bajo un
  // único menú "Foros" plegable — plegado por defecto salvo que estés dentro de
  // un espacio. Ningún módulo declara `group: 'Foros'` ni 'Espacios' en sus
  // sidebarItems, así que el rename no rompe el merge de extensiones.
  const espaciosGroup: SidebarGroup = {
    label: 'Foros',
    icon: 'hash',
    collapsible: true,
    canAdd: isAdmin,
    onAdd: isAdmin ? () => setCreateSpaceOpen(true) : undefined,
    items: rawSpaces.map((s) => ({
      href: `/espacios/${s.slug}`,
      label: s.title,
      icon: (isIconName(s.icon) ? s.icon : 'hash') as IconName,
      emoji: isIconName(s.icon) ? undefined : s.icon,
    })),
  };

  // Área de admin: cuando el admin está en /admin o /super, el sidebar cambia a
  // las sub-secciones de administración (buildAdminGroups). Fuera de ahí, el
  // menú principal (con una sola entrada "Administración").
  const isAdminArea =
    isAdmin && ((pathname ?? '').startsWith('/admin') || (pathname ?? '').startsWith('/super'));
  const baseGroups = isAdminArea
    ? buildAdminGroups({ isSuperAdmin })
    : buildGroups({
        isAdminOrFormador,
        isAdmin,
        isSuperAdmin,
        espacios: espaciosGroup,
      });
  const userRoles = new Set(session.user.roles);
  const mergedGroups = mergeExtensionSidebarItems(baseGroups, moduleExtensions, userRoles);
  const filteredGroups = filterByActiveModules(mergedGroups, activeModules);
  // Badges de trabajo pendiente (solicitudes de inscripción, impagos). Se
  // aplican al final para que alcancen también a items aportados por módulos.
  const pendingCounts = useAdminPendingCounts(isAdminArea);
  const groups = isAdminArea ? applyAdminBadges(filteredGroups, pendingCounts) : filteredGroups;

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
  const sectionExtras = useMemo(
    () => [
      { href: '/cuenta', label: t('shell.seccionMiPerfil') },
      // /grupos ya no tiene item en el sidebar (bloque 9) pero la ruta sigue viva.
      { href: '/grupos', label: t('shell.seccionGrupos') },
      // Ídem /rutas: item del alumno retirado del menú, la página sigue accesible
      // por URL y desde el detalle de una ruta.
      { href: '/rutas', label: t('shell.seccionRutas') },
    ],
    [t],
  );
  // Los `label` del sidebar son TOKENS canónicos en español (ver SidebarContent):
  // sin resolverlos, con la UI en inglés el `<title>` del navegador mezclaría
  // idiomas. `labelOr` degrada al token crudo si no hay traducción. Los extras
  // de arriba ya llegan traducidos por `t`, así que se emiten tal cual (pasarlos
  // por `labelOr` buscaría una key `nav.items.<texto ya traducido>` que no existe).
  const tNav = useTranslations('nav');
  const sectionMatch = resolveSectionLabel(mergedGroups, pathname ?? '', sectionExtras);
  const sectionLabel = sectionMatch
    ? sectionMatch.fromExtras
      ? sectionMatch.label
      : labelOr(tNav, `items.${sectionMatch.label}`, sectionMatch.label)
    : null;
  useEffect(() => {
    const parts = [sectionLabel, tenantName, 'Didacta'].filter((p): p is string => Boolean(p));
    document.title = parts.join(' | ');
  }, [sectionLabel, tenantName]);

  return (
    <NotificationsProvider>
      <MessagingProvider>
        <div className="flex min-h-dvh bg-bg-subtle">
          <CreateSpaceModal open={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />
          <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} groups={groups} />
          <AppSidebar
            groups={groups}
            pathname={pathname ?? null}
            session={session}
            onLogout={onLogout}
            onOpenSearch={() => setCmdOpen(true)}
            backLink={isAdminArea ? ADMIN_BACK_LINK : undefined}
          />

          {/* Drawer de navegación — solo móvil (<lg). Reutiliza el mismo sidebar. */}
          <MobileNavDrawer
            open={mobileNavOpen}
            onClose={() => setMobileNavOpen(false)}
            groups={groups}
            pathname={pathname ?? null}
            session={session}
            onLogout={onLogout}
            onOpenSearch={() => setCmdOpen(true)}
            backLink={isAdminArea ? ADMIN_BACK_LINK : undefined}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-(--z-sticky) flex h-14 items-center gap-2 border-b border-border-soft bg-surface/95 px-4 backdrop-blur lg:px-6">
              {/* Móvil: hamburguesa + marca. En escritorio el rail ya provee ambos. */}
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label={t('shell.abrirMenu')}
                aria-expanded={mobileNavOpen}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text lg:hidden"
              >
                <Icon name="menu" size={18} />
              </button>
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-text lg:hidden">
                {tenantName}
              </span>

              {/* Empuja las acciones a la derecha (equivale al justify-end de escritorio). */}
              <div className="hidden flex-1 lg:block" />

              {/* Promo del programa de referidos — solo si está activo (el % es real). */}
              <ReferralsPromoButton />

              {/* El icono de mensajes vivía aquí. Ahora el chat es la píldora
                  flotante de abajo a la derecha: un solo indicador de no-leídos
                  en pantalla (regla #5, PRD chat-flotante UC-CF203). */}
              <NotificationsBell />
            </header>

            {/* pb-24 en todos los breakpoints (no solo móvil): dejamos hueco bajo
                el contenido igual de alto que la píldora fija del chat flotante
                (abajo a la derecha, ver FloatingChat) para que, al hacer scroll
                hasta el final de una página larga, ningún botón (p.ej. "Guardar")
                termine geométricamente debajo de la píldora — solapamiento real
                detectado en /admin/branding y el constructor de cursos.
                OJO: `lg:py-6` (shorthand) también fija padding-bottom y pisaba a
                `pb-24` en ese breakpoint porque los prefijos responsive cascadean
                después de las utilidades sin prefijo — por eso aquí es `lg:pt-6`
                (solo top), nunca `lg:py-*` ni `lg:pb-*`. */}
            <main className="flex-1 px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:pt-6">
              <div className="mx-auto max-w-[1280px]">{children}</div>
            </main>
          </div>

          {/* Barra inferior de pestañas — solo móvil (<lg). */}
          <MobileTabBar pathname={pathname ?? null} onOpenMenu={() => setMobileNavOpen(true)} />
        </div>
        <FloatingChat />
        <NotificationsToaster />
      </MessagingProvider>
    </NotificationsProvider>
  );
}

/**
 * Deriva el label de la sección actual a partir del pathname, reutilizando el
 * mapa ruta→label del sidebar (más `extras`: rutas sin item de menú que igual
 * merecen nombre en el `<title>`, ya traducidas por quien llama). Match por
 * prefijo más largo (la ruta más específica gana); respeta `exactMatch`.
 * Devuelve null si ninguna ruta coincide (el `<title>` cae a "Tenant | Didacta").
 *
 * `fromExtras` distingue el origen del label: los del sidebar son tokens
 * canónicos en español que el llamante aún tiene que pasar por `labelOr`; los
 * de `extras` ya vienen traducidos y se emiten tal cual.
 */
function resolveSectionLabel(
  groups: SidebarGroup[],
  pathname: string,
  extras: ReadonlyArray<{ href: string; label: string }>,
): { label: string; fromExtras: boolean } | null {
  if (!pathname) return null;
  const candidates: Array<{
    href: string;
    label: string;
    exact?: boolean;
    fromExtras?: boolean;
  }> = [];
  for (const g of groups) {
    for (const it of g.items) {
      if (it.href) candidates.push({ href: it.href, label: it.label, exact: it.exactMatch });
    }
  }
  for (const e of extras) {
    candidates.push({ href: e.href, label: e.label, fromExtras: true });
  }

  let best: { href: string; label: string; fromExtras: boolean } | null = null;
  for (const c of candidates) {
    const match = c.exact
      ? pathname === c.href
      : pathname === c.href || pathname.startsWith(`${c.href}/`);
    if (match && (!best || c.href.length > best.href.length)) {
      best = { href: c.href, label: c.label, fromExtras: c.fromExtras ?? false };
    }
  }
  return best ? { label: best.label, fromExtras: best.fromExtras } : null;
}

// `buildGroups` y `buildAdminGroups` viven ahora en `@/lib/sidebar-nav` — son
// funciones puras y así los guards pueden importarlas en vez de hacer regex
// sobre este archivo (ver `sidebar-nav.test.ts`).
