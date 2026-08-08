'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';

interface Props {
  pathname: string | null;
  /** Abre el drawer completo (pestaña "Menú"). */
  onOpenMenu: () => void;
}

interface Tab {
  href: string;
  /** Sufijo de la key `shell.tabBar.*` con el rótulo de la pestaña. */
  labelKey: 'feed' | 'cursos' | 'miembros' | 'perfil';
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
  { href: '/comunidad', labelKey: 'feed', icon: 'globe', matches: ['/comunidad', '/espacios'] },
  { href: '/cursos', labelKey: 'cursos', icon: 'book', matches: ['/cursos'] },
  { href: '/miembros', labelKey: 'miembros', icon: 'users', matches: ['/miembros'] },
  { href: '/cuenta', labelKey: 'perfil', icon: 'user', matches: ['/cuenta'] },
];

function isActive(pathname: string, matches: string[]): boolean {
  return matches.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

export function MobileTabBar({ pathname, onOpenMenu }: Props) {
  const t = useTranslations('shell');
  const p = pathname ?? '';

  const itemClass = (active: boolean) =>
    `flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
      active ? 'text-brand-600' : 'text-text-subtle hover:text-text-muted'
    }`;

  return (
    <nav
      aria-label={t('tabBar.ariaLabel')}
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
            <span>{t(`tabBar.${tab.labelKey}`)}</span>
          </Link>
        );
      })}
      <button type="button" onClick={onOpenMenu} className={itemClass(false)}>
        <Icon name="menu" size={22} />
        <span>{t('tabBar.menu')}</span>
      </button>
    </nav>
  );
}
