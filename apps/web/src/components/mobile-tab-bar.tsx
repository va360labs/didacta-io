'use client';

import Link from 'next/link';
import { Icon, type IconName } from '@/components/icon';

interface Props {
  pathname: string | null;
  /** Abre el drawer completo (pestaña "Menú"). */
  onOpenMenu: () => void;
}

interface Tab {
  href: string;
  label: string;
  icon: IconName;
  /** Prefijos de ruta que marcan la pestaña como activa. */
  matches: string[];
}

/**
 * Destinos de acceso rápido con el pulgar. El resto de secciones (Agenda,
 * Grupos, Certificados, área Admin…) se alcanzan por la pestaña "Menú", que
 * abre el drawer con la navegación completa. Todas las rutas existen como
 * páginas índice reales (sin enlaces a 404). "Feed" también queda activa dentro
 * de un espacio de comunidad (`/espacios/...`), que es contenido del feed.
 */
const TABS: Tab[] = [
  { href: '/comunidad', label: 'Feed', icon: 'globe', matches: ['/comunidad', '/espacios'] },
  { href: '/cursos', label: 'Cursos', icon: 'book', matches: ['/cursos'] },
  { href: '/miembros', label: 'Miembros', icon: 'users', matches: ['/miembros'] },
  { href: '/cuenta', label: 'Perfil', icon: 'user', matches: ['/cuenta'] },
];

function isActive(pathname: string, matches: string[]): boolean {
  return matches.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

export function MobileTabBar({ pathname, onOpenMenu }: Props) {
  const p = pathname ?? '';

  const itemClass = (active: boolean) =>
    `flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
      active ? 'text-brand-600' : 'text-text-subtle hover:text-text-muted'
    }`;

  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-(--z-sticky) flex items-stretch border-t border-border-soft bg-surface/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((tab) => {
        const active = isActive(p, tab.matches);
        return (
          <Link
            key={tab.href}
            href={tab.href as never}
            aria-current={active ? 'page' : undefined}
            className={itemClass(active)}
          >
            <Icon name={tab.icon} size={22} strokeWidth={active ? 2 : 1.75} />
            <span>{tab.label}</span>
          </Link>
        );
      })}
      <button type="button" onClick={onOpenMenu} className={itemClass(false)}>
        <Icon name="menu" size={22} />
        <span>Menú</span>
      </button>
    </nav>
  );
}
