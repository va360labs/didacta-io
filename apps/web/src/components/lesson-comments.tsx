'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los comentarios.');
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
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos publicar tu comentario. Prueba de nuevo.',
      );
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos aprobar el comentario.');
    } finally {
      setPending(false);
    }
  }

  async function handleReject(c: LessonComment) {
    const reason =
      window.prompt('Motivo del rechazo (opcional, se muestra al autor):') ?? undefined;
    setPending(true);
    try {
      await learningApi.rejectLessonComment(c.id, reason || undefined);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos rechazar el comentario.');
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(c: LessonComment) {
    if (!window.confirm('¿Eliminar tu comentario?')) return;
    setPending(true);
    try {
      await learningApi.deleteLessonComment(c.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el comentario.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <h3 className="font-display text-lg font-semibold text-text">Comentarios</h3>
          <p className="text-xs text-text-subtle">
            Tus comentarios pasan por el profesor del curso antes de ser visibles para el resto.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-2">
          <Textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="¿Tienes una pregunta o anotación sobre esta lección?"
            maxLength={4000}
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" disabled={pending || !body.trim()}>
              {pending ? 'Enviando…' : 'Enviar comentario'}
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
          <p className="text-sm text-text-subtle">Aún no hay comentarios. Sé el primero.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((c) => {
              const isMine = c.authorId === myUserId;
              return (
                <li key={c.id} className="rounded-lg border border-border-soft bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text">
                      {c.authorDisplayName ?? (isMine ? 'Vos' : 'Anónimo')}
                    </span>
                    {c.status === 'PENDING' ? (
                      <Badge variant="warning" dot>
                        En revisión
                      </Badge>
                    ) : c.status === 'REJECTED' ? (
                      <Badge variant="muted" dot>
                        Rechazado
                      </Badge>
                    ) : null}
                    <span className="text-xs text-text-subtle">{relTime(c.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
                    {c.body}
                  </p>
                  {c.status === 'REJECTED' && c.rejectionReason ? (
                    <p className="mt-1 text-xs text-warning-700">
                      Motivo del rechazo: {c.rejectionReason}
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
                          Aprobar
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleReject(c)}
                          disabled={pending}
                        >
                          Rechazar
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
                        Eliminar
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

function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}
