'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Icon } from '@/components/icon';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { coursesApi, type Course } from '@/lib/courses';
import { learningApi, type Competency } from '@/lib/learning';

export default function AdminCompetenciasPage() {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [competencies, setCompetencies] = useState<Competency[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourse, setSelectedCourse] = useState('');
  // Mapa competencyId -> { checked, weight } para el curso seleccionado.
  const [tagState, setTagState] = useState<Record<string, { checked: boolean; weight: number }>>(
    {},
  );
  const [tagLoading, setTagLoading] = useState(false);
  const [tagSaving, setTagSaving] = useState(false);
  const [tagSaved, setTagSaved] = useState(false);

  async function reloadCatalog() {
    try {
      setError(null);
      setCompetencies(await learningApi.listCompetencies());
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reloadCatalog();
    void coursesApi
      .list()
      .then(setCourses)
      .catch(() => setCourses([]));
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await learningApi.createCompetency({
        name: newName.trim(),
        description: newDesc.trim() || null,
      });
      setNewName('');
      setNewDesc('');
      await reloadCatalog();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await learningApi.deleteCompetency(id);
      await reloadCatalog();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  // Al elegir un curso, cargamos sus competencias asignadas y construimos el
  // estado del formulario a partir del catálogo completo.
  async function selectCourse(courseId: string) {
    setSelectedCourse(courseId);
    setTagSaved(false);
    if (!courseId || !competencies) {
      setTagState({});
      return;
    }
    setTagLoading(true);
    try {
      const assigned = await learningApi.getCourseCompetencies(courseId);
      const assignedMap = new Map(assigned.map((a) => [a.competencyId, a.weight]));
      const state: Record<string, { checked: boolean; weight: number }> = {};
      for (const c of competencies) {
        state[c.id] = { checked: assignedMap.has(c.id), weight: assignedMap.get(c.id) ?? 1 };
      }
      setTagState(state);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setTagLoading(false);
    }
  }

  async function handleSaveTags() {
    if (!selectedCourse) return;
    setTagSaving(true);
    setTagSaved(false);
    try {
      const items = Object.entries(tagState)
        .filter(([, v]) => v.checked)
        .map(([competencyId, v]) => ({ competencyId, weight: v.weight }));
      await learningApi.setCourseCompetencies(selectedCourse, items);
      setTagSaved(true);
      setTimeout(() => setTagSaved(false), 2500);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setTagSaving(false);
    }
  }

  const catalogEmpty = competencies !== null && competencies.length === 0;
  const sortedCourses = useMemo(
    () => [...courses].sort((a, b) => a.title.localeCompare(b.title, 'es')),
    [courses],
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1
          className="font-display text-2xl font-bold tracking-tight text-text"
          style={{ letterSpacing: '-0.02em' }}
        >
          {t('competencies.title')}
        </h1>
        <p className="mt-1.5 text-text-muted">{t('competencies.subtitle')}</p>
      </header>

      {error ? (
        <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700">
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Catálogo */}
        <Card>
          <CardHeader>
            <CardTitle>{t('competencies.catalogTitle')}</CardTitle>
            <CardDescription>{t('competencies.catalogDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('competencies.namePlaceholder')}
                maxLength={80}
              />
              <Button onClick={() => void handleCreate()} disabled={creating || !newName.trim()}>
                <Icon name="plus" size={16} />
                {t('competencies.add')}
              </Button>
            </div>
            <Input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder={t('competencies.descPlaceholder')}
              maxLength={280}
            />

            {competencies === null ? (
              <p className="py-4 text-sm text-text-muted">{t('competencies.loading')}</p>
            ) : catalogEmpty ? (
              <p className="py-4 text-sm text-text-muted">{t('competencies.catalogEmpty')}</p>
            ) : (
              <ul className="divide-y divide-[#F1F5F9]">
                {competencies.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">{c.name}</p>
                      {c.description ? (
                        <p className="truncate text-xs text-text-muted">{c.description}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDelete(c.id)}
                      aria-label={t('competencies.deleteAria', { name: c.name })}
                      className="shrink-0 rounded-md p-1.5 text-text-subtle transition-colors hover:bg-danger-50 hover:text-danger-700"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Competencias por curso */}
        <Card>
          <CardHeader>
            <CardTitle>{t('competencies.byCourseTitle')}</CardTitle>
            <CardDescription>{t('competencies.byCourseDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="course">{t('competencies.courseLabel')}</Label>
              <Select
                id="course"
                value={selectedCourse}
                onChange={(e) => void selectCourse(e.target.value)}
              >
                <option value="">{t('competencies.coursePlaceholder')}</option>
                {sortedCourses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            </div>

            {!selectedCourse ? (
              <p className="py-4 text-sm text-text-muted">{t('competencies.chooseCourse')}</p>
            ) : catalogEmpty ? (
              <p className="py-4 text-sm text-text-muted">{t('competencies.createFirst')}</p>
            ) : tagLoading ? (
              <p className="py-4 text-sm text-text-muted">{t('competencies.loading')}</p>
            ) : (
              <>
                <ul className="divide-y divide-[#F1F5F9]">
                  {(competencies ?? []).map((c) => {
                    const st = tagState[c.id] ?? { checked: false, weight: 1 };
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                        <label className="flex items-center gap-2.5 text-sm text-text">
                          <input
                            type="checkbox"
                            checked={st.checked}
                            onChange={(e) =>
                              setTagState((s) => ({
                                ...s,
                                [c.id]: { ...st, checked: e.target.checked },
                              }))
                            }
                            className="h-4 w-4 rounded border-border-strong text-brand-500 focus:ring-brand-500"
                          />
                          {c.name}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-text-subtle">
                            {t('competencies.weight')}
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={st.weight}
                            disabled={!st.checked}
                            onChange={(e) =>
                              setTagState((s) => ({
                                ...s,
                                [c.id]: {
                                  ...st,
                                  weight: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                                },
                              }))
                            }
                            className="w-14 rounded-md border border-border bg-surface px-2 py-1 text-sm text-text disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                  {tagSaved ? (
                    <span className="text-sm font-semibold text-success-700">
                      {t('competencies.saved')}
                    </span>
                  ) : (
                    <span className="text-sm text-text-subtle">{t('competencies.defineHint')}</span>
                  )}
                  <Button onClick={() => void handleSaveTags()} disabled={tagSaving}>
                    {tagSaving ? t('competencies.saving') : t('competencies.save')}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
