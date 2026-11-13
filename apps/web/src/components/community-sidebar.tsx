'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { CommunityAvatar } from '@/components/community-avatar';
import { CommunityPoweredBy } from '@/components/community-powered-by';
import { relTime } from '@/components/community-thread-card';
import { CommunityUpcomingCard } from '@/components/community-upcoming-card';
import { Icon } from '@/components/icon';
import { InviteAndEarnCard } from '@/components/invite-and-earn-card';
import { Card, CardContent } from '@/components/ui/card';
import { formatNumber } from '@/lib/i18n/format';
import { postPath } from '@/lib/post-link';
import { publicProfileHref } from '@/lib/public-users';
import { cn } from '@/lib/utils';
import type { CommunitySidebar as SidebarData } from '@/modules/community';
import { useCommunitySidebar } from '@/modules/community/sidebar-client';

/**
 * Barra lateral del feed de la comunidad: mezcla de la tarjeta del grupo de
 * Skool y la barra viva del aula de VA360.
 *
 *   1. Tarjeta de la academia: marca, dominio, titular, cifras (miembros · en
 *      línea · admins), caras y «Ajustes» para quien administra.
 *   2. «Invita y gana» (modo sencillo, si el aula tiene referidos).
 *   3. Próximas citas (directos y eventos).
 *   4. Ranking del mes, top 5.
 *   5. Últimos comentarios.
 *   6. Pie «Powered by Didacta».
 *
 * Todo sale de `GET /modules/community/sidebar` (una llamada, cacheada) salvo
 * los bloques que ya tenían la suya (citas, referidos). Un bloque sin datos no
 * se pinta. En el móvil la barra no va al final del feed (tras N posts nadie
 * la vería) ni abierta encima (empujaría el feed fuera de pantalla): es una
 * fila plegada arriba —nombre, miembros y quién está— que se despliega.
 */

/** Ancho a partir del cual la barra va a la derecha del feed (`lg` de Tailwind). */
const DESKTOP_QUERY = '(min-width: 1024px)';

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

interface SidebarProps {
  simple: boolean;
  /** Abre un post en el modal del feed enfocando un comentario (sin navegar). */
  onOpenComment: (postId: string, commentId: string) => void;
  /** Bloques propios del feed que van al final (p. ej. los tags del modo completo). */
  extra?: ReactNode;
}

/** Columna derecha del feed (escritorio). */
export function CommunitySidebarAside({ simple, onOpenComment, extra }: SidebarProps) {
  const data = useCommunitySidebar();
  return (
    <aside className="flex min-w-0 flex-col gap-4" data-testid="community-sidebar">
      <SidebarBlocks data={data} simple={simple} onOpenComment={onOpenComment} extra={extra} />
    </aside>
  );
}

/** Móvil: una fila plegada arriba del feed que despliega la barra entera. */
export function CommunitySidebarCollapsible({ simple, onOpenComment, extra }: SidebarProps) {
  const t = useTranslations('comunidadComponentes');
  const data = useCommunitySidebar();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (data === undefined) return <div className="skeleton h-14 w-full rounded-2xl" />;
  return (
    <section data-testid="community-sidebar-mobile" className="flex flex-col gap-3">
      {/* Sin repetir el nombre (ya está en la cabecera): caras, cuántos somos y
          quién está, como el contador de Skool. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 text-left shadow-sm transition-colors hover:border-border-strong"
      >
        {data && data.members.faces.length > 0 ? (
          <FaceStack faces={data.members.faces.slice(0, 3)} size={28} />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-sm">
          {data ? (
            <>
              <span className="font-semibold text-text">
                {t('sidebar.summaryMembers', { count: data.members.total })}
              </span>
              {data.members.online ? (
                <span className="flex items-center gap-1.5 text-text-muted">
                  <span aria-hidden="true">·</span>
                  <OnlineDot />
                  {t('sidebar.summaryOnline', { count: data.members.online })}
                </span>
              ) : null}
            </>
          ) : (
            <span className="font-semibold text-text">{t('sidebar.aboutFallback')}</span>
          )}
        </span>
        <span className="text-xs font-semibold text-brand-700">
          {open ? t('sidebar.hide') : t('sidebar.show')}
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={cn('text-text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div id={panelId} className="flex flex-col gap-4">
          <SidebarBlocks data={data} simple={simple} onOpenComment={onOpenComment} extra={extra} />
        </div>
      ) : null}
    </section>
  );
}

function SidebarBlocks({
  data,
  simple,
  onOpenComment,
  extra,
}: SidebarProps & { data: SidebarData | null | undefined }) {
  return (
    <>
      {data === undefined ? (
        <div className="skeleton h-64 w-full rounded-card" />
      ) : data ? (
        <AcademyCard data={data} />
      ) : null}
      {/* Modo sencillo: invitar está donde se habla con la comunidad. */}
      {simple ? <InviteAndEarnCard /> : null}
      {/* Qué hay por delante sin tener que ir hasta /calendar. */}
      <CommunityUpcomingCard />
      {data?.leaderboard ? <LeaderboardCard leaderboard={data.leaderboard} /> : null}
      {data && data.recentComments.length > 0 ? (
        <RecentCommentsCard comments={data.recentComments} onOpenComment={onOpenComment} />
      ) : null}
      {extra}
      <CommunityPoweredBy />
    </>
  );
}

// ── Tarjeta de la academia ───────────────────────────────────────────────────

function AcademyMark({ academy, size }: { academy: SidebarData['academy']; size: number }) {
  const dim = { width: size, height: size };
  if (academy.logoUrl) {
    return (
      <span
        className="grid shrink-0 place-items-center overflow-hidden rounded-xl border border-border-soft bg-surface"
        style={dim}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={academy.logoUrl} alt="" className="h-full w-full object-contain p-1" />
      </span>
    );
  }
  // Sin logo: la inicial del nombre sobre el color del aula (nada inventado).
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-xl bg-brand-600 font-display font-bold text-white"
      style={{ ...dim, fontSize: Math.round(size * 0.42) }}
    >
      {(academy.name.trim()[0] ?? '·').toUpperCase()}
    </span>
  );
}

function AcademyCard({ data }: { data: SidebarData }) {
  const t = useTranslations('comunidadComponentes');
  const { academy, members, canManage } = data;
  const wordmark = academy.logoUrl && academy.logoDisplayMode === 'logo_only';
  return (
    <Card className="overflow-hidden" data-testid="community-academy-card">
      {/* Portada: el aula no tiene imagen de portada propia; la banda lleva su
          logo sobre su color, que es lo que sí existe. */}
      <div
        className="grid h-24 place-items-center px-6"
        style={{
          background:
            'linear-gradient(135deg, var(--color-brand-100) 0%, var(--color-brand-50) 100%)',
        }}
      >
        {wordmark ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={academy.logoUrl!} alt="" className="max-h-14 max-w-full object-contain" />
        ) : (
          <span className="rounded-2xl shadow-sm">
            <AcademyMark academy={academy} size={60} />
          </span>
        )}
      </div>
      <CardContent className="p-5">
        <h3
          className="font-display text-lg font-bold leading-tight text-text"
          style={{ letterSpacing: '-0.01em' }}
        >
          {academy.name}
        </h3>
        {academy.host ? (
          <p className="mt-0.5 truncate text-xs text-text-subtle" data-testid="academy-host">
            {academy.host}
          </p>
        ) : null}
        {academy.description ? (
          <p
            className="mt-2.5 text-sm leading-snug text-text-muted"
            data-testid="academy-description"
          >
            {academy.description}
          </p>
        ) : null}

        <div className="mt-4 grid grid-flow-col auto-cols-fr divide-x divide-border-soft rounded-xl bg-bg-subtle py-2.5 text-center">
          <Stat
            href="/members"
            testId="academy-members"
            value={formatNumber(members.total)}
            label={t('sidebar.members', { count: members.total })}
          />
          {members.online ? (
            <Stat
              testId="academy-online"
              value={formatNumber(members.online)}
              label={t('sidebar.online')}
              dot
            />
          ) : null}
          {members.admins ? (
            <Stat
              testId="academy-admins"
              value={formatNumber(members.admins)}
              label={t('sidebar.admins', { count: members.admins })}
            />
          ) : null}
        </div>

        {members.faces.length > 0 ? (
          <div className="mt-4">
            <FaceStack faces={members.faces} size={34} linked label={t('sidebar.facesAria')} />
          </div>
        ) : null}

        {canManage ? (
          <Link
            href="/admin/settings"
            data-testid="academy-settings"
            className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface text-sm font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle"
          >
            <Icon name="cog" size={16} />
            {t('sidebar.settings')}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Caras solapadas (como la fila de miembros de Skool), con el punto verde en
 * quien está en línea. Sin enlace dentro de un botón (fila plegada del móvil).
 */
function FaceStack({
  faces,
  size,
  linked = false,
  label,
}: {
  faces: SidebarData['members']['faces'];
  size: number;
  linked?: boolean;
  label?: string;
}) {
  const t = useTranslations('comunidadComponentes');
  return (
    <ul
      className="flex shrink-0 items-center"
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {faces.map((f, i) => (
        <li
          key={f.id}
          className={cn('relative rounded-full ring-2 ring-surface', i > 0 && '-ml-2')}
          style={{ zIndex: faces.length - i }}
        >
          <CommunityAvatar
            userId={linked ? f.id : undefined}
            name={f.name ?? t('anonymous')}
            avatarUrl={f.avatarUrl}
            size={size}
            linkToProfile={linked}
          />
          {f.online ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-(--didacta-growth)"
              title={t('sidebar.online')}
            >
              <span className="sr-only">{t('sidebar.online')}</span>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Una cifra de la tarjeta: número grande y su etiqueta debajo. */
function Stat({
  value,
  label,
  href,
  testId,
  dot = false,
}: {
  value: string;
  label: string;
  href?: string;
  testId: string;
  dot?: boolean;
}) {
  const body = (
    <>
      <span className="flex items-center justify-center gap-1.5 font-display text-base font-bold tabular-nums text-text group-hover:text-brand-700">
        {dot ? <OnlineDot /> : null}
        {value}
      </span>
      <span className="block text-[11px] text-text-muted">{label}</span>
    </>
  );
  return href ? (
    <Link href={href as never} className="group block px-1" data-testid={testId}>
      {body}
    </Link>
  ) : (
    <div className="px-1" data-testid={testId}>
      {body}
    </div>
  );
}

/** Punto verde con destello: alguien está conectado ahora mismo. */
function OnlineDot() {
  return (
    <span aria-hidden="true" className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-(--didacta-growth) opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-(--didacta-growth)" />
    </span>
  );
}

// ── Ranking del mes ──────────────────────────────────────────────────────────

/** Medallas 1-2-3: los mismos tonos que la página del ranking. */
const MEDAL: Record<number, string> = {
  1: 'bg-(--didacta-gold)/15 text-(--didacta-gold)',
  2: 'bg-bg-subtle text-text-muted',
  3: 'bg-(--didacta-coral)/15 text-(--didacta-warn-fg)',
};

function LeaderboardCard({
  leaderboard,
}: {
  leaderboard: NonNullable<SidebarData['leaderboard']>;
}) {
  const t = useTranslations('comunidadComponentes');
  return (
    <Card data-testid="community-leaderboard">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-display text-base font-semibold text-text">
            {t('sidebar.leaderboardTitle')}
          </h4>
          <Link
            href="/leaderboard"
            className="text-xs font-medium text-brand-700 hover:underline"
            aria-label={t('sidebar.leaderboardSeeAllAria')}
          >
            {t('seeAll')}
          </Link>
        </div>
        <ol className="mt-3 space-y-1">
          {leaderboard.entries.map((e) => (
            <li key={e.id} className="flex items-center gap-2.5 py-1.5">
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold tabular-nums',
                  MEDAL[e.rank] ?? 'text-text-subtle',
                )}
                aria-label={t('sidebar.rankAria', { rank: e.rank })}
              >
                {e.rank}
              </span>
              <CommunityAvatar
                userId={e.id}
                name={e.name ?? t('anonymous')}
                avatarUrl={e.avatarUrl}
                size={28}
              />
              <Link
                href={publicProfileHref(e.id)}
                className="min-w-0 flex-1 truncate text-[13px] font-medium text-text hover:underline"
              >
                {e.name ?? t('anonymous')}
              </Link>
              <span
                className="shrink-0 text-[13px] font-semibold tabular-nums text-(--didacta-success-fg)"
                aria-label={t('sidebar.pointsAria', { points: e.points })}
              >
                +{formatNumber(e.points)}
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// ── Últimos comentarios ──────────────────────────────────────────────────────

function RecentCommentsCard({
  comments,
  onOpenComment,
}: {
  comments: SidebarData['recentComments'];
  onOpenComment: (postId: string, commentId: string) => void;
}) {
  const t = useTranslations('comunidadComponentes');
  return (
    <Card data-testid="community-recent-comments">
      <CardContent className="p-5">
        <h4 className="font-display text-base font-semibold text-text">
          {t('sidebar.recentTitle')}
        </h4>
        <ul className="mt-3 space-y-1">
          {comments.map((c, i) => (
            <li key={c.id} className={i > 0 ? 'border-t border-border-soft' : undefined}>
              <a
                href={postPath(c.postId, { commentId: c.id })}
                onClick={(e) => {
                  // Clic normal: el post se abre en el modal del feed, sin
                  // recargarlo. Con Ctrl/Cmd o botón central, pestaña nueva.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onOpenComment(c.postId, c.id);
                }}
                className="flex gap-2.5 rounded-lg py-2.5 hover:opacity-80"
              >
                <CommunityAvatar
                  name={c.author.name ?? t('anonymous')}
                  avatarUrl={c.author.avatarUrl}
                  size={28}
                  linkToProfile={false}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-[13px]">
                    <span className="truncate font-semibold text-text">
                      {c.author.name ?? t('anonymous')}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-subtle">
                      {relTime(c.createdAt, t)}
                    </span>
                  </span>
                  {c.excerpt ? (
                    <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-text-muted">
                      {c.excerpt}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block truncate text-[11px] text-text-subtle">
                    {t('sidebar.recentOn', { title: c.postTitle })}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
