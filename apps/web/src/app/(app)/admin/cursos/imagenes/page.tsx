'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type Course } from '@/lib/courses';
import { storageApi } from '@/lib/storage';

/** Marcador de las imágenes alojadas en el storage local de Didacta. */
const LOCAL_MARKER = '/api/v1/storage/file/';

function isLocalImage(url: string | null): url is string {
  return Boolean(url && url.includes(LOCAL_MARKER));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RowStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; previousSize: number; size: number }
  | { kind: 'unchanged' }
  | { kind: 'error'; message: string };

export default function CourseImagesAdminPage() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    try {
      const list = await coursesApi.list();
      setCourses(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los cursos.');
    }
  }

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage]);

  const withImage = useMemo(
    () => (courses ?? []).filter((c) => Boolean(c.thumbnailUrl)),
    [courses],
  );
  const optimizable = useMemo(
    () => withImage.filter((c) => isLocalImage(c.thumbnailUrl)),
    [withImage],
  );

  async function optimizeOne(course: Course): Promise<void> {
    if (!isLocalImage(course.thumbnailUrl)) return;
    setStatuses((s) => ({ ...s, [course.id]: { kind: 'running' } }));
    try {
      const res = await storageApi.optimizeExisting(course.thumbnailUrl, { maxWidth: 1600 });
      if (res.optimized) {
        await coursesApi.update(course.id, { thumbnailUrl: res.url });
        setCourses((prev) =>
          (prev ?? []).map((c) => (c.id === course.id ? { ...c, thumbnailUrl: res.url } : c)),
        );
        setStatuses((s) => ({
          ...s,
          [course.id]: { kind: 'done', previousSize: res.previousSize, size: res.size },
        }));
      } else {
        setStatuses((s) => ({ ...s, [course.id]: { kind: 'unchanged' } }));
      }
    } catch (e) {
      setStatuses((s) => ({
        ...s,
        [course.id]: {
          kind: 'error',
          message: e instanceof ApiHttpError ? e.message : 'Error al optimizar.',
        },
      }));
    }
  }

  async function optimizeAll(): Promise<void> {
    setRunningAll(true);
    setError(null);
    // Secuencial a propósito: cada optimización lee+reescribe un fichero; no
    // conviene saturar el backend con decenas de cursos a la vez.
    for (const course of optimizable) {
      const current = statuses[course.id];
      if (current?.kind === 'done') continue; // ya optimizada en esta sesión
      await optimizeOne(course);
    }
    setRunningAll(false);
  }

  const totalSaved = useMemo(
    () =>
      Object.values(statuses).reduce(
        (acc, st) => (st.kind === 'done' ? acc + (st.previousSize - st.size) : acc),
        0,
      ),
    [statuses],
  );

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">
          Solo los administradores del tenant pueden optimizar las imágenes de los cursos.
        </CardContent>
      </Card>
    );
  }

  const externalCount = withImage.length - optimizable.length;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">Imágenes de cursos</h1>
        <p className="mt-1 max-w-2xl text-text-muted">
          Recomprime a WebP y redimensiona las portadas de curso ya subidas para que carguen más
          rápido. Las imágenes nuevas se optimizan automáticamente al subirlas; esta herramienta es
          para las que ya estaban en la plataforma.
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

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Portadas optimizables</CardTitle>
              <CardDescription>
                {courses === null
                  ? 'Cargando…'
                  : `${optimizable.length} portada${optimizable.length === 1 ? '' : 's'} en el storage de Didacta` +
                    (externalCount > 0
                      ? ` · ${externalCount} con imagen externa (no optimizable)`
                      : '')}
                {totalSaved > 0 ? ` · ahorro acumulado: ${formatBytes(totalSaved)}` : ''}
              </CardDescription>
            </div>
            <Button
              type="button"
              onClick={() => void optimizeAll()}
              disabled={runningAll || optimizable.length === 0}
            >
              {runningAll ? 'Optimizando…' : 'Optimizar todas'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {courses === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-14 w-full" />
              ))}
            </div>
          ) : withImage.length === 0 ? (
            <p className="text-sm text-text-subtle">Ningún curso tiene imagen destacada todavía.</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {withImage.map((c) => {
                const local = isLocalImage(c.thumbnailUrl);
                const st = statuses[c.id] ?? { kind: 'idle' };
                return (
                  <li key={c.id} className="flex items-center gap-3 py-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.thumbnailUrl!}
                      alt=""
                      className="h-12 w-20 shrink-0 rounded-md border border-border object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">{c.title}</p>
                      <p className="truncate text-xs text-text-subtle">
                        <StatusLabel status={st} local={local} />
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void optimizeOne(c)}
                      disabled={!local || runningAll || st.kind === 'running'}
                    >
                      {st.kind === 'running' ? 'Optimizando…' : 'Optimizar'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function StatusLabel({ status, local }: { status: RowStatus; local: boolean }) {
  if (!local) return <span>Imagen externa: no se puede optimizar desde aquí.</span>;
  switch (status.kind) {
    case 'running':
      return <span>Optimizando…</span>;
    case 'done':
      return (
        <span className="text-success-700">
          Optimizada: {formatBytes(status.previousSize)} → {formatBytes(status.size)}
        </span>
      );
    case 'unchanged':
      return <span>Ya estaba optimizada.</span>;
    case 'error':
      return <span className="text-danger-700">{status.message}</span>;
    default:
      return <span>Pendiente de optimizar.</span>;
  }
}
