'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
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

  const isAdminOrFormador = session.user.roles.some((r) =>
    ['super_admin', 'tenant_admin', 'formador'].includes(r),
  );
  const isSuperAdmin = session.user.roles.includes('super_admin');

  const groups = buildGroups({
    isAdminOrFormador,
    isSuperAdmin,
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
}: {
  isAdminOrFormador: boolean;
  isSuperAdmin: boolean;
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
      { href: '/cuenta/suscripciones', label: 'Suscripciones', icon: 'package' },
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
      // "Webhooks API" — 10º piloto License SDK (gate
      // `feat:api.webhooks.high_throughput`). El item es SIEMPRE visible:
      // CRUD endpoints es funcional en community con límites estrictos
      // (1 endpoint, 3 eventos), y EE desbloquea cola BullMQ + HMAC + DLQ.
      { href: '/admin/webhooks', label: 'Webhooks API', icon: 'package' },
      // "Pagos" — mod.billing (CE). Vincula cursos a Stripe Price IDs para
      // que el catálogo abra Checkout. NO es feature EE — sin gate.
      { href: '/admin/billing/products', label: 'Pagos (Stripe)', icon: 'package' },
    ],
  };

  // Features Enterprise con UI: SIEMPRE visibles para community (patrón n8n,
  // documentado en docs/UI-EE-GATING.md). Cada página aplica <EeGate> por
  // dentro y muestra upsell card cuando la capability no está activa. El
  // backend mantiene @RequiresCapability en cada endpoint admin → 402 sin
  // licencia. La discoverability de la feature es parte del valor para
  // community → enterprise (cada página es una superficie de pricing).
  admin.items.push({ href: '/admin/dominios', label: 'Dominios propios', icon: 'building' });
  admin.items.push({ href: '/admin/scim', label: 'SCIM Provisioning', icon: 'users' });
  admin.items.push({ href: '/admin/sso', label: 'SSO (OIDC)', icon: 'lock' });
  admin.items.push({ href: '/admin/sso-saml', label: 'SSO (SAML)', icon: 'lock' });

  if (isSuperAdmin) {
    admin.items.push({ href: '/admin/tenants', label: 'Tenants', icon: 'building' });
  }

  return [learning, formadorAdmin, admin, account];
}
