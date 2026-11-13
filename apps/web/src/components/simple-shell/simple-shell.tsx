'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  AgentPanelDock,
  AgentPanelMobile,
  AgentPanelTab,
  useAgentPanel,
} from '@/components/agent-panel/agent-panel';
import type { SidebarGroup } from '@/components/app-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Icon } from '@/components/icon';
import { useTenantTheme } from '@/components/tenant-theme-provider';
import type { StoredSession } from '@/lib/auth-storage';
import { labelOr } from '@/lib/i18n/labels';
import { simpleModeApi } from '@/lib/simple-mode';
import {
  activeSimpleTab,
  buildSimpleMore,
  buildSimpleTabs,
  mobileTabs,
  SIMPLE_AVATAR_LINKS,
  type SimpleTab,
} from '@/lib/simple-nav';
import { useTenantContext } from '@/lib/tenant-context';
import { formatTenantName } from '@/lib/tenant-name';
import { cn } from '@/lib/utils';
import { CHAT_TOGGLE_EVENT, useMessagingContext } from '@/modules/messaging';
import { SimpleBell } from './simple-bell';
import { avatarInitials, Counter, useOutsideClose } from './shell-utils';

/** Lo dispara cualquier pantalla que cambie el estado de «Empieza aquí». */
export const START_HERE_CHANGED_EVENT = 'didacta:empieza-cambio';

interface Props {
  session: StoredSession;
  pathname: string;
  /** Árbol COMPLETO de hoy (principal + admin), ya filtrado por módulos. */
  fullGroups: SidebarGroup[];
  activeModules: Set<string> | null;
  isAdmin: boolean;
  onLogout: () => void;
  /** Avisos fijos de arriba (acceso de soporte, correo, prueba). */
  banners: ReactNode;
  children: ReactNode;
}

/**
 * Armazón del MODO SENCILLO: cabecera blanca con la marca del aula, pestañas
 * (escritorio) o barra inferior (móvil) y «Más» con todo lo demás. Sustituye
 * a la barra lateral solo en las aulas en modo sencillo; las páginas son las
 * mismas.
 *
 * Marca por defecto: la de Didacta (anagrama sobre su azul y el tema por
 * defecto). Cuando el creador sube su logo o cambia el color, mandan los suyos.
 */
export function SimpleShell({
  session,
  pathname,
  fullGroups,
  activeModules,
  isAdmin,
  onLogout,
  banners,
  children,
}: Props) {
  const t = useTranslations('modoSencillo');
  const tNav = useTranslations('nav');
  const [progress, setProgress] = useState<{ done: number; total: number; sold: boolean } | null>(
    null,
  );

  // El estado de «Empieza aquí» decide el nombre de la pestaña (Inicio tras la
  // primera venta) y el contador «3 de 6». Solo para quien administra.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = () =>
      simpleModeApi
        .startHere()
        .then((v) => {
          if (!cancelled)
            setProgress({
              done: v.steps.filter((s) => s.done).length,
              total: v.steps.length,
              sold: v.sales.count > 0,
            });
        })
        .catch(() => undefined);
    void load();
    window.addEventListener(START_HERE_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(START_HERE_CHANGED_EVENT, load);
    };
  }, [isAdmin]);

  const tabs = useMemo(
    () => buildSimpleTabs({ isAdmin, activeModules, hasSold: progress?.sold ?? false }),
    [isAdmin, activeModules, progress?.sold],
  );
  const more = useMemo(() => buildSimpleMore(fullGroups, tabs), [fullGroups, tabs]);
  const current = activeSimpleTab(pathname, tabs);
  const bottom = mobileTabs(tabs, isAdmin);
  const bottomIds = new Set(bottom.map((b) => b.id));

  // «Más» en escritorio (desplegable bajo la pestaña) y en el móvil (hoja a
  // pantalla completa): estados separados para que cerrar uno al pulsar fuera
  // no interfiera con el otro.
  const [moreOpen, setMoreOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useOutsideClose(moreRef, moreOpen, () => setMoreOpen(false));
  useEffect(() => {
    setMoreOpen(false);
    setSheetOpen(false);
    setSearchOpen(false);
  }, [pathname]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Panel «Hazlo más rápido con tu agente de IA»: solo admins y solo en las
  // pantallas de creación manual. Su estado vive aquí para que la clave recién
  // creada sobreviva a plegarlo y a cambiar de pantalla.
  const agent = useAgentPanel(pathname, isAdmin);
  // Alto de la cabecera fija (avisos incluidos): el panel se pega justo debajo.
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const [headerH, setHeaderH] = useState(108);
  useLayoutEffect(() => {
    const el = stickyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeaderH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tabLabel = (tab: SimpleTab) => t(`tabs.${tab.labelKey}` as 'tabs.empieza');
  const badge = (tab: SimpleTab) =>
    tab.id === 'empieza' && progress && !progress.sold
      ? t('shell.pasosHechos', { done: progress.done, total: progress.total })
      : null;

  // El buscador recorre todo: pestañas y «Más».
  const searchGroups: SidebarGroup[] = useMemo(
    () => [
      {
        label: t('tabs.mas'),
        items: tabs.map((tab) => ({ href: tab.href, label: tabLabel(tab), icon: tab.icon })),
      },
      ...more,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, more, t],
  );

  return (
    <div className="flex min-h-dvh flex-col bg-bg-subtle" data-testid="simple-shell">
      <CommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        groups={searchGroups}
      />
      <div ref={stickyRef} className="sticky top-0 z-(--z-sticky)">
        {banners}
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex h-[60px] max-w-[1180px] items-center gap-2 px-4 lg:px-6">
            <BrandLink href={isAdmin ? '/start' : '/community'} session={session} />
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="ml-auto hidden h-10 w-[320px] items-center gap-2 rounded-xl bg-bg-subtle px-3 text-sm text-text-subtle transition-colors hover:bg-border-soft lg:flex"
            >
              <Icon name="search" size={16} />
              {t('shell.buscar')}
              <kbd className="ml-auto rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-text-subtle">
                Ctrl K
              </kbd>
            </button>
            <div className="ml-auto flex items-center gap-0.5 lg:ml-2">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label={t('shell.buscarCorto')}
                className="grid h-10 w-10 place-items-center rounded-xl text-text-muted hover:bg-bg-subtle hover:text-text lg:hidden"
              >
                <Icon name="search" size={20} />
              </button>
              <MessagesButton />
              <SimpleBell />
              <AvatarMenu session={session} activeModules={activeModules} onLogout={onLogout} />
            </div>
          </div>
          <nav
            aria-label={t('shell.navAria')}
            className="hidden border-t border-border-soft lg:block"
          >
            <div className="mx-auto flex h-12 max-w-[1180px] items-stretch gap-1 px-3 lg:px-4">
              {tabs.map((tab) => {
                const on = tab.id === current;
                const b = badge(tab);
                return (
                  <Link
                    key={tab.id}
                    href={tab.href}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      '-mb-px flex items-center gap-2 border-b-2 px-3 text-[15px] font-semibold transition-colors',
                      on
                        ? 'border-brand-600 text-text'
                        : 'border-transparent text-text-muted hover:text-text',
                    )}
                  >
                    {tabLabel(tab)}
                    {b ? (
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700 tabular-nums">
                        {b}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
              {more.length > 0 ? (
                <div ref={moreRef} className="relative ml-auto flex">
                  <button
                    type="button"
                    onClick={() => setMoreOpen((v) => !v)}
                    aria-expanded={moreOpen}
                    className={cn(
                      '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 text-[15px] font-semibold',
                      moreOpen ? 'text-text' : 'text-text-muted hover:text-text',
                    )}
                  >
                    {t('tabs.mas')}
                    <Icon name="chevron-down" size={14} />
                  </button>
                  {moreOpen ? (
                    <MorePanel
                      groups={more}
                      onClose={() => setMoreOpen(false)}
                      tNav={tNav}
                      variant="popover"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </nav>
        </header>
      </div>

      <main className="flex-1 px-4 pt-5 pb-28 lg:px-6 lg:pt-8 lg:pb-16">
        {/* Con el panel del agente abierto, el contenido se estrecha y el panel
            va a su derecha, dentro del mismo ancho que la cabecera: nunca lo tapa. */}
        <div
          className={cn(
            'mx-auto max-w-[1132px]',
            agent.dockOpen && 'lg:flex lg:items-start lg:gap-6',
          )}
        >
          <div className={cn(agent.dockOpen && 'min-w-0 lg:flex-1')}>
            <AgentPanelMobile state={agent} tenantSlug={session.user.tenantSlug} />
            {children}
          </div>
          <AgentPanelDock state={agent} tenantSlug={session.user.tenantSlug} top={headerH} />
        </div>
        <AgentPanelTab state={agent} top={headerH} />
      </main>

      {/* Barra inferior (móvil): 4 pestañas y «Más». */}
      <nav
        aria-label={t('shell.navAria')}
        className="fixed inset-x-0 bottom-0 z-(--z-sticky) grid grid-cols-5 border-t border-border bg-surface/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {bottom.map((tab) => {
          const on = tab.id === current;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold',
                on ? 'text-brand-600' : 'text-text-subtle',
              )}
            >
              <Icon name={tab.icon} size={22} />
              <span className="max-w-full truncate px-1">
                {tab.id === 'empieza' && !progress?.sold
                  ? t('tabs.empieza').split(' ')[0]
                  : tabLabel(tab)}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className={cn(
            'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold',
            current && !bottomIds.has(current) ? 'text-brand-600' : 'text-text-subtle',
          )}
        >
          <Icon name="menu" size={22} />
          {t('tabs.mas')}
        </button>
      </nav>

      {sheetOpen ? (
        <div className="lg:hidden">
          <MorePanel
            groups={more}
            extraTabs={tabs.filter((tab) => !bottomIds.has(tab.id))}
            tabLabel={tabLabel}
            onClose={() => setSheetOpen(false)}
            tNav={tNav}
            variant="sheet"
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Marca ──────────────────────────────────────────────────────────────────

function BrandLink({ href, session }: { href: string; session: StoredSession }) {
  const theme = useTenantTheme();
  const { tenant } = useTenantContext();
  const name = tenant?.name?.trim() || formatTenantName(session.user.tenantSlug);
  const logoUrl = theme?.logoUrl ?? null;
  const onlyLogo = logoUrl && (theme?.logoDisplayMode ?? 'logo_only') === 'logo_only';
  return (
    <Link href={href} className="flex min-w-0 items-center gap-2.5" aria-label={name}>
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={onlyLogo ? name : ''}
          className={cn(
            'object-contain',
            onlyLogo ? 'h-9 w-auto max-w-[180px]' : 'h-9 w-9 rounded-lg',
          )}
        />
      ) : (
        // Por defecto, la marca de Didacta: su anagrama sobre su azul.
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[#1E5AA8]">
          <Image src="/brand/anagrama.png" alt="" width={20} height={20} priority />
        </span>
      )}
      {onlyLogo ? null : <span className="truncate text-[16px] font-bold text-text">{name}</span>}
    </Link>
  );
}

// ── Mensajes ───────────────────────────────────────────────────────────────

function MessagesButton() {
  const t = useTranslations('modoSencillo');
  const { unreadConversations } = useMessagingContext();
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(CHAT_TOGGLE_EVENT))}
      aria-label={
        unreadConversations > 0
          ? t('shell.mensajesSinLeer', { count: unreadConversations })
          : t('shell.mensajes')
      }
      className="relative grid h-10 w-10 place-items-center rounded-xl text-text-muted hover:bg-bg-subtle hover:text-text"
    >
      <Icon name="messages" size={20} />
      {unreadConversations > 0 ? <Counter n={unreadConversations} /> : null}
    </button>
  );
}

// ── Avatar ─────────────────────────────────────────────────────────────────

function AvatarMenu({
  session,
  activeModules,
  onLogout,
}: {
  session: StoredSession;
  activeModules: Set<string> | null;
  onLogout: () => void;
}) {
  const t = useTranslations('modoSencillo');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  const name = session.user.name?.trim() || session.user.email;
  const initials = avatarInitials(session.user.name, session.user.email);
  // Una foto que no carga (borrada, caducada) no puede dejar el círculo vacío.
  const [photoFailed, setPhotoFailed] = useState(false);
  const links = [
    { href: SIMPLE_AVATAR_LINKS.profile, label: t('shell.miPerfil'), icon: 'user' as const },
    {
      href: SIMPLE_AVATAR_LINKS.certificates,
      label: t('shell.misCertificados'),
      icon: 'award' as const,
    },
    { href: SIMPLE_AVATAR_LINKS.progress, label: t('shell.miProgreso'), icon: 'chart' as const },
    ...(activeModules === null || activeModules.has('mod.referrals')
      ? [
          {
            href: SIMPLE_AVATAR_LINKS.referrals,
            label: t('shell.invitaYGana'),
            icon: 'sparkles' as const,
          },
        ]
      : []),
  ];
  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('shell.tuPerfil')}
        className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-brand-600 text-[13px] font-bold text-white"
      >
        {session.user.avatarUrl && !photoFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={session.user.avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setPhotoFailed(true)}
          />
        ) : initials ? (
          initials
        ) : (
          <Icon name="user" size={18} />
        )}
      </button>
      {open ? (
        <div className="absolute top-12 right-0 z-(--z-dropdown) w-64 rounded-2xl border border-border bg-surface p-2 shadow-lg">
          <div className="px-3 py-2">
            <div className="truncate text-sm font-bold text-text">{name}</div>
            <div className="truncate text-xs text-text-subtle">{session.user.email}</div>
          </div>
          <div className="my-1 h-px bg-border-soft" />
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text hover:bg-bg-subtle"
            >
              <Icon name={l.icon} size={18} />
              {l.label}
            </Link>
          ))}
          <div className="my-1 h-px bg-border-soft" />
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-text-muted hover:bg-bg-subtle hover:text-text"
          >
            <Icon name="logout" size={18} />
            {t('shell.cerrarSesion')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── «Más» ─────────────────────────────────────────────────────────────────

function MorePanel({
  groups,
  extraTabs = [],
  tabLabel,
  onClose,
  tNav,
  variant,
}: {
  groups: SidebarGroup[];
  extraTabs?: SimpleTab[];
  tabLabel?: (tab: SimpleTab) => string;
  onClose: () => void;
  tNav: Parameters<typeof labelOr>[0];
  variant: 'popover' | 'sheet';
}) {
  const t = useTranslations('modoSencillo');
  const body = (
    <>
      {extraTabs.length > 0 ? (
        <div className="grid gap-1 pb-3">
          {extraTabs.map((tab) => (
            <Link
              key={tab.id}
              href={tab.href}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-semibold text-text hover:bg-bg-subtle"
            >
              <Icon name={tab.icon} size={20} />
              {tabLabel?.(tab)}
            </Link>
          ))}
          <div className="mt-2 h-px bg-border-soft" />
        </div>
      ) : null}
      <div className={cn('grid gap-x-6 gap-y-4', variant === 'popover' && 'grid-cols-3')}>
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-3 pb-1 text-[13px] font-bold text-text-subtle">
              {labelOr(tNav, `groups.${g.label}`, g.label)}
            </div>
            {g.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block truncate rounded-lg px-3 py-1.5 text-sm text-text-muted hover:bg-bg-subtle hover:text-text"
              >
                {labelOr(tNav, `items.${item.label}`, item.label)}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </>
  );
  if (variant === 'popover') {
    return (
      <div className="absolute top-12 right-0 z-(--z-dropdown) max-h-[70vh] w-[720px] overflow-auto rounded-2xl border border-border bg-surface p-4 shadow-lg">
        <div className="px-3 pb-3 text-sm text-text-subtle">{t('shell.masAyuda')}</div>
        {body}
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-(--z-modal) flex flex-col bg-surface">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-[60px] items-center justify-between border-b border-border px-4">
          <span className="text-lg font-bold text-text">{t('shell.masTitulo')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('shell.cerrar')}
            className="grid h-10 w-10 place-items-center rounded-xl text-text-muted hover:bg-bg-subtle"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-2 py-3">{body}</div>
      </div>
    </div>
  );
}
