'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';
import { cn } from '@/lib/utils';
import { notificationLink } from '@/lib/notification-link';
import { notificationsApi, type Notification } from '@/lib/notifications';

/**
 * `templateKey` → key del catálogo. Es un diccionario de clave ABIERTA: los
 * módulos pueden emitir plantillas propias, así que lo desconocido cae al
 * `subject` de la notificación (y en último término al propio templateKey).
 */
const TEMPLATE_LABEL: Record<string, string> = {
  'learning.enrollment.created': 'notificaciones.tplMatricula',
  'learning.course.completed': 'notificaciones.tplCursoCompletado',
  'certificates.issued': 'notificaciones.tplCertificado',
  'assessments.attempt.passed': 'notificaciones.tplQuizAprobado',
  'assessments.attempt.failed': 'notificaciones.tplQuizNoAlcanzado',
  'assessments.attempt.graded': 'notificaciones.tplQuizCorregido',
  'community.mention': 'notificaciones.tplMencion',
  'community.comment.on_post': 'notificaciones.tplComentario',
  'community.reply.to_comment': 'notificaciones.tplRespuesta',
};

interface IconSpec {
  name: IconName;
  tone: 'info' | 'success' | 'warn';
}

const TEMPLATE_ICON: Record<string, IconSpec> = {
  'learning.enrollment.created': { name: 'book', tone: 'info' },
  'learning.course.completed': { name: 'check', tone: 'success' },
  'certificates.issued': { name: 'award', tone: 'success' },
  'assessments.attempt.passed': { name: 'check', tone: 'success' },
  'assessments.attempt.failed': { name: 'trending', tone: 'warn' },
  'assessments.attempt.graded': { name: 'sparkles', tone: 'info' },
  'community.mention': { name: 'messages', tone: 'info' },
  'community.comment.on_post': { name: 'messages', tone: 'info' },
  'community.reply.to_comment': { name: 'messages', tone: 'info' },
};

const TONE_STYLES: Record<IconSpec['tone'], { bg: string; fg: string }> = {
  info: { bg: 'var(--didacta-info-bg)', fg: 'var(--didacta-info-fg)' },
  success: { bg: 'var(--didacta-success-bg)', fg: 'var(--didacta-success-fg)' },
  warn: { bg: 'var(--didacta-warn-bg)', fg: 'var(--didacta-warn-fg)' },
};

function formatRelative(iso: string, t: TranslatorLike): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return t('notificaciones.recien');
    if (min < 60) return t('notificaciones.haceMin', { min });
    const hours = Math.floor(min / 60);
    if (hours < 24) return t('notificaciones.haceHoras', { hours });
    const days = Math.floor(hours / 24);
    if (days < 7) return t('notificaciones.haceDias', { days });
    return formatDate(d, { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

export default function NotificacionesPage() {
  const t = useTranslations('alumnoSocial');
  const tErrors = useTranslations('errors');
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reload() {
    try {
      setNotifications(await notificationsApi.listMine());
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('notificaciones.errorCarga'),
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleMarkRead(id: string) {
    setPending(true);
    try {
      await notificationsApi.markRead(id);
      await reload();
    } finally {
      setPending(false);
    }
  }

  async function handleMarkAllRead() {
    setPending(true);
    try {
      await notificationsApi.markAllRead();
      await reload();
    } finally {
      setPending(false);
    }
  }

  if (!notifications && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-12 w-64" />
        <div className="skeleton h-20 w-full" />
        <div className="skeleton h-20 w-full" />
      </div>
    );
  }

  const unread = (notifications ?? []).filter((n) => !n.readAt).length;

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {t('notificaciones.titulo')}
          </h1>
          <p className="mt-1 text-text-muted">
            {unread > 0
              ? t('notificaciones.sinLeer', { count: unread })
              : t('notificaciones.alDia')}
          </p>
        </div>
        {unread > 0 ? (
          <Button variant="secondary" onClick={handleMarkAllRead} disabled={pending}>
            {t('notificaciones.marcarTodas')}
          </Button>
        ) : null}
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {notifications && notifications.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="flex h-16 w-16 items-center justify-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="bell" size={30} />
            </div>
            <h3 className="font-display text-xl font-semibold">
              {t('notificaciones.vacioTitulo')}
            </h3>
            <p className="max-w-md text-text-muted">{t('notificaciones.vacioNota')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0">
          <ul>
            {(notifications ?? []).map((n, idx) => {
              const isUnread = !n.readAt;
              const tplKey = TEMPLATE_LABEL[n.templateKey];
              const fallback = n.subject ?? n.templateKey;
              const label = tplKey ? labelOr(t, tplKey, fallback) : fallback;
              const spec = TEMPLATE_ICON[n.templateKey] ?? {
                name: 'bell' as const,
                tone: 'info' as const,
              };
              const style = TONE_STYLES[spec.tone];
              const link = notificationLink(n.templateKey, n.metadata);
              const details = (
                <>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="font-semibold text-text">{label}</p>
                    {isUnread ? (
                      <Badge variant="info" dot className="text-[10px]">
                        {t('notificaciones.nueva')}
                      </Badge>
                    ) : null}
                  </div>
                  {n.body ? (
                    <p className="mt-1 text-sm leading-relaxed text-text-muted">{n.body}</p>
                  ) : null}
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-text-subtle tabular-nums">
                    {formatRelative(n.createdAt, t)}
                    {link ? (
                      <span className="font-semibold text-[var(--didacta-info-fg)]">
                        · {link.actionLabel}
                      </span>
                    ) : null}
                  </p>
                </>
              );
              return (
                <li
                  key={n.id}
                  className={cn(
                    'flex items-start gap-4 px-5 py-4 transition-colors',
                    idx > 0 ? 'border-t border-border-soft' : '',
                    isUnread ? 'bg-[var(--didacta-info-bg)]/40' : 'bg-surface',
                  )}
                >
                  <div
                    aria-hidden="true"
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
                    style={{ background: style.bg, color: style.fg }}
                  >
                    <Icon name={spec.name} size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    {link ? (
                      <Link
                        href={link.href}
                        onClick={() => {
                          // Marcar leída al navegar (fire-and-forget: ya salimos de la página).
                          if (isUnread) void notificationsApi.markRead(n.id);
                        }}
                        className="block rounded-md outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--didacta-info-fg)]"
                      >
                        {details}
                      </Link>
                    ) : (
                      details
                    )}
                  </div>
                  {isUnread ? (
                    <button
                      type="button"
                      onClick={() => handleMarkRead(n.id)}
                      disabled={pending}
                      className="shrink-0 text-xs font-semibold text-[var(--didacta-info-fg)] transition-colors hover:underline"
                    >
                      {t('notificaciones.marcarLeida')}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
