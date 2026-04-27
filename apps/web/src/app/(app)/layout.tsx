'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { AppSidebar, type SidebarGroup } from '@/components/app-sidebar';
import { Icon } from '@/components/icon';
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
  const pathname = usePathname();
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

  const isAdminOrFormador = session.user.roles.some((r) =>
    ['super_admin', 'tenant_admin', 'formador'].includes(r),
  );
  const isSuperAdmin = session.user.roles.includes('super_admin');

  const groups = buildGroups({ isAdminOrFormador, isSuperAdmin });

  function logout() {
    authStorage.clear();
    router.replace('/signin');
  }

  return (
    <TenantThemeProvider>
      <div className="flex min-h-dvh bg-bg-subtle">
        <AppSidebar
          groups={groups}
          pathname={pathname ?? null}
          session={session}
          onLogout={logout}
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
    </TenantThemeProvider>
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
    items: [
      { href: '/cursos', label: 'Catálogo', icon: 'book' },
      { href: '/comunidad', label: 'Comunidad', icon: 'users' },
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
      { href: '/admin/auditoria', label: 'Auditoría', icon: 'shield' },
    ],
  };

  if (isSuperAdmin) {
    admin.items.push({ href: '/admin/tenants', label: 'Tenants', icon: 'building' });
  }

  return [learning, formadorAdmin, admin, account];
}
