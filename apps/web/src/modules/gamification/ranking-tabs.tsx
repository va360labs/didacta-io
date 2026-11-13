'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { cn } from '@/lib/utils';

const TABS: Array<{
  href: '/leaderboard' | '/challenges';
  key: 'ranking' | 'retos';
  icon: IconName;
}> = [
  { href: '/leaderboard', key: 'ranking', icon: 'trophy' },
  { href: '/challenges', key: 'retos', icon: 'target' },
];

/**
 * «Ranking · Retos»: las dos caras de los puntos, una al lado de la otra. En
 * modo sencillo los retos no tienen pestaña propia (viven «dentro del
 * ranking»), y sin este enlace el alumno no tenía por dónde llegar a ellos.
 */
export function RankingTabs() {
  const t = useTranslations('alumnoSocial.rankingTabs');
  const pathname = usePathname() ?? '';
  return (
    <nav
      aria-label={t('aria')}
      className="inline-flex rounded-xl border border-border bg-surface p-1"
      data-testid="ranking-retos"
    >
      {TABS.map((tab) => {
        const on = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-colors',
              on ? 'bg-text text-surface' : 'text-text-muted hover:text-text',
            )}
          >
            <Icon name={tab.icon} size={15} />
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
