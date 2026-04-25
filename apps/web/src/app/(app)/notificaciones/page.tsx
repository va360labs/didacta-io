'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import { notificationsApi, type Notification } from '@/lib/notifications';

export default function NotificacionesPage() {
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reload() {
    try {
      setNotifications(await notificationsApi.listMine());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudieron cargar las notificaciones');
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

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!notifications) return <p className="text-sm text-neutral-500">Cargando…</p>;

  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notificaciones</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {unread > 0 ? `Tenés ${unread} sin leer.` : 'Estás al día. ✓'}
          </p>
        </div>
        {unread > 0 ? (
          <Button variant="outline" size="sm" onClick={handleMarkAllRead} disabled={pending}>
            Marcar todas como leídas
          </Button>
        ) : null}
      </header>

      {notifications.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Aún no recibiste ninguna notificación.
        </p>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => {
            const unreadStyles = n.readAt
              ? 'border-neutral-200 dark:border-neutral-800'
              : 'border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950';
            return (
              <li key={n.id}>
                <article className={`rounded-md border p-4 ${unreadStyles}`}>
                  <header className="flex items-start justify-between gap-3">
                    <div>
                      {n.subject ? <p className="text-sm font-medium">{n.subject}</p> : null}
                      <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
                        {n.body}
                      </p>
                      <p className="mt-2 text-xs text-neutral-500">
                        {new Date(n.createdAt).toLocaleString()} · {n.templateKey}
                        {n.readAt ? ' · leída' : ''}
                      </p>
                    </div>
                    {!n.readAt ? (
                      <button
                        type="button"
                        onClick={() => handleMarkRead(n.id)}
                        disabled={pending}
                        className="text-xs underline decoration-dotted hover:decoration-solid"
                      >
                        Marcar leída
                      </button>
                    ) : null}
                  </header>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
