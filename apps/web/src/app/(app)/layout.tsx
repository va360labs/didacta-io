'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LICENSE_CAPABILITIES, useLicense } from '@didacta/license-sdk/react';
import { AppSidebar, type SidebarGroup } from '@/components/app-sidebar';
import { Icon } from '@/components/icon';
import { LicenseProvider } from '@/components/license-provider';
import { NotificationsBell } from '@/components/notifications-bell';
import { TenantThemeProvider } from '@/components/tenant-theme-provider';
import { authStorage, type StoredSession } from '@/lib/auth-storage';

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
  const { isCapabilityEnabled } = useLicense();

  const isAdminOrFormador = session.user.roles.some((r) =>
    ['super_admin', 'tenant_admin', 'formador'].includes(r),
  );
  const isSuperAdmin = session.user.roles.includes('super_admin');

  const groups = buildGroups({
    isAdminOrFormador,
    isSuperAdmin,
    customDomainsEnabled: isCapabilityEnabled(LICENSE_CAPABILITIES.CUSTOM_DOMAINS),
    scimEnabled: isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM),
  });

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
  customDomainsEnabled,
  scimEnabled,
}: {
  isAdminOrFormador: boolean;
  isSuperAdmin: boolean;
  customDomainsEnabled: boolean;
  scimEnabled: boolean;
}): SidebarGroup[] {
  const learning: SidebarGroup = {
    label: 'Aprendizaje',
    items: [
      { href: '/cursos', label: 'Catálogo', icon: 'book' },
      { href: '/comunidad', label: 'Comunidad', icon: 'users' },
      { href: '/comunidad/menciones', label: 'Mis menciones', icon: 'message' },
      { href: '/mis-certificados', label: 'Mis certificados', icon: 'award' },
      { href: '/notificaciones', label: 'Notificaciones', icon: 'bell' },
    ],
  };

  const account: SidebarGroup = {
    label: 'Mi cuenta',
    items: [
      { href: '/cuenta', label: 'Perfil', icon: 'user', exactMatch: true },
      { href: '/cuenta/seguridad', label: 'Seguridad', icon: 'lock' },
    ],
  };

  if (!isAdminOrFormador) {
    return [learning, account];
  }

  const formadorAdmin: SidebarGroup = {
    label: 'Formador',
    items: [
      { href: '/formador', label: 'Panel', icon: 'home', exactMatch: true },
      { href: '/formador/cursos', label: 'Mis cursos', icon: 'book' },
      { href: '/formador/aula-virtual', label: 'Aula virtual', icon: 'calendar' },
      { href: '/formador/correcciones', label: 'Correcciones', icon: 'check' },
      { href: '/formador/certificados/templates', label: 'Plantillas certificado', icon: 'award' },
    ],
  };

  const admin: SidebarGroup = {
    label: 'Administración',
    items: [
      { href: '/admin', label: 'Panel del tenant', icon: 'chart', exactMatch: true },
      { href: '/admin/usuarios', label: 'Usuarios', icon: 'users' },
      { href: '/admin/configuracion', label: 'Configuración', icon: 'cog' },
      { href: '/admin/branding', label: 'Branding', icon: 'palette' },
      { href: '/admin/seguridad', label: 'Seguridad', icon: 'lock' },
      { href: '/admin/fundae', label: 'Fundae', icon: 'file' },
      { href: '/admin/auditoria', label: 'Auditoría', icon: 'shield' },
      // "Límites API" — sexto piloto License SDK (gate
      // `feat:api.rate_limit.elevated`). El item es SIEMPRE visible: la
      // página informa al admin community del rate "fair" actual y le
      // ofrece upsell a Enterprise sin tener que llamar a ventas. El gate
      // EE solo aplica al botón de upgrade dentro de la página.
      { href: '/admin/rate-limit', label: 'Límites API', icon: 'trending' },
    ],
  };

  // "Dominios propios" — gateado por capability `feat:custom_domains` (cuarto
  // piloto License SDK). Sólo aparece en el sidebar cuando la licencia EE
  // está activa. Si el admin escribe la URL a mano, la página se renderiza
  // pero todos los endpoints devolverán 402 vía LicenseExceptionFilter.
  if (customDomainsEnabled) {
    admin.items.push({ href: '/admin/dominios', label: 'Dominios propios', icon: 'building' });
  }

  // "SCIM Provisioning" — gateado por capability `feat:scim` (séptimo piloto
  // License SDK). Mismo patrón que custom-domains: sólo aparece con licencia
  // EE activa. La página se renderiza igual si entran por URL directa, pero
  // el panel queda con upsell card y los endpoints /api/v1/admin/scim/* +
  // /scim/v2/Users devuelven 402.
  if (scimEnabled) {
    admin.items.push({ href: '/admin/scim', label: 'SCIM Provisioning', icon: 'users' });
  }

  if (isSuperAdmin) {
    admin.items.push({ href: '/admin/tenants', label: 'Tenants', icon: 'building' });
  }

  return [learning, formadorAdmin, admin, account];
}
