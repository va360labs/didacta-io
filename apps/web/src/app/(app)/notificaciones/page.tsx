'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { notificationsApi, type Notification } from '@/lib/notifications';

const TEMPLATE_LABEL: Record<string, string> = {
  'learning.enrollment.created': 'Te matriculaste en un curso',
  'learning.course.completed': 'Completaste un curso',
  'certificates.issued': 'Tu certificado está listo',
  'assessments.attempt.passed': 'Aprobaste un quiz',
  'assessments.attempt.failed': 'No alcanzaste el umbral',
  'assessments.attempt.graded': 'Tu intento fue corregido',
};

const TEMPLATE_ICON: Record<string, string> = {
  'learning.enrollment.created': '✎',
  'learning.course.completed': '✓',
  'certificates.issued': '🎓',
  'assessments.attempt.passed': '✓',
  'assessments.attempt.failed': '↻',
  'assessments.attempt.graded': '★',
};

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `hace ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `hace ${days} d`;
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

export default function NotificacionesPage() {
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reload() {
    try {
      setNotifications(await notificationsApi.listMine());
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar tus notificaciones. Probá refrescar la página.',
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
          <h1 className="font-display text-3xl font-bold tracking-tight">Notificaciones</h1>
          <p className="mt-1 text-text-muted">
            {unread > 0
              ? `Tenés ${unread} sin leer.`
              : 'Al día. Te avisaremos cuando haya algo nuevo.'}
          </p>
        </div>
        {unread > 0 ? (
          <Button variant="secondary" onClick={handleMarkAllRead} disabled={pending}>
            Marcar todas como leídas
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
              className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-brand-700 text-3xl"
              aria-hidden="true"
            >
              🔔
            </div>
            <h3 className="font-display text-xl font-semibold">No hay notificaciones</h3>
            <p className="max-w-md text-text-muted">
              Cuando te matricules en un curso, completes lecciones o recibás un certificado, vas a
              ver el resumen acá.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {(notifications ?? []).map((n) => {
            const isUnread = !n.readAt;
            const label = TEMPLATE_LABEL[n.templateKey] ?? n.subject ?? n.templateKey;
            const icon = TEMPLATE_ICON[n.templateKey] ?? '·';
            return (
              <li key={n.id}>
                <article
                  className={
                    isUnread
                      ? 'flex items-start gap-4 rounded-lg border border-brand-200 bg-brand-50/40 p-4 transition-colors'
                      : 'flex items-start gap-4 rounded-lg border border-border bg-surface p-4 transition-colors'
                  }
                >
                  <div
                    className={
                      isUnread
                        ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-lg'
                        : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-text-muted text-lg'
                    }
                    aria-hidden="true"
                  >
                    {icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="font-semibold text-text">{label}</p>
                      {isUnread ? (
                        <Badge variant="primary" className="text-[10px]">
                          Nueva
                        </Badge>
                      ) : null}
                    </div>
                    {n.body ? (
                      <p className="mt-1 text-sm text-text-muted leading-relaxed">{n.body}</p>
                    ) : null}
                    <p className="mt-2 text-xs text-text-subtle tabular-nums">
                      {formatRelative(n.createdAt)}
                    </p>
                  </div>
                  {isUnread ? (
                    <button
                      type="button"
                      onClick={() => handleMarkRead(n.id)}
                      disabled={pending}
                      className="text-xs font-semibold text-brand-700 hover:underline shrink-0"
                    >
                      Marcar leída
                    </button>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
