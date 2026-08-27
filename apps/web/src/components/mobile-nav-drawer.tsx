'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SIDEBAR_BG_STYLE, SidebarContent, type SidebarGroup } from '@/components/app-sidebar';
import type { StoredSession } from '@/lib/auth-storage';
import { useFocusTrap } from '@/lib/use-focus-trap';

interface Props {
  open: boolean;
  onClose: () => void;
  groups: SidebarGroup[];
  pathname: string | null;
  session: StoredSession;
  onLogout: () => void;
  /** Abre el command palette (⌘K); cierra antes el drawer. */
  onOpenSearch?: () => void;
  /** Salida del área actual (admin → app); se pinta bajo la cabecera. */
  backLink?: { href: string; label: string };
}

/**
 * Drawer de navegación para móvil (<lg). Reutiliza el MISMO `SidebarContent`
 * que el rail de escritorio, servido como panel off-canvas que entra desde la
 * izquierda con scrim. Cierra al: tocar el scrim, pulsar un item de navegación
 * (`onNavigate`), pulsar la X de la cabecera o presionar Escape.
 *
 * El contenedor es `lg:hidden`, así que en escritorio nunca se muestra (el rail
 * persistente de `AppSidebar` lo cubre). El panel se mantiene montado y se anima
 * con `translate-x` para que la transición de entrada/salida sea fluida; cuando
 * está cerrado, `pointer-events-none` evita que capture toques por debajo.
 */
export function MobileNavDrawer({
  open,
  onClose,
  groups,
  pathname,
  session,
  onLogout,
  onOpenSearch,
  backLink,
}: Props) {
  const t = useTranslations('shell');
  const panelRef = useRef<HTMLElement>(null);

  // Foco dentro del panel mientras el drawer está abierto (LMS-122). Sin esto,
  // en móvil con teclado o lector el menú se abría y el foco seguía en la
  // página de detrás, que el scrim acaba de tapar.
  useFocusTrap(panelRef, open);

  // Bloqueo de scroll del body + cierre con Escape mientras el drawer está abierto.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-(--z-overlay) lg:hidden ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      {/* Scrim — atenúa el fondo y cierra al tocar. */}
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label={t('closeMenu')}
        onClick={onClose}
        className={`absolute inset-0 bg-[#0d1b2a]/60 transition-opacity duration-300 ease-out ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Panel deslizante — mismo contenido que el rail de escritorio. */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t('drawer.ariaLabel')}
        className={`absolute inset-y-0 left-0 flex w-71 max-w-[85vw] flex-col overflow-hidden text-white shadow-xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={SIDEBAR_BG_STYLE}
      >
        <SidebarContent
          groups={groups}
          pathname={pathname}
          session={session}
          onLogout={onLogout}
          onNavigate={onClose}
          onClose={onClose}
          backLink={backLink}
          onOpenSearch={
            onOpenSearch
              ? () => {
                  onClose();
                  onOpenSearch();
                }
              : undefined
          }
        />
      </aside>
    </div>
  );
}
