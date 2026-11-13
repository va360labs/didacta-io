'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type CourseDetail, type CourseLesson, type LessonType } from '@/lib/courses';
import { meApi } from '@/lib/me';
import { storageApi } from '@/lib/storage';
import { useVideoQuota, useVideoUpload, type VideoQuotaState } from '@/lib/use-video-upload';
import { cn } from '@/lib/utils';
import { SimpleQuizForm } from './simple-quiz-form';
import { SimpleVideoField } from './simple-video-field';
import { toSlug } from './slug';
import { queryParam } from '@/lib/legacy-routes';

type SimpleKind = 'VIDEO' | 'TEXT' | 'PDF' | 'QUIZ';

const KINDS: Array<{
  kind: SimpleKind;
  icon: IconName;
  label: 'video' | 'texto' | 'archivo' | 'cuestionario';
  help: 'videoAyuda' | 'textoAyuda' | 'archivoAyuda' | 'cuestionarioAyuda';
}> = [
  { kind: 'VIDEO', icon: 'video', label: 'video', help: 'videoAyuda' },
  { kind: 'TEXT', icon: 'file', label: 'texto', help: 'textoAyuda' },
  { kind: 'PDF', icon: 'download-cloud', label: 'archivo', help: 'archivoAyuda' },
  { kind: 'QUIZ', icon: 'help', label: 'cuestionario', help: 'cuestionarioAyuda' },
];

/** Icono de una lección en la lista (el mismo que su tipo en el selector). */
function lessonIcon(type: LessonType): IconName {
  return KINDS.find((k) => k.kind === type)?.icon ?? 'file';
}

/** Tipos que el selector ofrece: el cuestionario solo con evaluaciones activas. */
export function availableKinds(assessmentsActive: boolean | null): SimpleKind[] {
  return KINDS.map((k) => k.kind).filter((k) => k !== 'QUIZ' || assessmentsActive !== false);
}

/**
 * ¿Está activo un módulo en el aula? `null` mientras no se sabe (se asume que
 * sí, como hace el menú).
 */
function useModuleActive(name: string): boolean | null {
  const [active, setActive] = useState<boolean | null>(null);
  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    let cancelled = false;
    meApi
      .getMyModules(token)
      .then((r) => {
        if (!cancelled) setActive(r.activeModules.includes(name));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [name]);
  return active;
}

/**
 * Título de la lección a partir del nombre del fichero, si la creadora aún no
 * le ha puesto uno: «espresso-basics_final.mp4» → «espresso basics final».
 */
export function titleFromFileName(name: string): string {
  const words = name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (words || name).slice(0, 200);
}

/** ¿Tiene contenido la lección? (misma regla que «Empieza aquí» en el servidor). */
export function lessonReady(lesson: Pick<CourseLesson, 'type' | 'content'>): boolean {
  const c = (lesson.content ?? {}) as Record<string, unknown>;
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (lesson.type === 'VIDEO') return has(c.videoUrl);
  if (lesson.type === 'TEXT') return has(c.text) || has(c.html);
  if (lesson.type === 'PDF') return has(c.pdfUrl);
  return Object.keys(c).length > 0;
}

/**
 * Editor de curso del MODO SENCILLO: título y lecciones. Sin «slug», sin
 * apartados, sin goteo ni niveles: añadir una lección es elegir Vídeo, Texto o
 * Archivo, ponerle título y su contenido. Las lecciones se crean en el primer
 * apartado del curso (se crea uno si no hay). El precio y la publicación viven
 * en «Empieza aquí».
 */
export function SimpleCourseEditor({ courseId }: { courseId: string }) {
  const t = useTranslations('modoSencillo.curso');
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // Desde «Empieza aquí» se llega con ?add=1: el selector ya está abierto.
  const search = useSearchParams();
  const [adding, setAdding] = useState<SimpleKind | 'choose' | null>(
    queryParam(search, 'add') === '1' ? 'choose' : null,
  );
  const [editing, setEditing] = useState<string | null>(null);
  // ¿Puede el aula subir vídeos? Se pregunta una vez para el selector y los
  // formularios: si no puede, «Vídeo» lo dice en vez de esconder la subida.
  const video = useVideoQuota();
  const kinds = availableKinds(useModuleActive('mod.assessments'));

  const load = useCallback(async () => {
    try {
      const c = await coursesApi.get(courseId);
      setCourse(c);
      setTitle(c.title);
    } catch {
      setError(t('error'));
    }
  }, [courseId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !course) return <p className="text-text-muted">{error}</p>;
  if (!course) return <div className="skeleton h-80 w-full max-w-3xl" />;

  const lessons = course.modules.flatMap((m) => m.lessons);
  const published = course.status === 'PUBLISHED';

  async function saveTitle(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || title === course?.title) return;
    try {
      await coursesApi.update(courseId, { title: title.trim() });
      await load();
    } catch {
      setError(t('error'));
    }
  }

  async function moduleId(): Promise<string> {
    if (course!.modules[0]) return course!.modules[0].id;
    const m = await coursesApi.addModule(courseId, { title: t('lecciones') });
    return m.id;
  }

  return (
    <div className="mx-auto max-w-[760px]" data-testid="editor-sencillo">
      <Link
        href="/studio/courses"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-muted hover:text-text"
      >
        <Icon name="arrow-left" size={15} />
        {t('volver')}
      </Link>

      <form onSubmit={saveTitle} className="mt-4">
        <label htmlFor="curso-titulo" className="text-sm font-semibold text-text-muted">
          {t('titulo')}
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="curso-titulo"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            className="h-12 min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 text-lg font-bold text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
          />
          {title.trim() && title !== course.title ? (
            <button
              type="submit"
              className="h-12 rounded-xl bg-brand-600 px-4 font-semibold text-white"
            >
              {t('guardarTitulo')}
            </button>
          ) : null}
        </div>
      </form>

      <CourseCover courseId={courseId} coverUrl={course.thumbnailUrl} onChanged={load} />

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-bold',
            published ? 'bg-success-50 text-success-700' : 'bg-bg-subtle text-text-subtle',
          )}
        >
          {published ? t('estadoPublicado') : t('estadoBorrador')}
        </span>
        <a
          href={`/courses/${course.slug}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
        >
          <Icon name="eye" size={14} />
          {t('verAlumno')}
        </a>
      </div>

      <section className="mt-6 rounded-2xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-bold text-text">{t('lecciones')}</h2>
          {adding === null ? (
            <button
              type="button"
              onClick={() => setAdding('choose')}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
              data-testid="anadir-leccion"
            >
              <Icon name="plus" size={15} />
              {t('anadir')}
            </button>
          ) : null}
        </div>

        {lessons.length === 0 && adding === null ? (
          <div className="px-4 py-10 text-center">
            <p className="mx-auto max-w-[44ch] text-text-muted">{t('sinLecciones')}</p>
            <button
              type="button"
              onClick={() => setAdding('choose')}
              className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white"
            >
              <Icon name="plus" size={17} />
              {t('anadir')}
            </button>
          </div>
        ) : null}

        <ol>
          {lessons.map((lesson, i) =>
            editing === lesson.id ? (
              <li key={lesson.id} className="border-b border-border p-4 last:border-b-0">
                {lesson.type === 'QUIZ' ? (
                  <SimpleQuizForm
                    lesson={lesson}
                    onCancel={() => setEditing(null)}
                    onSaved={async () => {
                      setEditing(null);
                      await load();
                    }}
                  />
                ) : (
                  <LessonForm
                    kind={
                      (lesson.type === 'PDF' || lesson.type === 'VIDEO'
                        ? lesson.type
                        : 'TEXT') as SimpleKind
                    }
                    lesson={lesson}
                    video={video}
                    onCancel={async (changed) => {
                      setEditing(null);
                      if (changed) await load();
                    }}
                    onSaved={async () => {
                      setEditing(null);
                      await load();
                    }}
                  />
                )}
              </li>
            ) : (
              <li
                key={lesson.id}
                className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bg-subtle text-text-muted">
                  <Icon name={lessonIcon(lesson.type)} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-text">
                    {i + 1}. {lesson.title}
                  </div>
                  {!lessonReady(lesson) ? (
                    <div className="text-xs text-warning-700">{t('sinContenido')}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(lesson.id)}
                  className="text-sm font-semibold text-brand-600 hover:underline"
                >
                  {t('editar')}
                </button>
              </li>
            ),
          )}
        </ol>

        {adding === 'choose' ? (
          <div className="border-t border-border p-4">
            <p className="text-sm font-semibold text-text">{t('tipoTitulo')}</p>
            <div
              className={cn(
                'mt-3 grid gap-2',
                kinds.length > 3 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3',
              )}
            >
              {KINDS.filter((k) => kinds.includes(k.kind)).map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setAdding(k.kind)}
                  className="flex items-center gap-3 rounded-xl border-[1.5px] border-border p-3 text-left hover:border-brand-600 sm:flex-col sm:items-start"
                  data-testid={`tipo-${k.kind}`}
                >
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-brand-700">
                    <Icon name={k.icon} size={20} />
                  </span>
                  <span>
                    <span className="block font-bold text-text">{t(k.label)}</span>
                    <span className="block text-sm text-text-muted">
                      {k.kind === 'VIDEO' && video.state.kind === 'off'
                        ? t('subida.ayudaSoloEnlace')
                        : t(k.help)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setAdding(null)}
              className="mt-3 text-sm font-semibold text-text-muted"
            >
              {t('cancelar')}
            </button>
          </div>
        ) : adding === 'QUIZ' ? (
          <div className="border-t border-border p-4">
            <SimpleQuizForm
              getModuleId={moduleId}
              onCancel={() => setAdding(null)}
              onSaved={async () => {
                setAdding(null);
                await load();
                window.dispatchEvent(new Event('didacta:empieza-cambio'));
              }}
            />
          </div>
        ) : adding ? (
          <div className="border-t border-border p-4">
            <LessonForm
              kind={adding}
              getModuleId={moduleId}
              video={video}
              onCancel={async (changed) => {
                setAdding(null);
                if (changed) {
                  await load();
                  window.dispatchEvent(new Event('didacta:empieza-cambio'));
                }
              }}
              onSaved={async () => {
                setAdding(null);
                await load();
                window.dispatchEvent(new Event('didacta:empieza-cambio'));
              }}
            />
          </div>
        ) : null}
      </section>

      {!published ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-bg-subtle p-4 text-sm text-text-muted">
          <span>{t('publicarDesde')}</span>
          <Link href="/start" className="font-semibold text-brand-600 hover:underline">
            {t('irEmpieza')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Portada del curso en el editor sencillo: la que sale en la tarjeta del enlace
 * de venta, en la página de venta y en las tarjetas de curso (sin ella, el
 * degradado de reserva). Usa la misma subida de imágenes que el modo completo
 * (optimizada a 1600 px) y se guarda al elegirla, sin botón aparte.
 */
function CourseCover({
  courseId,
  coverUrl,
  onChanged,
}: {
  courseId: string;
  coverUrl: string | null;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations('modoSencillo.curso.portada');
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(url: string | null) {
    await coursesApi.update(courseId, { thumbnailUrl: url });
    await onChanged();
    window.dispatchEvent(new Event('didacta:empieza-cambio'));
  }

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    try {
      const r = await storageApi.uploadImage(file, { optimize: { maxWidth: 1600 } });
      await save(r.url);
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await save(null);
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-5" data-testid="portada-curso">
      <h2 className="text-sm font-semibold text-text-muted">{t('titulo')}</h2>
      <div className="mt-1.5 flex flex-wrap items-center gap-4">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt={t('alt')}
            className="aspect-video w-48 shrink-0 rounded-xl border border-border object-cover"
            data-testid="portada-imagen"
          />
        ) : (
          <div
            aria-hidden
            className="aspect-video w-48 shrink-0 rounded-xl bg-[linear-gradient(135deg,hsl(var(--brand-h)_70%_88%),hsl(174_60%_86%))]"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="max-w-[46ch] text-sm text-text-muted">{t('ayuda')}</p>
          <input
            ref={fileRef}
            id="portada-fichero"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void pick(f);
            }}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-text hover:border-border-strong disabled:opacity-50"
              data-testid="subir-portada"
            >
              <Icon name="image" size={16} />
              {busy ? t('subiendo') : coverUrl ? t('cambiar') : t('subir')}
            </button>
            {coverUrl && !busy ? (
              <button
                type="button"
                onClick={() => void remove()}
                className="text-sm font-semibold text-text-muted hover:text-danger-700"
              >
                {t('quitar')}
              </button>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-sm font-semibold text-danger-700">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function LessonForm({
  kind,
  lesson,
  getModuleId,
  video,
  onCancel,
  onSaved,
}: {
  kind: SimpleKind;
  lesson?: CourseLesson;
  getModuleId?: () => Promise<string>;
  video: { state: VideoQuotaState; refresh: () => Promise<void> };
  /** `changed`: la lección se ha creado o cambiado aunque no se pulse «Guardar». */
  onCancel: (changed: boolean) => Promise<void> | void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('modoSencillo.curso');
  const c = (lesson?.content ?? {}) as Record<string, string | undefined>;
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [text, setText] = useState(c.text ?? '');
  const [videoUrl, setVideoUrl] = useState(c.videoUrl ?? '');
  const [savedVideoUrl, setSavedVideoUrl] = useState(c.videoUrl ?? '');
  const [pdfUrl, setPdfUrl] = useState(c.pdfUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Una lección NUEVA de vídeo no existe hasta que se elige el fichero (subir
  // exige la lección). Antes se creaba al pulsar «Vídeo» y, si se cancelaba,
  // quedaba una lección «Vídeo» vacía en el curso.
  const [lessonId, setLessonId] = useState<string | null>(lesson?.id ?? null);
  const lessonRef = useRef<string | null>(lesson?.id ?? null);
  const createdHere = useRef(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const fileRef = useRef<HTMLInputElement>(null);

  const isVideo = kind === 'VIDEO';
  const quota = isVideo && video.state.kind === 'on' ? video.state.quota : null;

  async function ensureLessonId(file: File): Promise<string> {
    if (lessonRef.current) return lessonRef.current;
    const name = titleRef.current.trim() || titleFromFileName(file.name);
    if (!titleRef.current.trim()) setTitle(name);
    const mid = await getModuleId!();
    const created = await coursesApi.addLesson(mid, { type: 'VIDEO', title: name });
    lessonRef.current = created.id;
    createdHere.current = true;
    setLessonId(created.id);
    return created.id;
  }

  const upload = useVideoUpload({
    quota,
    refreshQuota: video.refresh,
    lessonId: isVideo ? lessonId : null,
    ensureLessonId,
    videoUrl,
    savedVideoUrl,
    onVideoUrl: setVideoUrl,
    // Subido = guardado en la lección: quien no pulse «Guardar» no lo pierde.
    onUploaded: async (asset, id) => {
      try {
        await coursesApi.updateLesson(id, {
          title: titleRef.current.trim() || asset.title,
          content: { videoUrl: asset.embedUrl },
        });
        setSavedVideoUrl(asset.embedUrl);
        window.dispatchEvent(new Event('didacta:empieza-cambio'));
      } catch {
        setError(t('error'));
      }
    },
    onDuration: (minutes) => {
      const id = lessonRef.current;
      if (id) void coursesApi.updateLesson(id, { durationMinutes: minutes }).catch(() => undefined);
    },
  });

  async function removeUploaded() {
    setVideoUrl('');
    const id = lessonRef.current;
    if (!id) return;
    try {
      await coursesApi.updateLesson(id, { content: { videoUrl: '' } });
      setSavedVideoUrl('');
    } catch {
      setError(t('error'));
    }
  }

  async function cancel() {
    // Una subida a medias se cancela de verdad (y libera el espacio).
    if (upload.phase.kind === 'uploading') await upload.cancel();
    const id = lessonRef.current;
    // La lección que se creó aquí para subir y se quedó sin vídeo, fuera.
    if (createdHere.current && id && !savedVideoUrl) {
      await coursesApi.deleteLesson(id).catch(() => undefined);
      await onCancel(true);
      return;
    }
    await onCancel(createdHere.current);
  }

  async function uploadPdf(file: File) {
    try {
      const r = await storageApi.uploadImage(file, { optimize: false });
      setPdfUrl(r.url);
    } catch {
      setError(t('error'));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || upload.busy) return;
    setSaving(true);
    setError(null);
    const content = kind === 'TEXT' ? { text } : isVideo ? { videoUrl } : { pdfUrl };
    try {
      if (lessonId) {
        await coursesApi.updateLesson(lessonId, { title: title.trim(), content });
      } else {
        const mid = await getModuleId!();
        await coursesApi.addLesson(mid, { type: kind as LessonType, title: title.trim(), content });
      }
      await onSaved();
    } catch {
      setError(t('error'));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" data-testid="form-leccion">
      <div>
        <label htmlFor="leccion-titulo" className="text-sm font-semibold text-text">
          {t('tituloLeccion')}
        </label>
        <input
          id="leccion-titulo"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('tituloLeccionPlaceholder')}
          maxLength={200}
          className="mt-1.5 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
        />
      </div>

      {kind === 'TEXT' ? (
        <div>
          <label htmlFor="leccion-texto" className="text-sm font-semibold text-text">
            {t('contenidoTexto')}
          </label>
          <textarea
            id="leccion-texto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('contenidoTextoPlaceholder')}
            rows={8}
            className="mt-1.5 w-full rounded-xl border border-border bg-surface p-4 text-base text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
          />
        </div>
      ) : isVideo ? (
        <SimpleVideoField
          quotaState={video.state}
          onRetryQuota={() => void video.refresh()}
          upload={upload}
          inputId={`video-upload-${lessonId ?? 'nueva'}`}
          videoUrl={videoUrl}
          onLinkChange={setVideoUrl}
          onRemove={() => void removeUploaded()}
        />
      ) : (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void uploadPdf(e.target.files[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-4 font-semibold text-text hover:border-border-strong"
          >
            <Icon name="download-cloud" size={17} />
            {pdfUrl ? t('pdfListo') : t('subirPdf')}
          </button>
        </div>
      )}

      {error ? <p className="text-sm font-semibold text-danger-700">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving || !title.trim() || upload.busy}
          className="h-11 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="guardar-leccion"
        >
          {saving ? t('guardando') : t('guardar')}
        </button>
        <button
          type="button"
          onClick={() => void cancel()}
          className="text-sm font-semibold text-text-muted"
        >
          {t('cancelar')}
        </button>
        {upload.busy ? (
          <span className="text-sm text-text-muted">{t('subida.esperaSubida')}</span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * «Nuevo curso» del modo sencillo: solo el título. El enlace (slug) se genera
 * solo y, si ya existe, se prueba con -2, -3…
 */
export function SimpleNewCourse() {
  const t = useTranslations('modoSencillo.curso');
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const base = toSlug(title);
    for (let i = 1; i <= 10; i++) {
      try {
        const c = await coursesApi.create({
          title: title.trim(),
          slug: i === 1 ? base : `${base}-${i}`,
        });
        router.push(`/studio/courses/${c.id}`);
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== 'COURSE_SLUG_EXISTS') break;
      }
    }
    setError(t('error'));
    setBusy(false);
  }
  return (
    <form onSubmit={submit} className="mx-auto max-w-[560px]">
      <Link
        href="/studio/courses"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-muted hover:text-text"
      >
        <Icon name="arrow-left" size={15} />
        {t('volver')}
      </Link>
      <h1 className="mt-4 text-[26px] font-extrabold tracking-tight text-text">
        {t('nuevoTitulo')}
      </h1>
      <p className="mt-1 text-text-muted">{t('nuevoAyuda')}</p>
      <label htmlFor="nuevo-titulo" className="mt-6 block text-sm font-semibold text-text">
        {t('titulo')}
      </label>
      <input
        id="nuevo-titulo"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={160}
        className="mt-1.5 h-12 w-full rounded-xl border border-border bg-surface px-4 text-lg text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
      />
      {error ? <p className="mt-2 text-sm text-danger-700">{error}</p> : null}
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="mt-4 h-12 rounded-xl bg-brand-600 px-6 font-semibold text-white disabled:opacity-50"
      >
        {busy ? t('creando') : t('crear')}
      </button>
    </form>
  );
}
