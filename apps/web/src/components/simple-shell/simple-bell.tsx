'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { useNotificationsContext } from '@/components/notifications-provider';
import { notificationLink } from '@/lib/notification-link';
import { notificationsApi, type Notification } from '@/lib/notifications';
import { cn } from '@/lib/utils';
import { Counter, useOutsideClose } from './shell-utils';

/** Plantilla de las menciones (`@nombre` en la comunidad). */
export const MENTION_TEMPLATE = 'community.mention';

export type BellFilter = 'all' | 'mentions';

/** Filtro puro del panel: «Menciones» = solo las notificaciones de mención. */
export function filterNotifications(list: Notification[], filter: BellFilter): Notification[] {
  return filter === 'mentions' ? list.filter((n) => n.templateKey === MENTION_TEMPLATE) : list;
}

/**
 * Campanita del modo sencillo: un panel con las notificaciones y dos filtros,
 * Todas y Menciones. Las menciones dejan de ser una página del menú («Mis
 * menciones»): llegan aquí, con su texto y un enlace para responder.
 */
export function SimpleBell() {
  const t = useTranslations('modoSencillo');
  const tLib = useTranslations('libShared');
  const router = useRouter();
  const { unreadCount, refresh } = useNotificationsContext();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<BellFilter>('all');
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(ref, open, close);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(false);
    notificationsApi
      .listMine()
      .then((list) => {
        if (!cancelled) setItems(list.filter((n) => n.channel === 'IN_APP'));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const visible = items ? filterNotifications(items, filter) : null;
  const unreadMentions = items
    ? items.filter((n) => n.templateKey === MENTION_TEMPLATE && !n.readAt).length
    : 0;

  async function openItem(n: Notification, href: string) {
    if (!n.readAt) {
      await notificationsApi.markRead(n.id).catch(() => undefined);
      refresh();
    }
    setOpen(false);
    router.push(href);
  }

  async function markAll() {
    await notificationsApi.markAllRead().catch(() => undefined);
    setItems(
      (prev) => prev?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? prev,
    );
    refresh();
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          unreadCount > 0
            ? t('shell.notificacionesSinLeer', { count: unreadCount })
            : t('shell.notificaciones')
        }
        className={cn(
          'relative grid h-10 w-10 place-items-center rounded-xl text-text-muted hover:bg-bg-subtle hover:text-text',
          open && 'bg-bg-subtle text-text',
        )}
        data-testid="simple-bell"
      >
        <Icon name="bell" size={20} />
        {unreadCount > 0 ? <Counter n={unreadCount} /> : null}
      </button>

      {open ? (
        <section
          role="dialog"
          aria-label={t('campana.titulo')}
          className="fixed inset-x-0 top-[60px] bottom-0 z-(--z-dropdown) flex flex-col bg-surface lg:absolute lg:inset-auto lg:top-12 lg:right-0 lg:max-h-[620px] lg:w-[420px] lg:rounded-2xl lg:border lg:border-border lg:shadow-lg"
        >
          <header className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="text-lg font-bold text-text">{t('campana.titulo')}</h2>
            <button
              type="button"
              onClick={markAll}
              className="text-sm font-semibold text-brand-600 hover:underline"
            >
              {t('campana.marcarTodo')}
            </button>
          </header>
          <div role="tablist" className="flex gap-2 border-b border-border px-4 pb-3">
            {(['all', 'mentions'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-semibold',
                  filter === f
                    ? 'border-text bg-text text-surface'
                    : 'border-border bg-surface text-text-muted',
                )}
              >
                {f === 'all' ? t('campana.todas') : t('campana.menciones')}
                {f === 'mentions' && unreadMentions > 0 ? (
                  <span className="rounded-full bg-red-600 px-1.5 text-[11px] leading-[18px] font-bold text-white">
                    {unreadMentions}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <ul className="min-h-0 flex-1 overflow-auto p-2">
            {error ? (
              <li className="px-3 py-6 text-center text-sm text-text-muted">
                {t('campana.error')}
              </li>
            ) : visible === null ? (
              <li className="px-3 py-6 text-center text-sm text-text-subtle">
                {t('campana.cargando')}
              </li>
            ) : visible.length === 0 ? (
              <li className="px-3 py-8 text-center text-sm text-text-muted">
                {filter === 'mentions' ? t('campana.vacioMenciones') : t('campana.vacioTodas')}
              </li>
            ) : (
              visible.slice(0, 30).map((n) => {
                const link = notificationLink(n.templateKey, n.metadata, tLib);
                const href = link?.href ?? '/notifications';
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => void openItem(n, href)}
                      className="flex w-full gap-3 rounded-xl px-3 py-3 text-left hover:bg-bg-subtle"
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full',
                          n.templateKey === MENTION_TEMPLATE
                            ? 'bg-brand-600 text-white'
                            : 'bg-bg-subtle text-text-muted',
                        )}
                        aria-hidden
                      >
                        {n.templateKey === MENTION_TEMPLATE ? (
                          <span className="text-[15px] font-extrabold">@</span>
                        ) : (
                          <Icon name="bell" size={16} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block font-semibold text-text">
                          {n.subject ?? n.templateKey}
                        </span>
                        {n.body ? (
                          <span className="mt-1 line-clamp-2 block rounded-lg bg-bg-subtle px-2.5 py-1.5 text-text-muted">
                            {n.body}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-xs text-text-subtle">
                          {relative(n.createdAt, t as unknown as Tr)}
                        </span>
                      </span>
                      {!n.readAt ? (
                        <span
                          className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-brand-600"
                          aria-label={t('campana.sinLeer')}
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <div className="border-t border-border px-4 py-3 text-center">
            <Link
              href="/notifications"
              onClick={close}
              className="text-sm font-bold text-brand-600 hover:underline"
            >
              {t('campana.verTodas')}
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}

type Tr = (key: string, values?: Record<string, string | number>) => string;

function relative(iso: string, t: Tr): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return t('campana.hace.ahora');
  if (min < 60) return t('campana.hace.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('campana.hace.h', { n: h });
  return t('campana.hace.d', { n: Math.floor(h / 24) });
}
