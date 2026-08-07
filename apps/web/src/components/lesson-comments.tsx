'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { UserChip } from '@/components/user-chip';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { learningApi, type LessonComment } from '@/lib/learning';

interface Props {
  lessonId: string;
  courseId: string;
}

/**
 * Sección de comentarios del alumno en una lección. Cada comentario
 * pasa por moderación del profesor (estado PENDING) antes de ser
 * visible al resto. El autor siempre ve los suyos (PENDING/REJECTED)
 * con el estado etiquetado.
 *
 * Si el viewer es formador/admin, también ve los pendientes de otros
 * y puede aprobarlos/rechazarlos inline. La moderación más cómoda
 * (cola completa del curso) vive en el builder del profesor.
 */
export function LessonComments({ lessonId, courseId }: Props) {
  const t = useTranslations('comunidadComponentes');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<LessonComment[] | null>(null);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = authStorage.getSession();
  const myUserId = session?.user.id;
  const myRoles = session?.user.roles ?? [];
  const canModerate = myRoles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r));

  async function reload() {
    try {
      setItems(await learningApi.listLessonComments(lessonId));
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setPending(true);
    setError(null);
    try {
      await learningApi.createLessonComment(lessonId, { courseId, body: body.trim() });
      setBody('');
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  async function handleApprove(c: LessonComment) {
    setPending(true);
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
    try {
      await learningApi.rejectLessonComment(c.id, reason || undefined);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(c: LessonComment) {
    if (!window.confirm(t('confirmDeleteOwnComment'))) return;
    setPending(true);
    try {
      await learningApi.deleteLessonComment(c.id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <h3 className="font-display text-lg font-semibold text-text">{t('commentsTitle')}</h3>
          <p className="text-xs text-text-subtle">{t('commentsModerationNote')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-2">
          <Textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('lessonCommentPlaceholder')}
            maxLength={4000}
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" disabled={pending || !body.trim()}>
              {pending ? t('sending') : t('submitComment')}
            </Button>
          </div>
        </form>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}

        {items === null ? (
          <div className="space-y-2">
            <div className="skeleton h-16 w-full" />
            <div className="skeleton h-16 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-text-subtle">{t('noLessonComments')}</p>
        ) : (
          <ul className="space-y-3">
            {items.map((c) => {
              const isMine = c.authorId === myUserId;
              return (
                <li key={c.id} className="rounded-lg border border-border-soft bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <UserChip
                      userId={c.authorId}
                      name={c.authorDisplayName ?? (isMine ? t('you') : null)}
                      fallback={t('anonymous')}
                      showAvatar={false}
                      size={20}
                      nameClassName="block truncate text-sm font-semibold text-text"
                    />
                    {c.status === 'PENDING' ? (
                      <Badge variant="warning" dot>
                        {t('inReview')}
                      </Badge>
                    ) : c.status === 'REJECTED' ? (
                      <Badge variant="muted" dot>
                        {t('rejected')}
                      </Badge>
                    ) : null}
                    <span className="text-xs text-text-subtle">{relTime(c.createdAt, t)}</span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
                    {c.body}
                  </p>
                  {c.status === 'REJECTED' && c.rejectionReason ? (
                    <p className="mt-1 text-xs text-warning-700">
                      {t('rejectionReason', { reason: c.rejectionReason })}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {canModerate && c.status === 'PENDING' ? (
                      <>
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
                      </>
                    ) : null}
                    {isMine ? (
                      <button
                        type="button"
                        onClick={() => void handleDelete(c)}
                        disabled={pending}
                        className="ml-auto text-xs text-danger-700 hover:underline"
                      >
                        {t('delete')}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
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
