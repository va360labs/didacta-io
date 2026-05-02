'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { AppSidebar, type SidebarGroup } from '@/components/app-sidebar';
import { Icon } from '@/components/icon';
import { LicenseProvider } from '@/components/license-provider';
import { NotificationsBell } from '@/components/notifications-bell';
import { TenantThemeProvider } from '@/components/tenant-theme-provider';
import { authStorage, type StoredSession } from '@/lib/auth-storage';
import { meApi } from '@/lib/me';
import { filterByActiveModules } from '@/lib/sidebar-modules-filter';

/**
 * Shell de la app autenticada — sidebar persistente Didacta + main canvas.
 *
 * Las páginas siguen renderizando su propio `<h1>` y contenido. El shell solo
 * provee navegación + bell de notificaciones. Esto evita refactorizar
 * cada page y permite aplicar el UI kit progresivamente.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<StoredSession | null>(null);

  useEffect(() => {
    const current = authStorage.getSession();
    if (!current) {
      router.replace('/signin');
      return;
    }
    setSession(current);
  }, [router]);

  if (!session) return null;

  function logout() {
    authStorage.clear();
    router.replace('/signin');
  }

  return (
    <LicenseProvider>
      <TenantThemeProvider>
        <Shell session={session} onLogout={logout}>
          {children}
        </Shell>
      </TenantThemeProvider>
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
  const isSuperAdmin = session.user.roles.includes('super_admin');

  // Módulos activos para el tenant del usuario. Mientras está null (primer
  // render) no filtramos — el sidebar se pinta completo y se reordena al
  // resolver la promesa. El backend sigue gateando con ModuleAccessInterceptor
  // aunque el usuario haga clic antes de que llegue la respuesta.
  // Cargamos el estado de módulos al montar Y cada vez que cambia el
  // pathname. El re-fetch al navegar cubre el caso típico: el admin
  // desactiva un módulo en /admin/configuracion y al saltar a cualquier
  // otra ruta el sidebar refleja el cambio sin necesidad de recargar.
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
  }, [pathname]);

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

  const allGroups = buildGroups({
    isAdminOrFormador,
    isSuperAdmin,
  });
  const groups = filterByActiveModules(allGroups, activeModules);

  return (
    <div className="flex min-h-dvh bg-bg-subtle">
      <AppSidebar
        groups={groups}
        pathname={pathname ?? null}
        session={session}
        onLogout={onLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-sticky flex h-14 items-center justify-end gap-2 border-b border-border-soft bg-surface/95 px-6 backdrop-blur">
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text"
            aria-label="Mensajes"
          >
            <Icon name="message" size={18} />
          </button>
          <NotificationsBell />
        </div>

        <main className="flex-1 px-8 py-6">
          <div className="mx-auto max-w-[1280px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

function buildGroups({
  isAdminOrFormador,
  isSuperAdmin,
}: {
  isAdminOrFormador: boolean;
  isSuperAdmin: boolean;
}): SidebarGroup[] {
  const learning: SidebarGroup = {
    label: 'Aprendizaje',
    icon: 'book',
    items: [
      { href: '/cursos', label: 'Catálogo', icon: 'book' },
      { href: '/notificaciones', label: 'Notificaciones', icon: 'bell' },
    ],
  };

  if (!isAdminOrFormador) {
    return [learning];
  }

  const formadorAdmin: SidebarGroup = {
    label: 'Formador',
    icon: 'chart',
    items: [
      { href: '/formador', label: 'Panel', icon: 'home', exactMatch: true },
      { href: '/formador/cursos', label: 'Mis cursos', icon: 'book' },
      {
        href: '/formador/aula-virtual',
        label: 'Aula virtual',
        icon: 'calendar',
        requiresModule: 'mod.zoom-live',
      },
      {
        href: '/formador/correcciones',
        label: 'Correcciones',
        icon: 'check',
        requiresModule: 'mod.ai-grader',
      },
    ],
  };

  // ─── Áreas Admin (rediseño D: una casilla por área en el rail) ────────────
  // Agrupación semántica: items relacionados van juntos. Antes existía un
  // único grupo "Administración" con 12+ items en una lista plana — ahora
  // el rail sub-divide por contexto operativo del admin.

  const tenant: SidebarGroup = {
    label: 'Tenant',
    icon: 'building',
    items: [
      { href: '/admin', label: 'Panel del tenant', icon: 'chart', exactMatch: true },
      { href: '/admin/usuarios', label: 'Usuarios', icon: 'users' },
      { href: '/admin/configuracion', label: 'Configuración', icon: 'cog' },
      { href: '/admin/branding', label: 'Branding', icon: 'palette' },
    ],
  };
  if (isSuperAdmin) {
    tenant.items.push({ href: '/admin/tenants', label: 'Tenants', icon: 'building' });
    tenant.items.push({ href: '/super/users', label: 'Usuarios cross-tenant', icon: 'users' });
  }

  // Features Enterprise con UI: SIEMPRE visibles para community (patrón n8n,
  // documentado en docs/UI-EE-GATING.md). Cada página aplica <EeGate> por
  // dentro y muestra upsell card cuando la capability no está activa. El
  // backend mantiene @RequiresCapability en cada endpoint admin → 402 sin
  // licencia. La discoverability de la feature es parte del valor para
  // community → enterprise (cada página es una superficie de pricing).
  const seguridad: SidebarGroup = {
    label: 'Seguridad',
    icon: 'shield',
    items: [
      { href: '/admin/seguridad', label: 'Seguridad (MFA)', icon: 'lock' },
      { href: '/admin/auditoria', label: 'Auditoría', icon: 'shield' },
      { href: '/admin/sso', label: 'SSO (OIDC)', icon: 'lock' },
      { href: '/admin/sso-saml', label: 'SSO (SAML)', icon: 'lock' },
      { href: '/admin/scim', label: 'SCIM Provisioning', icon: 'users' },
    ],
  };

  const integraciones: SidebarGroup = {
    label: 'Integraciones',
    icon: 'package',
    items: [
      // "Límites API" — sexto piloto License SDK (gate
      // `feat:api.rate_limit.elevated`). El item es SIEMPRE visible: la
      // página informa al admin community del rate "fair" actual y le
      // ofrece upsell a Enterprise sin tener que llamar a ventas.
      { href: '/admin/rate-limit', label: 'Límites API', icon: 'trending' },
      // "Webhooks API" — 10º piloto License SDK (gate
      // `feat:api.webhooks.high_throughput`). El item es SIEMPRE visible:
      // CRUD endpoints funcional en community con límites estrictos.
      { href: '/admin/webhooks', label: 'Webhooks API', icon: 'package' },
      { href: '/admin/dominios', label: 'Dominios propios', icon: 'building' },
    ],
  };
  if (isSuperAdmin) {
    integraciones.items.push({
      href: '/admin/marketplace',
      label: 'Marketplace módulos',
      icon: 'package',
    });
  }

  const facturacion: SidebarGroup = {
    label: 'Facturación',
    icon: 'package',
    items: [
    ],
  };

  return [learning, formadorAdmin, tenant, seguridad, integraciones, facturacion];
}
