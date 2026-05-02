'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icon';
import type { StoredSession } from '@/lib/auth-storage';

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
  items: SidebarItem[];
}

interface Props {
  groups: SidebarGroup[];
  pathname: string | null;
  session: StoredSession;
  onLogout: () => void;
}

/**
 * Sidebar persistente Didacta. Fondo Azul noche `#0D1B2A`. Sigue el spec del
 * UI kit (`docs/ui-kit/ui_kits/learn/Sidebar.jsx`):
 *  - Brand con anagrama 36×36 + wordmark Sora 22/700 letter-spacing -0.01em.
 *  - Grupos con label uppercase tracking 0.08em, opacidad 0.4.
 *  - Item activo: bg `rgba(46, 125, 206, 0.18)`, border 1px `rgba(46, 125, 206, 0.32)`,
 *    color blanco, peso 600.
 *  - Avatar del user con gradiente Azul equilibrio → Verde crecimiento.
 *  - Badge numérico opcional (Coral) para items con notificaciones pendientes.
 */
export function AppSidebar({ groups, pathname, session, onLogout }: Props) {
  const initials = (session.user.name ?? session.user.email)
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
  const role = session.user.roles[0] ?? 'alumno';

  return (
    <aside className="flex h-dvh w-60 shrink-0 flex-col bg-[#0D1B2A] px-4 py-5 text-white">
      <Link href="/" className="mb-4 flex items-center gap-2.5 border-b border-white/10 px-2 pb-6">
        <Image
          src="/brand/anagrama.png"
          alt=""
          width={36}
          height={36}
          className="rounded-lg"
          priority
        />
        <span
          className="font-display text-[22px] font-bold leading-none tracking-tight"
          style={{ letterSpacing: '-0.01em' }}
        >
          Didacta
        </span>
      </Link>

      <nav className="scrollbar-thin-dark flex-1 space-y-4 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-2 pt-3.5 text-[11px] font-medium uppercase text-white/40 tracking-[0.08em]">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
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
                    <Icon name={item.icon} size={18} />
                    <span className="flex-1">{item.label}</span>
                    {item.badge && item.badge > 0 ? (
                      <span className="rounded-full bg-[#FF6F61] px-2 py-0.5 text-[11px] font-semibold leading-none text-white">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-3 flex items-center gap-2.5 border-t border-white/10 px-2 pt-4">
        <div
          className="grid h-8 w-8 place-items-center rounded-full font-display text-xs font-bold text-white"
          style={{
            background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)',
          }}
        >
          {initials || '·'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-white">
            {session.user.name ?? session.user.email}
          </div>
          <div className="truncate text-[12px] text-white/50">
            {humanRole(role)} · {session.user.tenantSlug}
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          aria-label="Cerrar sesión"
          className="text-white/50 transition-colors hover:text-white"
        >
          <Icon name="logout" size={16} />
        </button>
      </div>
    </aside>
  );
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
