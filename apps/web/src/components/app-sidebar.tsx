'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icon';
import { useTenantTheme } from '@/components/tenant-theme-provider';
import { VersionUpdateBanner } from '@/components/version-update-banner';
import type { StoredSession } from '@/lib/auth-storage';
import { useTenantContext } from '@/lib/tenant-context';
import { formatTenantName } from '@/lib/tenant-name';

export interface SidebarItem {
  href: string;
  label: string;
  icon: IconName;
  /** Emoji o carácter especial usado como icono en lugar del IconName. */
  emoji?: string;
  badge?: number;
  dot?: boolean;
  exactMatch?: boolean;
  requiresModule?: string;
  avatar?: { letter: string; color: string };
}

export interface SidebarGroup {
  label: string;
  icon?: IconName;
  canAdd?: boolean;
  /** Si está set, el botón "+" abre este handler (modal, etc.). Tiene prioridad sobre canAddHref. */
  onAdd?: () => void;
  /** Si está set y no hay onAdd, el botón "+" es un link a esta ruta. */
  canAddHref?: string;
  items: SidebarItem[];
}

interface Props {
  groups: SidebarGroup[];
  pathname: string | null;
  session: StoredSession;
  onLogout: () => void;
}

export function AppSidebar(props: Props) {
  // Rail persistente SOLO en escritorio (≥lg). En móvil el sidebar se sirve como
  // drawer off-canvas (MobileNavDrawer), que reutiliza `SidebarContent`.
  return (
    <aside
      className="sticky top-0 hidden h-dvh w-65 shrink-0 flex-col self-start overflow-hidden text-white lg:flex"
      style={{ backgroundColor: 'var(--sidebar-bg, #0D1B2A)' }}
    >
      <SidebarContent {...props} showVersionBanner />
    </aside>
  );
}

interface SidebarContentProps extends Props {
  /** Cierra el drawer al navegar (solo móvil). En el rail de escritorio no se pasa. */
  onNavigate?: () => void;
  /** Muestra un botón de cierre en la cabecera (solo en el drawer móvil). */
  onClose?: () => void;
  /** Renderiza el banner de nueva versión (solo en el rail de escritorio). */
  showVersionBanner?: boolean;
}

/**
 * Contenido interno del sidebar — compartido por el rail de escritorio
 * (`AppSidebar`) y el drawer móvil (`MobileNavDrawer`). Se renderiza dentro de
 * un contenedor `flex flex-col` (el `<aside>` de cada variante), por eso
 * devuelve un fragmento: cabecera + buscador + nav (scroll) + tira de usuario.
 */
export function SidebarContent({
  groups,
  pathname,
  session,
  onLogout,
  onNavigate,
  onClose,
  showVersionBanner,
}: SidebarContentProps) {
  const theme = useTenantTheme();
  const logoUrl = theme?.logoUrl ?? null;
  // Nombre visible de la organización: el nombre real del tenant (editable en
  // /admin/tenants), no el slug capitalizado. Fallback al slug si aún no se
  // resolvió el tenant por host.
  const { tenant: hostTenant } = useTenantContext();
  const orgName = hostTenant?.name?.trim() || formatTenantName(session.user.tenantSlug);

  const name = session.user.name ?? session.user.email;
  const initials = name
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
  const role = session.user.roles[0] ?? 'alumno';

  return (
    <>
      {/* ── Community header ── */}
      <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt="Logo"
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl object-contain"
            />
          ) : (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#1E5AA8]">
              <Image src="/brand/anagrama.png" alt="" width={22} height={22} priority />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-bold leading-tight text-white">{orgName}</div>
            <div className="mt-0.5 text-[11px] text-white/40">Comunidad</div>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 text-white/30"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar menú"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/8 hover:text-white/80"
          >
            <Icon name="x" size={18} />
          </button>
        ) : null}
      </div>

      {/* ── Search ── */}
      <div className="border-b border-white/8 px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-lg bg-white/8 px-3 py-2 text-[13px] text-white/35">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <span className="flex-1">Buscar...</span>
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/25">
            ⌘K
          </kbd>
        </div>
      </div>

      {/* ── Nav sections ── */}
      <nav className="scrollbar-thin-dark flex-1 overflow-y-auto px-2 py-2">
        {groups.map((section, idx) => (
          <div key={section.label} className={idx > 0 ? 'mt-5' : ''}>
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">
                {section.label}
              </span>
              {section.canAdd ? (
                section.onAdd ? (
                  <button
                    type="button"
                    onClick={() => {
                      section.onAdd?.();
                      onNavigate?.();
                    }}
                    aria-label={`Añadir a ${section.label}`}
                    className="grid h-4 w-4 place-items-center rounded text-white/25 transition-colors hover:text-white/60"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                ) : section.canAddHref ? (
                  <Link
                    href={section.canAddHref as never}
                    onClick={onNavigate}
                    aria-label={`Añadir a ${section.label}`}
                    className="grid h-4 w-4 place-items-center rounded text-white/25 transition-colors hover:text-white/60"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </Link>
                ) : (
                  <button
                    type="button"
                    aria-label={`Añadir a ${section.label}`}
                    className="grid h-4 w-4 place-items-center rounded text-white/25 transition-colors hover:text-white/60"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                )
              ) : null}
            </div>

            {section.items.map((item) => {
              const isActive = item.exactMatch
                ? pathname === item.href
                : (pathname?.startsWith(item.href) ?? false);
              return (
                <Link
                  key={item.href}
                  href={item.href as never}
                  onClick={onNavigate}
                  className={
                    isActive
                      ? 'flex items-center gap-2.5 rounded-[10px] border border-[rgba(46,125,206,0.30)] bg-[rgba(46,125,206,0.22)] px-2.5 py-1.75 text-[13px] font-semibold text-white'
                      : 'flex items-center gap-2.5 rounded-[10px] border border-transparent px-2.5 py-1.75 text-[13px] font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white/90'
                  }
                >
                  {item.emoji ? (
                    <span className="w-4 shrink-0 text-center text-sm leading-none">
                      {item.emoji}
                    </span>
                  ) : item.avatar ? (
                    <div
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white"
                      style={{ backgroundColor: item.avatar.color }}
                    >
                      {item.avatar.letter}
                    </div>
                  ) : (
                    <Icon name={item.icon} size={16} className="shrink-0" />
                  )}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.dot ? (
                    <div className="h-1.75 w-1.75 shrink-0 rounded-full bg-[#FF6F61]" />
                  ) : null}
                  {item.badge && item.badge > 0 ? (
                    <span className="rounded-full bg-[#FF6F61] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                      {item.badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── User strip ── */}
      {/* La identidad (avatar + nombre) ES el enlace a "Mi perfil" (/cuenta).
          No hay item de menú separado: se accede pulsando el nombre del usuario. */}
      <div className="border-t border-white/8 px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          <Link
            href={'/cuenta' as never}
            onClick={onNavigate}
            title="Mi perfil"
            aria-label="Mi perfil"
            className={
              (pathname?.startsWith('/cuenta') ? 'bg-white/8 ' : 'hover:bg-white/5 ') +
              'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors'
            }
          >
            {session.user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.avatarUrl}
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)' }}
              >
                {initials || '·'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold leading-tight text-white">
                {name}
              </div>
              <div className="truncate text-[11px] text-white/40">
                {humanRole(role)} · {session.user.tenantSlug}
              </div>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              onLogout();
            }}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/30 transition-colors hover:bg-white/8 hover:text-white/60"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </div>
      {showVersionBanner ? <VersionUpdateBanner /> : null}
    </>
  );
}

function humanRole(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'Super admin';
    case 'tenant_admin':
      return 'Administradora';
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
