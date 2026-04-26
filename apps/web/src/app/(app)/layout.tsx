'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NotificationsBell } from '@/components/notifications-bell';
import { TenantThemeProvider } from '@/components/tenant-theme-provider';
import { Button } from '@/components/ui/button';
import { authStorage, type StoredSession } from '@/lib/auth-storage';

const NAV = [
  { href: '/cursos', label: 'Catálogo' },
  { href: '/comunidad', label: 'Comunidad' },
  { href: '/mis-certificados', label: 'Mis certificados' },
  { href: '/formador', label: 'Panel formador', requiresAdmin: true, exactMatch: true },
  { href: '/formador/cursos', label: 'Mis cursos', requiresAdmin: true },
  { href: '/admin/configuracion', label: 'Configuración', requiresAdmin: true },
];

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

  function logout() {
    authStorage.clear();
    router.replace('/signin');
  }

  return (
    <TenantThemeProvider>
      <div className="min-h-dvh bg-bg-subtle">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-6xl items-center gap-6 p-4">
            <Link
              href="/"
              className="font-display text-base font-bold tracking-tight text-brand-500"
            >
              Didacta
            </Link>
            <nav className="flex gap-1">
              {NAV.filter((item) => !item.requiresAdmin || isAdminOrFormador).map((item) => {
                const isActive = item.exactMatch
                  ? pathname === item.href
                  : (pathname?.startsWith(item.href) ?? false);
                return (
                  <Link
                    key={item.href}
                    href={item.href as never}
                    className={
                      isActive
                        ? 'rounded-md bg-brand-50 px-3 py-1.5 text-sm font-semibold text-brand-700'
                        : 'rounded-md px-3 py-1.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text'
                    }
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <NotificationsBell />
              <span className="text-text-muted">
                {session.user.name ?? session.user.email}
                <span className="ml-2 text-xs text-text-subtle">@ {session.user.tenantSlug}</span>
              </span>
              <Button variant="outline" size="sm" onClick={logout}>
                Salir
              </Button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl p-4 lg:p-8">{children}</main>
      </div>
    </TenantThemeProvider>
  );
}
