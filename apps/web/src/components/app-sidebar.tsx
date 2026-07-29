'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
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
  /**
   * Grupo plegable: arranca plegado salvo que la ruta activa sea uno de sus
   * items. El usuario puede abrir/cerrar con el propio label del grupo.
   */
  collapsible?: boolean;
  items: SidebarItem[];
}

interface Props {
  groups: SidebarGroup[];
  pathname: string | null;
  session: StoredSession;
  onLogout: () => void;
  /** Abre el command palette (⌘K). Si no se pasa, el buscador no hace nada. */
  onOpenSearch?: () => void;
}

/**
 * Fondo del rail: el color per-tenant (`--sidebar-bg`) sigue mandando; encima
 * se superpone un tinte degradado azul→teal muy sutil que da profundidad sin
 * pisar el theming. Compartido con el drawer móvil para que ambos coincidan.
 */
export const SIDEBAR_BG_STYLE: CSSProperties = {
  backgroundColor: 'var(--sidebar-bg, #0D1B2A)',
  backgroundImage:
    'linear-gradient(180deg, rgba(46,125,206,0.16) 0%, rgba(13,27,42,0) 34%, rgba(24,181,168,0.10) 100%)',
};

/** Clave de localStorage con la preferencia rail-de-iconos del usuario. */
const RAIL_PREF_KEY = 'didacta.sidebar_rail';

export function AppSidebar(props: Props) {
  // Rail persistente SOLO en escritorio (≥lg). En móvil el sidebar se sirve como
  // drawer off-canvas (MobileNavDrawer), que reutiliza `SidebarContent`.
  // Patrón "collapsible icon rail" (Linear/Stripe/shadcn sidebar-07): columna
  // pegada al borde a ancho completo, plegable a un rail de solo iconos con
  // tooltips. La preferencia del usuario persiste entre sesiones.
  const [collapsed, setCollapsed] = useState(false);

  // La preferencia se lee tras el montaje (no en el inicializador de useState)
  // para que el primer render del cliente coincida con el HTML del servidor.
  useEffect(() => {
    setCollapsed(localStorage.getItem(RAIL_PREF_KEY) === '1');
  }, []);

  function toggleCollapsed() {
    setCollapsed((v) => {
      localStorage.setItem(RAIL_PREF_KEY, v ? '0' : '1');
      return !v;
    });
  }

  return (
    <aside
      className={`sticky top-0 hidden h-dvh shrink-0 flex-col self-start overflow-hidden text-white transition-[width] duration-300 ease-out lg:flex ${
        collapsed ? 'w-16' : 'w-65'
      }`}
      style={SIDEBAR_BG_STYLE}
    >
      <SidebarContent
        {...props}
        showVersionBanner
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
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
  /** Modo rail de solo iconos (escritorio). El drawer móvil siempre va expandido. */
  collapsed?: boolean;
  /** Alterna expandido ↔ rail; si no se pasa, el botón de plegar no se muestra. */
  onToggleCollapsed?: () => void;
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
  onOpenSearch,
  showVersionBanner,
  collapsed,
  onToggleCollapsed,
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

  // Grupos plegables: sin entrada en el mapa = automático (abierto solo si
  // contiene la ruta activa); true/false = elección explícita del usuario.
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});

  // ── Modo rail de solo iconos ─────────────────────────────────────────────
  // Cada item queda como tile con tooltip nativo (title); los grupos se
  // separan con una línea fina. Los plegables se muestran siempre (sus canales
  // son tiles directos). Sin banner de versión ni botón "+" en este modo.
  if (collapsed) {
    return (
      <>
        <div className="flex flex-col items-center gap-1.5 border-b border-white/8 px-2 py-3">
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
          {onToggleCollapsed ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Expandir menú"
              title="Expandir menú"
              className="grid h-7 w-7 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/8 hover:text-white/80"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />
              </svg>
            </button>
          ) : null}
        </div>

        <div className="border-b border-white/8 px-2.5 py-2.5">
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Buscar (⌘K)"
            title="Buscar (⌘K)"
            className="grid h-9 w-full place-items-center rounded-xl bg-white/8 text-white/40 ring-1 ring-white/5 transition-colors hover:bg-white/12 hover:text-white/70"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
        </div>

        <nav className="scrollbar-thin-dark flex-1 overflow-y-auto px-2.5 py-2">
          {groups.map((section, idx) => (
            <div key={section.label} className={idx > 0 ? 'mt-2 border-t border-white/8 pt-2' : ''}>
              {section.items.map((item) => {
                const isActive = item.exactMatch
                  ? pathname === item.href
                  : (pathname?.startsWith(item.href) ?? false);
                return (
                  <Link
                    key={item.href}
                    href={item.href as never}
                    onClick={onNavigate}
                    title={item.label}
                    aria-label={item.label}
                    className="mb-1 flex justify-center"
                  >
                    <span className="relative">
                      {item.avatar ? (
                        <span
                          className="grid h-9 w-9 place-items-center rounded-xl text-[11px] font-bold text-white"
                          style={{ backgroundColor: item.avatar.color }}
                        >
                          {item.avatar.letter}
                        </span>
                      ) : (
                        <span
                          className={
                            isActive
                              ? 'grid h-9 w-9 place-items-center rounded-xl text-white shadow-[0_6px_18px_rgba(46,125,206,0.45)]'
                              : 'grid h-9 w-9 place-items-center rounded-xl bg-white/6 text-white/55 transition-all duration-200 hover:bg-white/12 hover:text-white'
                          }
                          style={
                            isActive
                              ? {
                                  backgroundImage:
                                    'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)',
                                }
                              : undefined
                          }
                        >
                          {item.emoji ? (
                            <span className="text-base leading-none">{item.emoji}</span>
                          ) : (
                            <Icon name={item.icon} size={16} />
                          )}
                        </span>
                      )}
                      {item.dot || (item.badge && item.badge > 0) ? (
                        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#FF6F61] ring-2 ring-[#0D1B2A]" />
                      ) : null}
                    </span>
                  </Link>
                );
              })}
              {section.canAdd && (section.onAdd || section.canAddHref) ? (
                section.onAdd ? (
                  <button
                    type="button"
                    onClick={() => {
                      section.onAdd?.();
                      onNavigate?.();
                    }}
                    title={`Añadir a ${section.label}`}
                    aria-label={`Añadir a ${section.label}`}
                    className="mb-1 flex w-full justify-center"
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-dashed border-white/20 text-white/40 transition-colors hover:border-white/40 hover:bg-white/5 hover:text-white">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </button>
                ) : (
                  <Link
                    href={section.canAddHref as never}
                    onClick={onNavigate}
                    title={`Añadir a ${section.label}`}
                    aria-label={`Añadir a ${section.label}`}
                    className="mb-1 flex w-full justify-center"
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-dashed border-white/20 text-white/40 transition-colors hover:border-white/40 hover:bg-white/5 hover:text-white">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </Link>
                )
              ) : null}
            </div>
          ))}
        </nav>

        <div className="flex flex-col items-center gap-1.5 border-t border-white/8 px-2 py-3">
          <Link
            href={'/cuenta' as never}
            onClick={onNavigate}
            title="Mi perfil"
            aria-label="Mi perfil"
          >
            {session.user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.avatarUrl}
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 rounded-full object-cover"
              />
            ) : (
              <span
                className="grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)' }}
              >
                {initials || '·'}
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              onLogout();
            }}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            className="grid h-7 w-7 place-items-center rounded-lg text-white/30 transition-colors hover:bg-white/8 hover:text-white/60"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </>
    );
  }

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
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Plegar menú"
            title="Plegar menú"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/8 hover:text-white/80"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
            </svg>
          </button>
        ) : null}
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
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2 rounded-xl bg-white/8 px-3 py-2 text-[13px] text-white/35 ring-1 ring-white/5 transition-colors hover:bg-white/12 hover:text-white/55"
        >
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
          <span className="flex-1 text-left">Buscar...</span>
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/25">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* ── Nav sections ── */}
      <nav className="scrollbar-thin-dark flex-1 overflow-y-auto px-2 py-2">
        {groups.map((section, idx) => {
          const childActive = section.items.some((it) =>
            it.exactMatch ? pathname === it.href : (pathname?.startsWith(it.href) ?? false),
          );
          const expanded = !section.collapsible || (openOverride[section.label] ?? childActive);
          return (
            <div key={section.label} className={idx > 0 ? 'mt-5' : ''}>
              <div className="mb-1 flex items-center justify-between px-2">
                {section.collapsible ? (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenOverride((prev) => ({ ...prev, [section.label]: !expanded }))
                    }
                    aria-expanded={expanded}
                    className="-mx-1 flex flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-[10px] font-bold uppercase tracking-widest text-white/50 transition-colors hover:bg-white/5 hover:text-white/90"
                  >
                    <span>{section.label}</span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                    {!expanded && section.items.length > 0 ? (
                      <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none tracking-normal text-white/60">
                        {section.items.length}
                      </span>
                    ) : null}
                  </button>
                ) : (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">
                    {section.label}
                  </span>
                )}
                {section.canAdd ? (
                  section.onAdd ? (
                    <button
                      type="button"
                      onClick={() => {
                        section.onAdd?.();
                        onNavigate?.();
                      }}
                      aria-label={`Añadir a ${section.label}`}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/8 text-white/50 ring-1 ring-white/10 transition-colors hover:bg-white/15 hover:text-white"
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
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/8 text-white/50 ring-1 ring-white/10 transition-colors hover:bg-white/15 hover:text-white"
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
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/8 text-white/50 ring-1 ring-white/10 transition-colors hover:bg-white/15 hover:text-white"
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

              {expanded
                ? section.items.map((item) => {
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
                            ? 'group mb-0.5 flex items-center gap-2.5 rounded-xl px-2 py-1.25 text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(46,125,206,0.35)]'
                            : 'group mb-0.5 flex items-center gap-2.5 rounded-xl px-2 py-1.25 text-[13px] font-medium text-white/60 transition-all duration-200 hover:translate-x-0.5 hover:bg-white/5 hover:text-white/90'
                        }
                        style={
                          isActive
                            ? {
                                backgroundImage:
                                  'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)',
                              }
                            : undefined
                        }
                      >
                        {item.avatar ? (
                          <div
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
                            style={{ backgroundColor: item.avatar.color }}
                          >
                            {item.avatar.letter}
                          </div>
                        ) : (
                          <span
                            className={
                              isActive
                                ? 'grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/20 text-white'
                                : 'grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/6 text-white/55 transition-colors duration-200 group-hover:bg-white/10 group-hover:text-white/90'
                            }
                          >
                            {item.emoji ? (
                              <span className="text-sm leading-none">{item.emoji}</span>
                            ) : (
                              <Icon name={item.icon} size={15} />
                            )}
                          </span>
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
                  })
                : null}
            </div>
          );
        })}
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
