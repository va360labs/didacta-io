'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UserChip } from '@/components/user-chip';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { learningApi, type LessonComment } from '@/lib/learning';

interface Props {
  courseId: string;
}

/**
 * Cola de comentarios pendientes de moderación para el profesor.
 * Se renderiza dentro del builder del curso (/formador/cursos/[id])
 * y agrega TODOS los pendientes del curso, agrupados por lección.
 *
 * Si no hay pendientes, no muestra nada (silenciosa cuando no hay nada
 * que hacer). Cuando aparece algo nuevo, el formador lo ve aquí con
 * Aprobar/Rechazar inline en lugar de tener que abrir cada lección.
 */
export function PendingCommentsQueue({ courseId }: Props) {
  const t = useTranslations('comunidadComponentes');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<LessonComment[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setItems(await learningApi.listPendingComments(courseId));
      setError(null);
    } catch (e) {
      // 403 si el viewer no es formador/admin: silenciamos, ya que el
      // alumno no debería ver este componente nunca.
      if (e instanceof ApiHttpError && e.status === 403) {
        setItems([]);
        return;
      }
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function handleApprove(c: LessonComment) {
    setPending(true);
    setError(null);
    try {
      await learningApi.approveLessonComment(c.id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  async function handleReject(c: LessonComment) {
    const reason = window.prompt(t('promptRejectReason')) ?? undefined;
    setPending(true);
    setError(null);
    try {
      await learningApi.rejectLessonComment(c.id, reason || undefined);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  // Mientras carga (null) o no hay nada, no renderizamos: la cola
  // sólo aparece cuando el formador tiene trabajo de moderación real.
  if (items === null || items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{t('pendingCommentsTitle')}</CardTitle>
          <Badge variant="warning" dot>
            {items.length}
          </Badge>
        </div>
        <CardDescription>{t('pendingCommentsDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}

        <ul className="space-y-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-lg border border-border-soft bg-surface-2 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-subtle">
                <UserChip
                  userId={c.authorId}
                  name={c.authorDisplayName}
                  fallback={t('anonymous')}
                  showAvatar={false}
                  size={20}
                  nameClassName="block truncate font-semibold text-text"
                />
                <span>·</span>
                <span>{relTime(c.createdAt, t)}</span>
                <span>·</span>
                <code className="font-mono text-[11px]">
                  {t('lessonRef', { id: c.lessonId.slice(0, 8) })}
                </code>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
                {c.body}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="success"
                  onClick={() => void handleApprove(c)}
                  disabled={pending}
                >
                  {t('approve')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleReject(c)}
                  disabled={pending}
                >
                  {t('reject')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function relTime(iso: string, t: TranslatorLike): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t('relTimeNow');
  if (diff < 3600) return t('relTimeMinutes', { minutes: Math.floor(diff / 60) });
  if (diff < 86400) return t('relTimeHours', { hours: Math.floor(diff / 3600) });
  if (diff < 86400 * 7) return t('relTimeDays', { days: Math.floor(diff / 86400) });
  return formatDate(iso, { day: '2-digit', month: 'short' });
}
