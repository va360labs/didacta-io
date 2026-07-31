'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  updatePath,
  publishPath,
  archivePath,
  restorePath,
  type LearningPath,
  type LearningPathCourseEntry,
} from '@/lib/learning-paths';
import { coursesApi, type Course } from '@/lib/courses';
import { apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

function withAuth() {
  return authStorage.getAccessToken() ?? undefined;
}

async function getPathById(
  id: string,
): Promise<LearningPath & { courses: LearningPathCourseEntry[] }> {
  return apiFetch(`/api/v1/modules/learning/paths/formador`, {}, withAuth()).then(
    (list: unknown) => {
      const paths = list as Array<LearningPath & { courses: LearningPathCourseEntry[] }>;
      const found = paths.find((p) => p.id === id);
      if (!found) throw new Error('not found');
      return found;
    },
  );
}

export default function EditarRutaPage() {
  const { id } = useParams<{ id: string }>();

  const [path, setPath] = useState<(LearningPath & { courses: LearningPathCourseEntry[] }) | null>(
    null,
  );
  const [allCourses, setAllCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sequenceType, setSequenceType] = useState<'LINEAR' | 'FLEXIBLE'>('LINEAR');
  const [estimatedMinutes, setEstimatedMinutes] = useState<number | ''>('');
  const [selectedCourses, setSelectedCourses] = useState<
    Array<{ courseId: string; position: number }>
  >([]);

  useEffect(() => {
    Promise.all([getPathById(id), coursesApi.list({ status: 'PUBLISHED' })])
      .then(([p, courses]) => {
        setPath(p);
        setAllCourses(courses);
        setTitle(p.title);
        setDescription(p.description ?? '');
        setSequenceType(p.sequenceType);
        setEstimatedMinutes(p.estimatedMinutes ?? '');
        setSelectedCourses(p.courses.map((c) => ({ courseId: c.courseId, position: c.position })));
      })
      .finally(() => setLoading(false));
  }, [id]);

  const showSaveMsg = useCallback((msg: string) => {
    setSaveMsg(msg);
    setTimeout(() => setSaveMsg(null), 3000);
  }, []);

  async function handleSave() {
    if (!path) return;
    setSaving(true);
    try {
      const updated = await updatePath(path.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        sequenceType,
        estimatedMinutes: estimatedMinutes !== '' ? Number(estimatedMinutes) : undefined,
        courses: selectedCourses,
      });
      setPath((prev) => (prev ? { ...prev, ...updated } : prev));
      showSaveMsg('Cambios guardados');
    } catch {
      showSaveMsg('Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!path) return;
    setActionBusy(true);
    try {
      const updated = await publishPath(path.id);
      setPath((prev) => (prev ? { ...prev, status: updated.status } : prev));
      showSaveMsg(updated.status === 'PUBLISHED' ? 'Ruta publicada' : 'Ruta despublicada');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleArchive() {
    if (!path || !confirm(`¿Archivar "${path.title}"?`)) return;
    setActionBusy(true);
    try {
      const updated = await archivePath(path.id);
      setPath((prev) => (prev ? { ...prev, status: updated.status } : prev));
      showSaveMsg('Ruta archivada');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRestore() {
    if (!path) return;
    setActionBusy(true);
    try {
      const updated = await restorePath(path.id);
      setPath((prev) => (prev ? { ...prev, status: updated.status } : prev));
      showSaveMsg('Ruta restaurada a borrador');
    } finally {
      setActionBusy(false);
    }
  }

  function addCourse(courseId: string) {
    if (selectedCourses.some((c) => c.courseId === courseId)) return;
    setSelectedCourses((prev) => [...prev, { courseId, position: prev.length }]);
  }

  function removeCourse(courseId: string) {
    setSelectedCourses((prev) =>
      prev.filter((c) => c.courseId !== courseId).map((c, i) => ({ ...c, position: i })),
    );
  }

  function moveCourse(courseId: string, dir: -1 | 1) {
    setSelectedCourses((prev) => {
      const idx = prev.findIndex((c) => c.courseId === courseId);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next.map((c, i) => ({ ...c, position: i }));
    });
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-border" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-surface" />
      </div>
    );
  }

  if (!path) {
    return (
      <div className="flex flex-col items-center gap-4 py-20">
        <p className="text-text-muted">Ruta no encontrada.</p>
        <Link href="/formador/rutas" className="text-sm text-(--didacta-trust) hover:underline">
          Volver
        </Link>
      </div>
    );
  }

  const selectedIds = new Set(selectedCourses.map((c) => c.courseId));
  const availableCourses = allCourses.filter((c) => !selectedIds.has(c.id));
  const canPublish = selectedCourses.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/formador/rutas"
            className="mb-1 flex items-center gap-1 text-xs text-text-muted hover:text-text"
          >
            ← Mis rutas
          </Link>
          <h1 className="font-display text-xl font-bold text-text">{path.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {saveMsg && <span className="text-xs text-text-muted">{saveMsg}</span>}
          {path.status !== 'ARCHIVED' && (
            <button
              onClick={handlePublish}
              disabled={actionBusy || (!canPublish && path.status === 'DRAFT')}
              title={!canPublish ? 'Añade al menos un curso para publicar' : ''}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-background disabled:opacity-50"
            >
              {path.status === 'PUBLISHED' ? 'Despublicar' : 'Publicar'}
            </button>
          )}
          {path.status !== 'ARCHIVED' ? (
            <button
              onClick={handleArchive}
              disabled={actionBusy}
              className="rounded-lg border border-amber-200 px-3 py-1.5 text-sm font-medium text-amber-600 hover:bg-amber-50 disabled:opacity-50"
            >
              Archivar
            </button>
          ) : (
            <button
              onClick={handleRestore}
              disabled={actionBusy}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-background disabled:opacity-50"
            >
              Restaurar a borrador
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-(--didacta-trust) px-4 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-5 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-text">Información general</h2>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text">Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-(--didacta-trust)/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text">Descripción</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-(--didacta-trust)/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text">Tipo de secuencia</label>
            <div className="flex gap-4">
              {(['LINEAR', 'FLEXIBLE'] as const).map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name="seq"
                    value={t}
                    checked={sequenceType === t}
                    onChange={() => setSequenceType(t)}
                    className="accent-(--didacta-trust)"
                  />
                  {t === 'LINEAR' ? 'Lineal' : 'Flexible'}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text">Duración estimada (minutos)</label>
            <input
              type="number"
              min={1}
              value={estimatedMinutes}
              onChange={(e) =>
                setEstimatedMinutes(e.target.value === '' ? '' : Number(e.target.value))
              }
              placeholder="Ej. 120"
              className="w-32 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-(--didacta-trust)/40"
            />
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-text">Cursos de la ruta</h2>

          {selectedCourses.length === 0 && (
            <p className="text-sm text-text-muted">Aún no hay cursos. Añade uno abajo.</p>
          )}

          <div className="space-y-2">
            {selectedCourses.map((sc, idx) => {
              const course = allCourses.find((c) => c.id === sc.courseId);
              return (
                <div
                  key={sc.courseId}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
                >
                  <span className="w-5 text-center text-xs font-semibold text-text-muted">
                    {idx + 1}
                  </span>
                  <span className="flex-1 truncate text-sm text-text">
                    {course?.title ?? sc.courseId}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => moveCourse(sc.courseId, -1)}
                      disabled={idx === 0}
                      className="rounded p-1 text-text-muted hover:text-text disabled:opacity-30"
                      title="Subir"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveCourse(sc.courseId, 1)}
                      disabled={idx === selectedCourses.length - 1}
                      className="rounded p-1 text-text-muted hover:text-text disabled:opacity-30"
                      title="Bajar"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => removeCourse(sc.courseId)}
                      className="rounded p-1 text-red-400 hover:text-red-600"
                      title="Eliminar"
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {availableCourses.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-text-muted">Añadir curso</p>
              <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-lg border border-border bg-background p-2">
                {availableCourses.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => addCourse(c.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text hover:bg-surface"
                  >
                    <span className="text-xs text-green-600">+</span>
                    {c.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {availableCourses.length === 0 && selectedCourses.length > 0 && (
            <p className="text-xs text-text-muted">Todos los cursos publicados están en la ruta.</p>
          )}
        </div>
      </div>
    </div>
  );
}
