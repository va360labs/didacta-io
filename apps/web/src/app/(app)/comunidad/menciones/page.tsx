'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
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

function relTime(iso: string, t: TranslatorLike): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t('menciones.ahora');
  if (diff < 3600) return t('menciones.haceMin', { minutes: Math.floor(diff / 60) });
  if (diff < 86400) return t('menciones.haceHoras', { hours: Math.floor(diff / 3600) });
  if (diff < 86400 * 7) return t('menciones.haceDias', { days: Math.floor(diff / 86400) });
  return formatDate(iso, { day: '2-digit', month: 'short' });
}

export default function MisMencionesPage() {
  const t = useTranslations('alumnoSocial');
  const tErrors = useTranslations('errors');
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
          setError(
            e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('menciones.errorCarga'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t, tErrors]);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('menciones.titulo')}</h1>
        <p className="mt-1 text-text-muted">
          {t.rich('menciones.subtitulo', {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
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
            <h3 className="font-display text-2xl font-semibold">{t('menciones.vacioTitulo')}</h3>
            <p className="max-w-md text-text-muted">
              {t.rich('menciones.vacioNota', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
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
                    {t.rich(m.commentId ? 'menciones.mencionComentario' : 'menciones.mencionPost', {
                      mark: (chunks) => (
                        <span
                          className="rounded px-1 font-mono font-semibold"
                          style={{
                            background: 'var(--didacta-info-bg)',
                            color: 'var(--didacta-info-fg)',
                          }}
                        >
                          {chunks}
                        </span>
                      ),
                      handle: m.mentionedHandle,
                    })}
                  </p>
                  <p className="mt-0.5 text-xs text-text-subtle tabular-nums">
                    {relTime(m.createdAt, t)}
                  </p>
                </div>
                {target ? (
                  <Link
                    href={target as never}
                    className="text-xs font-semibold text-brand-600 hover:underline"
                  >
                    {t('menciones.irHilo')}
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
