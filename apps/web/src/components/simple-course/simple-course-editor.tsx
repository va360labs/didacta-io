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
import { VideoUploadField } from '@/components/video-upload-field';
import { coursesApi, type CourseDetail, type CourseLesson, type LessonType } from '@/lib/courses';
import { storageApi } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { toSlug } from './slug';

type SimpleKind = 'VIDEO' | 'TEXT' | 'PDF';

const KINDS: Array<{
  kind: SimpleKind;
  icon: IconName;
  label: 'video' | 'texto' | 'archivo';
  help: 'videoAyuda' | 'textoAyuda' | 'archivoAyuda';
}> = [
  { kind: 'VIDEO', icon: 'video', label: 'video', help: 'videoAyuda' },
  { kind: 'TEXT', icon: 'file', label: 'texto', help: 'textoAyuda' },
  { kind: 'PDF', icon: 'download-cloud', label: 'archivo', help: 'archivoAyuda' },
];

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
  // Desde «Empieza aquí» se llega con ?anadir=1: el selector ya está abierto.
  const search = useSearchParams();
  const [adding, setAdding] = useState<SimpleKind | 'choose' | null>(
    search?.get('anadir') === '1' ? 'choose' : null,
  );
  const [editing, setEditing] = useState<string | null>(null);

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
        href="/formador/cursos"
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
          href={`/cursos/${course.slug}`}
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
                <LessonForm
                  kind={
                    (lesson.type === 'PDF' || lesson.type === 'VIDEO'
                      ? lesson.type
                      : 'TEXT') as SimpleKind
                  }
                  lesson={lesson}
                  onCancel={() => setEditing(null)}
                  onSaved={async () => {
                    setEditing(null);
                    await load();
                  }}
                />
              </li>
            ) : (
              <li
                key={lesson.id}
                className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bg-subtle text-text-muted">
                  <Icon
                    name={
                      lesson.type === 'VIDEO'
                        ? 'video'
                        : lesson.type === 'PDF'
                          ? 'download-cloud'
                          : 'file'
                    }
                    size={16}
                  />
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
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {KINDS.map((k) => (
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
                    <span className="block text-sm text-text-muted">{t(k.help)}</span>
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
        ) : adding ? (
          <div className="border-t border-border p-4">
            <LessonForm
              kind={adding}
              getModuleId={moduleId}
              onCancel={() => setAdding(null)}
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
          <Link href="/empieza" className="font-semibold text-brand-600 hover:underline">
            {t('irEmpieza')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function LessonForm({
  kind,
  lesson,
  getModuleId,
  onCancel,
  onSaved,
}: {
  kind: SimpleKind;
  lesson?: CourseLesson;
  getModuleId?: () => Promise<string>;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('modoSencillo.curso');
  const c = (lesson?.content ?? {}) as Record<string, string | undefined>;
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [text, setText] = useState(c.text ?? '');
  const [videoUrl, setVideoUrl] = useState(c.videoUrl ?? '');
  const [pdfUrl, setPdfUrl] = useState(c.pdfUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Para subir un vídeo directo hace falta la lección: se crea al elegir «Vídeo».
  const [lessonId, setLessonId] = useState<string | null>(lesson?.id ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const creating = useRef(false);

  useEffect(() => {
    if (kind !== 'VIDEO' || lessonId || !getModuleId || creating.current) return;
    creating.current = true;
    void (async () => {
      try {
        const mid = await getModuleId();
        const created = await coursesApi.addLesson(mid, { type: 'VIDEO', title: t('video') });
        setLessonId(created.id);
      } catch {
        setError(t('error'));
      }
    })();
  }, [kind, lessonId, getModuleId, t]);

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
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    const content = kind === 'TEXT' ? { text } : kind === 'VIDEO' ? { videoUrl } : { pdfUrl };
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
      ) : kind === 'VIDEO' ? (
        <div className="grid gap-3">
          {lessonId ? (
            <VideoUploadField
              lessonId={lessonId}
              videoUrl={videoUrl}
              savedVideoUrl={c.videoUrl ?? ''}
              onVideoUrl={setVideoUrl}
            />
          ) : null}
          <div>
            <label htmlFor="leccion-video" className="text-sm font-semibold text-text">
              {t('enlaceVideo')}
            </label>
            <input
              id="leccion-video"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://"
              className="mt-1.5 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-text outline-none focus:border-brand-600"
            />
          </div>
        </div>
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
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving || !title.trim()}
          className="h-11 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="guardar-leccion"
        >
          {saving ? t('guardando') : t('guardar')}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-semibold text-text-muted">
          {t('cancelar')}
        </button>
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
        router.push(`/formador/cursos/${c.id}`);
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
        href="/formador/cursos"
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
