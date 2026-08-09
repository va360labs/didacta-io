'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type Course, type CourseDetail } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import { getBrowserTimeZone } from '@/lib/i18n/user-prefs';
import { zoomLiveApi, type SessionStatus, type ZoomSession } from '@/modules/zoom-live';
import {
  COMMON_TIMEZONES,
  isValidTimeZone,
  isoToWallTime,
  timeZoneLabel,
  wallTimeToIso,
} from '@/modules/zoom-live/wall-time';

const STATUS_VARIANT: Record<SessionStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  SCHEDULED: 'warning',
  STARTED: 'success',
  ENDED: 'muted',
  CANCELLED: 'danger',
};

function formatStart(iso: string, tz: string): string {
  try {
    return formatDateTime(iso, {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function AulaVirtualPage() {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const [sessions, setSessions] = useState<ZoomSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  /** Sesión en edición. null = el formulario, si está abierto, crea una nueva. */
  const [editing, setEditing] = useState<ZoomSession | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setShowForm((v) => !v);
  }

  function openEdit(session: ZoomSession) {
    setEditing(session);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  async function handleCopyLink(id: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/clase/${id}`);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {
      // Clipboard no disponible: sin feedback, sin romper.
    }
  }

  async function reload() {
    try {
      setError(null);
      setSessions(await zoomLiveApi.list());
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('aula.loadError'));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleCancel(id: string) {
    if (!confirm(t('aula.confirmCancel'))) return;
    try {
      await zoomLiveApi.cancel(id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('aula.cancelError'));
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('aula.title')}</h1>
          <p className="mt-1 max-w-3xl text-text-muted">{t('aula.intro')}</p>
        </div>
        <Button type="button" onClick={openCreate}>
          <Icon name="plus" size={16} />
          {showForm && !editing ? t('aula.close') : t('aula.newSession')}
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <SessionForm
          // Remonta el formulario al cambiar de sesión: los defaultValue de
          // los inputs no controlados solo se aplican al montar.
          key={editing?.id ?? 'nueva'}
          session={editing}
          onSaved={async () => {
            closeForm();
            await reload();
          }}
          onCancel={closeForm}
        />
      ) : null}

      {sessions === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : sessions.length === 0 ? (
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
              <Icon name="calendar" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">{t('aula.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('aula.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {sessions.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <span
                  aria-hidden="true"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
                  style={{
                    background: 'var(--didacta-info-bg)',
                    color: 'var(--didacta-info-fg)',
                  }}
                >
                  <Icon name="calendar" size={22} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-semibold leading-tight text-text">
                      {s.topic}
                    </h3>
                    <Badge variant={STATUS_VARIANT[s.status]} dot>
                      {labelOr(t, `sessionStatus.${s.status}`, s.status)}
                    </Badge>
                  </div>
                  <p className="text-sm text-text-muted">
                    {t.rich('aula.sessionMeta', {
                      num: (chunks) => <span className="tabular-nums">{chunks}</span>,
                      start: formatStart(s.startTime, s.timezone),
                      minutes: s.durationMinutes,
                      email: s.hostEmail,
                      registered: s.registeredCount,
                    })}
                  </p>
                  {s.description ? (
                    <p className="line-clamp-2 text-xs text-text-subtle">{s.description}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {s.startUrl && s.status !== 'CANCELLED' && s.status !== 'ENDED' ? (
                    <Button asChild size="sm">
                      <Link href={s.startUrl as never} target="_blank">
                        <Icon name="play" size={13} />
                        {t('aula.start')}
                      </Link>
                    </Button>
                  ) : null}
                  {s.joinUrl && s.status !== 'CANCELLED' && s.status !== 'ENDED' ? (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={s.joinUrl as never} target="_blank">
                        {t('aula.join')}
                      </Link>
                    </Button>
                  ) : null}
                  {/* La API solo admite editar mientras no haya terminado ni
                      estar cancelada (SessionAlreadyEndedError). */}
                  {s.status === 'SCHEDULED' || s.status === 'STARTED' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(s)}
                      data-testid={`editar-clase-${s.id}`}
                    >
                      <Icon name="edit" size={13} />
                      {t('aula.edit')}
                    </Button>
                  ) : null}
                  {s.status !== 'CANCELLED' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopyLink(s.id)}
                    >
                      <Icon name="link" size={13} />
                      {copiedId === s.id ? t('aula.copied') : t('aula.copyLink')}
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/clase/${s.id}`}>
                      <Icon name="users" size={13} />
                      {t('aula.viewClass')}
                    </Link>
                  </Button>
                  {s.status === 'SCHEDULED' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCancel(s.id)}
                    >
                      <Icon name="trash" size={13} />
                      {t('aula.cancel')}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Formulario de clase en directo, en modo alta o edición.
 *
 * En edición solo se ofrecen los campos que la API admite cambiar
 * (`updateSessionSchema`): título, fecha/hora, duración, zona y agenda. El
 * host, el curso y la lección quedan fijos desde la creación — cambiarlos
 * obligaría a recrear el meeting en Zoom —, así que se muestran como dato, no
 * como input muerto.
 */
function SessionForm({
  session: editing,
  onSaved,
  onCancel,
}: {
  /** null = alta. Con sesión = edición de esa clase. */
  session: ZoomSession | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const isEdit = editing !== null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>('');
  const [courseDetail, setCourseDetail] = useState<CourseDetail | null>(null);
  const [lessonId, setLessonId] = useState<string>('');
  const authSession = authStorage.getSession();
  const defaultEmail = authSession?.user.email ?? '';
  const tzGuess = getBrowserTimeZone() ?? 'UTC';
  const [timezone, setTimezone] = useState(editing?.timezone ?? tzGuess);
  // La zona del navegador va primero si no está ya en la lista, para que el
  // formador nunca tenga que buscar la suya.
  const tzOptions =
    COMMON_TIMEZONES.includes(tzGuess) || !isValidTimeZone(tzGuess)
      ? COMMON_TIMEZONES
      : [tzGuess, ...COMMON_TIMEZONES];

  // Carga inicial de cursos publicados del tenant para el select (solo alta:
  // en edición el curso no se puede cambiar).
  useEffect(() => {
    if (isEdit) return;
    let aborted = false;
    void coursesApi
      .list({ status: 'PUBLISHED' })
      .then((list) => {
        if (!aborted) setCourses(list);
      })
      .catch(() => {
        // Si falla la carga, dejamos los selects vacíos. El submit
        // sigue siendo válido (curso/lección son opcionales).
      });
    return () => {
      aborted = true;
    };
  }, [isEdit]);

  // Al cambiar de curso, cargamos su detalle para el select de lecciones.
  // El reset de lessonId evita que quede un id huérfano de un curso anterior.
  useEffect(() => {
    setLessonId('');
    setCourseDetail(null);
    if (!courseId) return;
    let aborted = false;
    void coursesApi
      .get(courseId)
      .then((detail) => {
        if (!aborted) setCourseDetail(detail);
      })
      .catch(() => {
        if (!aborted) setCourseDetail(null);
      });
    return () => {
      aborted = true;
    };
  }, [courseId]);

  // Lista plana de lecciones del curso seleccionado (preserva el orden
  // de módulos y dentro de cada módulo el orden de lecciones).
  const lessonOptions = (courseDetail?.modules ?? []).flatMap((m) =>
    m.lessons.map((l) => ({ id: l.id, label: `${m.title} · ${l.title}` })),
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    const startTimeRaw = String(form.get('startTime') ?? '');
    if (!startTimeRaw) {
      setError(t('sessionForm.missingStartTime'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      // `datetime-local` da `2026-05-15T10:00` SIN zona. Se interpreta en la
      // zona ELEGIDA para la clase, no en la del navegador: si no, un
      // formador conectado desde otra zona programaría a otra hora.
      const tz = String(form.get('timezone') ?? tzGuess);
      if (editing) {
        await zoomLiveApi.update(editing.id, {
          topic: String(form.get('topic') ?? ''),
          startTime: wallTimeToIso(startTimeRaw, tz),
          durationMinutes: Number(form.get('durationMinutes') ?? 60),
          timezone: tz,
          // `null` limpia la agenda; `undefined` la dejaría intacta.
          description: form.get('description') ? String(form.get('description')) : null,
          announce: form.get('announce') === 'on',
        });
      } else {
        await zoomLiveApi.create({
          topic: String(form.get('topic') ?? ''),
          startTime: wallTimeToIso(startTimeRaw, tz),
          durationMinutes: Number(form.get('durationMinutes') ?? 60),
          hostEmail: String(form.get('hostEmail') ?? defaultEmail),
          timezone: tz,
          description: form.get('description') ? String(form.get('description')) : undefined,
          courseId: form.get('courseId') ? String(form.get('courseId')) : undefined,
          lessonId: form.get('lessonId') ? String(form.get('lessonId')) : undefined,
          announce: form.get('announce') === 'on',
        });
      }
      await onSaved();
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? apiErrorMessage(e, tErrors)
          : editing
            ? t('sessionForm.updateError')
            : t('sessionForm.createError'),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name={isEdit ? 'edit' : 'plus'} size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle>
              {isEdit ? t('sessionForm.editTitle') : t('sessionForm.createTitle')}
            </CardTitle>
            <CardDescription>
              {isEdit ? t('sessionForm.editDescription') : t('sessionForm.createDescription')}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="topic">
              {t('sessionForm.topicLabel')} <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="topic"
              name="topic"
              required
              maxLength={200}
              placeholder={t('sessionForm.topicPlaceholder')}
              defaultValue={editing?.topic ?? ''}
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="startTime">
                {t('sessionForm.startTimeLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="startTime"
                name="startTime"
                type="datetime-local"
                // Leída en la ZONA DE LA CLASE, no en la del navegador: si no,
                // guardar sin tocar el campo movería la clase de hora.
                defaultValue={editing ? isoToWallTime(editing.startTime, editing.timezone) : ''}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="durationMinutes">
                {t('sessionForm.durationLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min={15}
                max={480}
                defaultValue={editing?.durationMinutes ?? 60}
                required
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hostEmail">
                {t('sessionForm.hostEmailLabel')}{' '}
                {isEdit ? null : <span className="text-danger-700">*</span>}
              </Label>
              {isEdit ? (
                <>
                  <p className="rounded-lg border border-border-soft bg-bg-subtle px-3 py-2 text-sm text-text-muted">
                    {editing.hostEmail}
                  </p>
                  <p className="text-xs text-text-subtle">{t('sessionForm.hostFixedNote')}</p>
                </>
              ) : (
                <>
                  <Input
                    id="hostEmail"
                    name="hostEmail"
                    type="email"
                    defaultValue={defaultEmail}
                    required
                  />
                  <p className="text-xs text-text-subtle">{t('sessionForm.hostCreateNote')}</p>
                </>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">{t('sessionForm.timezoneLabel')}</Label>
              <Select
                id="timezone"
                name="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                required
              >
                {tzOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {timeZoneLabel(tz)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">{t('sessionForm.timezoneHint')}</p>
            </div>
          </div>
          {isEdit ? null : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="courseId">{t('sessionForm.courseLabel')}</Label>
                <Select
                  id="courseId"
                  name="courseId"
                  value={courseId}
                  onChange={(e) => setCourseId(e.target.value)}
                >
                  <option value="">{t('sessionForm.freeSessionOption')}</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lessonId">{t('sessionForm.lessonLabel')}</Label>
                <Select
                  id="lessonId"
                  name="lessonId"
                  value={lessonId}
                  onChange={(e) => setLessonId(e.target.value)}
                  disabled={!courseId || lessonOptions.length === 0}
                >
                  <option value="">{t('sessionForm.noLessonOption')}</option>
                  {lessonOptions.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-text-subtle">{t('sessionForm.lessonHint')}</p>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="description">{t('sessionForm.agendaLabel')}</Label>
            <Textarea
              id="description"
              name="description"
              rows={3}
              maxLength={2000}
              defaultValue={editing?.description ?? ''}
            />
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-border-soft bg-bg-subtle p-3">
            <input
              id="announce"
              name="announce"
              type="checkbox"
              // En alta va marcada (lo normal es querer anunciarla). En edición
              // NO: guardar un cambio no puede publicar por la espalda una
              // clase que se creó a propósito sin anunciar.
              defaultChecked={!isEdit}
              data-testid="anunciar-clase"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--didacta-trust)]"
            />
            <div className="min-w-0">
              <Label htmlFor="announce" className="cursor-pointer">
                {isEdit ? t('sessionForm.announceNow') : t('sessionForm.announce')}
              </Label>
              <p className="text-xs text-text-subtle">
                {isEdit ? t('sessionForm.announceEditHint') : t('sessionForm.announceCreateHint')}
              </p>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={pending}>
              {pending
                ? t('sessionForm.saving')
                : isEdit
                  ? t('sessionForm.saveChanges')
                  : t('sessionForm.createSession')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              {t('sessionForm.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
