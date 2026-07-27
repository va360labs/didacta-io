'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { postPath } from '@/lib/post-link';
import { communityApi } from '@/modules/community';

interface Mention {
  id: string;
  postId: string | null;
  commentId: string | null;
  mentionedHandle: string;
  authorId: string;
  createdAt: string;
}

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

export default function MisMencionesPage() {
  const [mentions, setMentions] = useState<Mention[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    communityApi
      .listMyMentions()
      .then((data) => {
        if (!cancelled) setMentions(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar tus menciones.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">Mis menciones</h1>
        <p className="mt-1 text-text-muted">
          Cada vez que alguien te menciona con <code className="font-mono">@usuario</code> en un
          post o comentario, aparece acá.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {mentions === null ? (
        <div className="space-y-2">
          <div className="skeleton h-16 w-full" />
          <div className="skeleton h-16 w-full" />
          <div className="skeleton h-16 w-full" />
        </div>
      ) : mentions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="message" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">Aún no te mencionó nadie</h3>
            <p className="max-w-md text-text-muted">
              Cuando alguien te etiquete con <code className="font-mono">@tu-handle</code>, vas a
              recibir una notificación in-app y la mención aparecerá acá.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
          {mentions.map((m) => {
            // URL canónica del post; `?comment=` enfoca el comentario en el
            // modal (el hash #comment- anterior no lo interpretaba nadie).
            const target = m.postId
              ? postPath(m.postId, { commentId: m.commentId ?? undefined })
              : null;
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    Te mencionaron como{' '}
                    <span
                      className="rounded px-1 font-mono font-semibold"
                      style={{
                        background: 'var(--didacta-info-bg)',
                        color: 'var(--didacta-info-fg)',
                      }}
                    >
                      @{m.mentionedHandle}
                    </span>{' '}
                    {m.commentId ? 'en un comentario' : 'en un post'}.
                  </p>
                  <p className="mt-0.5 text-xs text-text-subtle tabular-nums">
                    {relTime(m.createdAt)}
                  </p>
                </div>
                {target ? (
                  <Link
                    href={target as never}
                    className="text-xs font-semibold text-brand-600 hover:underline"
                  >
                    Ir al hilo →
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
