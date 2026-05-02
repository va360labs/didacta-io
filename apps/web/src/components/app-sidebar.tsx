'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { VersionUpdateBanner } from '@/components/version-update-banner';
import type { StoredSession } from '@/lib/auth-storage';
import { APP_CHANNEL, APP_VERSION } from '@/lib/version';

export interface SidebarItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
  exactMatch?: boolean;
  /**
   * Si está presente y el módulo NO está activo en el tenant, el item se
   * oculta del sidebar. NO confundir con capabilities EE: estas siguen el
   * patrón EeGate (visible-pero-bloqueado, ver docs/UI-EE-GATING.md).
   * El filtrado lo aplica el layout antes de pasar `groups` al sidebar.
   */
  requiresModule?: string;
}

export interface SidebarGroup {
  label: string;
  /**
   * Icono del rail. Si se omite, el sidebar D usa un fallback genérico.
   * Cada grupo se muestra como una casilla en el rail izquierdo y abre su
   * panel de items al hacer click.
   */
  icon?: IconName;
  items: SidebarItem[];
}

interface Props {
  groups: SidebarGroup[];
  pathname: string | null;
  session: StoredSession;
  onLogout: () => void;
}

/**
 * Sidebar Didacta — patrón "rail + panel" (Variante D del rediseño).
 *
 * Layout:
 *  - Rail 72px (izquierda): brand 36×36, lista de áreas con icono + label
 *    corto, avatar al fondo con popup de cuenta.
 *  - Panel (resto): header con label del área seleccionada + lista vertical
 *    de items + footer con conteo.
 *
 * El área seleccionada se elige automáticamente al cargar según el pathname
 * actual (busca el grupo que contiene el item activo); el usuario puede
 * cambiarla con clicks en el rail.
 *
 * El item activo dentro del panel sigue las mismas reglas que el sidebar
 * anterior: bg `rgba(46, 125, 206, 0.18)`, border `rgba(46, 125, 206, 0.32)`,
 * texto blanco peso 600. Badge Coral para notificaciones pendientes.
 *
 * Filtrado por módulos: el layout aplica `filterByActiveModules()` ANTES de
 * pasar `groups`, así que items con `requiresModule` desactivados nunca
 * llegan acá. Si un grupo entero queda sin items, también se elimina.
 */
export function AppSidebar({ groups, pathname, session, onLogout }: Props) {
  const initials = (session.user.name ?? session.user.email)
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
  const role = session.user.roles[0] ?? 'alumno';

  const detectedAreaIdx = useMemo(
    () => detectArea(groups, pathname),
    [groups, pathname],
  );
  const [areaIdx, setAreaIdx] = useState<number>(detectedAreaIdx);

  // Si el pathname cambia y el detectado difiere, sincronizamos. El usuario
  // puede sobreescribirlo con un click manual; al siguiente cambio de ruta
  // volvemos a auto-detectar.
  useEffect(() => {
    setAreaIdx(detectedAreaIdx);
  }, [detectedAreaIdx]);

  const [accountOpen, setAccountOpen] = useState(false);

  if (groups.length === 0) {
    return (
      <aside className="sticky top-0 grid h-dvh w-60 shrink-0 place-items-center self-start bg-[#0D1B2A] p-6 text-center text-sm text-white/60">
        Activá módulos en{' '}
        <Link href="/admin/configuracion" className="ml-1 underline">
          configuración
        </Link>{' '}
        para ver opciones.
      </aside>
    );
  }

  const safeIdx = Math.min(Math.max(areaIdx, 0), groups.length - 1);
  const area = groups[safeIdx];

  return (
    <aside className="sticky top-0 flex h-dvh w-[300px] shrink-0 self-start bg-[#0D1B2A] text-white">
      {/* RAIL */}
      <div className="relative flex w-[72px] flex-col border-r border-white/[0.06] bg-[#0a1421]">
        <Link
          href="/"
          className="grid place-items-center border-b border-white/[0.06] py-4"
          aria-label="Inicio Didacta"
        >
          <Image
            src="/brand/anagrama.png"
            alt=""
            width={34}
            height={34}
            className="rounded-md"
            priority
          />
        </Link>

        <div className="scrollbar-thin-dark flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
          {groups.map((g, i) => {
            const sel = i === safeIdx;
            return (
              <button
                key={g.label}
                type="button"
                onClick={() => setAreaIdx(i)}
                title={g.label}
                aria-current={sel ? 'page' : undefined}
                className={
                  sel
                    ? 'flex flex-col items-center gap-1 rounded-[10px] border border-[rgba(46,125,206,0.32)] bg-[rgba(46,125,206,0.18)] px-1 py-2.5 text-[10px] font-medium text-white'
                    : 'flex flex-col items-center gap-1 rounded-[10px] border border-transparent px-1 py-2.5 text-[10px] font-medium text-white/60 transition-colors hover:bg-white/[0.04] hover:text-white'
                }
              >
                <Icon name={g.icon ?? 'package'} size={20} />
                <span className="max-w-[56px] overflow-hidden text-ellipsis whitespace-nowrap leading-tight">
                  {g.label}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative border-t border-white/[0.06]">
          <button
            type="button"
            onClick={() => setAccountOpen((s) => !s)}
            aria-label="Mi cuenta"
            aria-expanded={accountOpen}
            className="grid w-full place-items-center py-3.5"
          >
            <div
              className="grid h-9 w-9 place-items-center rounded-full font-display text-xs font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)' }}
            >
              {initials || '·'}
            </div>
          </button>

          {accountOpen ? (
            <div className="absolute bottom-2 left-[78px] z-30 w-[220px] rounded-xl bg-white p-1.5 text-[#0D1B2A] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#94A3B8]">
                Mi cuenta
              </div>
              <div className="px-3 pb-1 text-[12px] text-[#475569]">
                <div className="truncate font-semibold text-[#0D1B2A]">
                  {session.user.name ?? session.user.email}
                </div>
                <div className="truncate">
                  {humanRole(role)} · {session.user.tenantSlug}
                </div>
              </div>
              <div className="my-1 h-px bg-[#E2E8F0]" />
              <Link
                href="/cuenta"
                onClick={() => setAccountOpen(false)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium hover:bg-[#F1F3F5]"
              >
                <Icon name="user" size={16} />
                Perfil
              </Link>
              <Link
                href="/cuenta/seguridad"
                onClick={() => setAccountOpen(false)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium hover:bg-[#F1F3F5]"
              >
                <Icon name="lock" size={16} />
                Seguridad
              </Link>
              <Link
                href="/cuenta/suscripciones"
                onClick={() => setAccountOpen(false)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium hover:bg-[#F1F3F5]"
              >
                <Icon name="package" size={16} />
                Suscripciones
              </Link>
              <div className="my-1 h-px bg-[#E2E8F0]" />
              <button
                type="button"
                onClick={() => {
                  setAccountOpen(false);
                  onLogout();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-[#DC2626] hover:bg-[#FEF2F2]"
              >
                <Icon name="logout" size={16} />
                Cerrar sesión
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* PANEL */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-white/[0.06] px-4 pb-3 pt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40">
            Área
          </div>
          <div className="mt-1 font-display text-[18px] font-bold leading-tight">
            {area.label}
          </div>
        </div>

        <nav className="scrollbar-thin-dark flex-1 space-y-0.5 overflow-y-auto p-2.5">
          {area.items.map((item) => {
            const isActive = item.exactMatch
              ? pathname === item.href
              : (pathname?.startsWith(item.href) ?? false);
            return (
              <Link
                key={item.href}
                href={item.href as never}
                className={
                  isActive
                    ? 'flex items-center gap-3 rounded-[10px] border border-[rgba(46,125,206,0.32)] bg-[rgba(46,125,206,0.18)] px-3 py-2.5 text-sm font-semibold text-white'
                    : 'flex items-center gap-3 rounded-[10px] border border-transparent px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white'
                }
              >
                <Icon name={item.icon} size={17} />
                <span className="flex-1 truncate">{item.label}</span>
                {item.badge && item.badge > 0 ? (
                  <span className="rounded-full bg-[#FF6F61] px-2 py-0.5 text-[11px] font-semibold leading-none text-white">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2.5 text-[11px] text-white/40">
          <span>
            Didacta <span className="font-mono">{APP_VERSION}</span>
          </span>
          {APP_CHANNEL !== 'stable' ? (
            <span className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {APP_CHANNEL}
            </span>
          ) : null}
        </div>
        <VersionUpdateBanner />
      </div>
    </aside>
  );
}

/**
 * Devuelve el índice del grupo que contiene un item cuyo href matchea el
 * pathname actual. Si no encuentra ninguno, devuelve 0.
 */
function detectArea(groups: SidebarGroup[], pathname: string | null): number {
  if (!pathname || groups.length === 0) return 0;
  let bestIdx = 0;
  let bestLen = -1;
  groups.forEach((g, idx) => {
    g.items.forEach((it) => {
      const matches = it.exactMatch ? pathname === it.href : pathname.startsWith(it.href);
      if (matches && it.href.length > bestLen) {
        bestIdx = idx;
        bestLen = it.href.length;
      }
    });
  });
  return bestIdx;
}

function humanRole(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'Super admin';
    case 'tenant_admin':
      return 'Admin';
    case 'formador':
      return 'Formador';
    case 'alumno':
      return 'Alumno';
    case 'auditor':
      return 'Auditor';
    case 'empresa_manager':
      return 'Manager';
    default:
      return role;
  }
}
