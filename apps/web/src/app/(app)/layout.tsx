'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NotificationsBell } from '@/components/notifications-bell';
import { Button } from '@/components/ui/button';
import { authStorage, type StoredSession } from '@/lib/auth-storage';

const NAV = [
  { href: '/cursos', label: 'Catálogo' },
  { href: '/mis-certificados', label: 'Mis certificados' },
  { href: '/formador/cursos', label: 'Mis cursos', requiresAdmin: true },
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
    <div className="min-h-dvh bg-neutral-50 dark:bg-neutral-900">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-6xl items-center gap-6 p-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            LearnShip
          </Link>
          <nav className="flex gap-2">
            {NAV.filter((item) => !item.requiresAdmin || isAdminOrFormador).map((item) => (
              <Link
                key={item.href}
                href={item.href as never}
                className={
                  pathname?.startsWith(item.href)
                    ? 'rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium dark:bg-neutral-800'
                    : 'rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <NotificationsBell />
            <span className="text-neutral-500">
              {session.user.name ?? session.user.email}
              <span className="ml-2 text-xs text-neutral-400">@ {session.user.tenantSlug}</span>
            </span>
            <Button variant="outline" size="sm" onClick={logout}>
              Salir
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4 lg:p-8">{children}</main>
    </div>
  );
}
