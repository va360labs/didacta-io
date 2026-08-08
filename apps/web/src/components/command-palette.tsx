'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { labelOr } from '@/lib/i18n/labels';
import { Dialog } from '@/components/ui/dialog';
import type { SidebarGroup } from '@/components/app-sidebar';

interface PaletteItem {
  href: string;
  label: string;
  group: string;
  icon: SidebarGroup['items'][number]['icon'];
  emoji?: string;
}

/**
 * Command palette (⌘K) de navegación. Aplana los grupos del sidebar en una lista
 * buscable; filtra por label y grupo, se navega con flechas + Enter, se cierra
 * con Esc. Reemplaza el buscador decorativo del sidebar (BUG-004).
 */
export function CommandPalette({
  open,
  onClose,
  groups,
}: {
  open: boolean;
  onClose: () => void;
  groups: SidebarGroup[];
}) {
  const router = useRouter();
  const t = useTranslations('shell');
  // Los `label`/`group` del sidebar son TOKENS canónicos en español (ver
  // SidebarContent); aquí se resuelven a su PRESENTACIÓN antes de aplanar, para
  // que la lista se muestre Y se filtre en el idioma activo.
  const tNav = useTranslations('nav');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<PaletteItem[]>(
    () =>
      groups.flatMap((g) =>
        g.items
          .filter((i) => i.href)
          .map((i) => ({
            href: i.href,
            label: labelOr(tNav, `items.${i.label}`, i.label),
            group: labelOr(tNav, `groups.${g.label}`, g.label),
            icon: i.icon,
            emoji: i.emoji,
          })),
      ),
    [groups, tNav],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(needle) || i.group.toLowerCase().includes(needle),
    );
  }, [q, items]);

  // Reset al abrir; y al teclear vuelve al primer resultado.
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    setActive(0);
  }, [q]);

  // Mantiene visible el item activo al navegar con flechas.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(href: string) {
    onClose();
    router.push(href as Parameters<typeof router.push>[0]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[active];
      if (it) go(it.href);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      ariaLabel={t('palette.ariaLabel')}
      maxWidthClass="max-w-lg"
      contentClassName="p-0 overflow-hidden"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon name="search" size={16} className="shrink-0 text-text-subtle" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('palette.placeholder')}
          className="w-full bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none"
          aria-label={t('palette.inputAriaLabel')}
        />
      </div>
      <ul ref={listRef} className="max-h-80 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-text-muted">
            {t('palette.noResults')}
          </li>
        ) : (
          filtered.map((it, idx) => (
            <li key={`${it.group}-${it.href}`}>
              <button
                type="button"
                data-idx={idx}
                onClick={() => go(it.href)}
                onMouseEnter={() => setActive(idx)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                  idx === active ? 'bg-surface-3 text-text' : 'text-text-muted'
                }`}
              >
                {it.emoji ? (
                  <span className="w-4 shrink-0 text-center">{it.emoji}</span>
                ) : (
                  <Icon name={it.icon} size={16} className="shrink-0 text-text-subtle" />
                )}
                <span className="flex-1 truncate">{it.label}</span>
                <span className="shrink-0 text-xs text-text-subtle">{it.group}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </Dialog>
  );
}
