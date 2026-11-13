'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  learningApi,
  type DripSchedule,
  type DripAudienceKind,
  type DripUnit,
} from '@/lib/learning';
import { accessGroupsApi } from '@/lib/access-groups';
import { paymentTiersApi } from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';

/**
 * Panel de liberación programada (DRIP) de un curso. El admin/formador define
 * calendarios que liberan las lecciones (o módulos) cada N días desde la entrada
 * de cada alumno, asignados a un tier o a un grupo de acceso. UI de un módulo
 * built-in (mod.learning) → vive en apps/web (no se sirve por ZIP).
 */
export function DripPanel({ courseId }: { courseId: string }) {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const [schedules, setSchedules] = useState<DripSchedule[] | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [tierNames, setTierNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulario de alta
  const [audienceKind, setAudienceKind] = useState<DripAudienceKind>('TIER');
  const [tierRef, setTierRef] = useState('');
  const [groupRef, setGroupRef] = useState('');
  const [unit, setUnit] = useState<DripUnit>('LESSON');
  const [intervalDays, setIntervalDays] = useState(7);
  const [startOffsetDays, setStartOffsetDays] = useState(0);

  // Edición inline de un calendario existente (la audiencia no cambia).
  const [editId, setEditId] = useState<string | null>(null);
  const [editUnit, setEditUnit] = useState<DripUnit>('LESSON');
  const [editInterval, setEditInterval] = useState(7);
  const [editOffset, setEditOffset] = useState(0);

  async function reload() {
    try {
      setError(null);
      setSchedules(await learningApi.listDripSchedules(courseId));
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorLoadDrip'));
    }
  }

  useEffect(() => {
    void reload();
    // Catálogos best-effort (requieren permisos de admin): si fallan, los campos
    // siguen siendo texto libre.
    const t = authStorage.getAccessToken();
    if (t) {
      void accessGroupsApi
        .list(t, 1, 50)
        .then((r) => setGroups(r.groups.map((g) => ({ id: g.id, name: g.name }))))
        .catch(() => setGroups([]));
      void paymentTiersApi
        .listCatalog(t)
        .then((r) => setTierNames(r.tiers.map((x) => x.name)))
        .catch(() => setTierNames([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function add() {
    const audienceRef = (audienceKind === 'TIER' ? tierRef : groupRef).trim();
    if (!audienceRef) {
      setError(audienceKind === 'TIER' ? t('errorTierRequired') : t('errorGroupRequired'));
      return;
    }
    setBusy(true);
    try {
      setError(null);
      await learningApi.createDripSchedule(courseId, {
        audienceKind,
        audienceRef,
        unit,
        intervalDays,
        startOffsetDays,
      });
      setTierRef('');
      setGroupRef('');
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorCreateSchedule'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(s: DripSchedule) {
    setBusy(true);
    try {
      await learningApi.updateDripSchedule(s.id, { isActive: !s.isActive });
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorUpdate'));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(s: DripSchedule) {
    setEditId(s.id);
    setEditUnit(s.unit);
    setEditInterval(s.intervalDays);
    setEditOffset(s.startOffsetDays);
  }

  async function saveEdit() {
    if (!editId) return;
    setBusy(true);
    try {
      setError(null);
      await learningApi.updateDripSchedule(editId, {
        unit: editUnit,
        intervalDays: editInterval,
        startOffsetDays: editOffset,
      });
      setEditId(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorSaveChanges'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: DripSchedule) {
    if (!window.confirm(t('confirmDeleteSchedule'))) return;
    setBusy(true);
    try {
      await learningApi.deleteDripSchedule(s.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorDelete'));
    } finally {
      setBusy(false);
    }
  }

  function audienceLabel(s: DripSchedule): string {
    if (s.audienceKind === 'TIER') return t('audienceTier', { name: s.audienceRef });
    const g = groups.find((x) => x.id === s.audienceRef);
    return t('audienceGroup', { name: g?.name ?? s.audienceRef });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dripTitle')}</CardTitle>
        <CardDescription>
          {t.rich('dripDescription', { strong: (chunks) => <strong>{chunks}</strong> })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Alta */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="drip-audience">{t('audienceLabel')}</Label>
            <Select
              id="drip-audience"
              value={audienceKind}
              onChange={(e) => setAudienceKind(e.target.value as DripAudienceKind)}
            >
              <option value="TIER">{t('audienceByTier')}</option>
              <option value="GROUP">{t('audienceByGroup')}</option>
            </Select>
          </div>

          {audienceKind === 'TIER' ? (
            <div>
              <Label htmlFor="drip-tier">{t('tierLabel')}</Label>
              <Input
                id="drip-tier"
                list="drip-tier-options"
                value={tierRef}
                onChange={(e) => setTierRef(e.target.value)}
                placeholder={t('tierPlaceholder')}
              />
              <datalist id="drip-tier-options">
                {tierNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
          ) : (
            <div>
              <Label htmlFor="drip-group">{t('groupLabel')}</Label>
              <Select
                id="drip-group"
                value={groupRef}
                onChange={(e) => setGroupRef(e.target.value)}
              >
                <option value="">{t('groupNone')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div>
            <Label htmlFor="drip-unit">{t('unitLabel')}</Label>
            <Select
              id="drip-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as DripUnit)}
            >
              <option value="LESSON">{t('unitLesson')}</option>
              <option value="MODULE">{t('unitModuleFull')}</option>
            </Select>
          </div>

          <div>
            <Label htmlFor="drip-interval">{t('intervalLabel')}</Label>
            <Input
              id="drip-interval"
              type="number"
              min={1}
              value={intervalDays}
              onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>

          <div>
            <Label htmlFor="drip-offset">{t('offsetLabel')}</Label>
            <Input
              id="drip-offset"
              type="number"
              min={0}
              value={startOffsetDays}
              onChange={(e) => setStartOffsetDays(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>

          <div className="flex items-end">
            <Button onClick={() => void add()} disabled={busy} className="w-full">
              {t('addSchedule')}
            </Button>
          </div>
        </div>

        {/* Lista */}
        <div className="flex flex-col gap-2">
          {schedules === null ? (
            <div className="skeleton h-16 w-full" />
          ) : schedules.length === 0 ? (
            <p className="text-sm text-text-muted">{t('emptySchedules')}</p>
          ) : (
            schedules.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <Badge variant={s.audienceKind === 'TIER' ? 'warning' : 'info'}>
                  {audienceLabel(s)}
                </Badge>
                {editId === s.id ? (
                  <>
                    <Select
                      value={editUnit}
                      onChange={(e) => setEditUnit(e.target.value as DripUnit)}
                      className="w-32"
                    >
                      <option value="LESSON">{t('unitLesson')}</option>
                      <option value="MODULE">{t('unitModuleShort')}</option>
                    </Select>
                    <label className="flex items-center gap-1">
                      {t('everyWord')}
                      <Input
                        type="number"
                        min={1}
                        value={editInterval}
                        onChange={(e) => setEditInterval(Math.max(1, Number(e.target.value) || 1))}
                        className="w-16"
                      />
                      {t('daysWord')}
                    </label>
                    <label className="flex items-center gap-1">
                      {t('offsetWord')}
                      <Input
                        type="number"
                        min={0}
                        value={editOffset}
                        onChange={(e) => setEditOffset(Math.max(0, Number(e.target.value) || 0))}
                        className="w-16"
                      />
                    </label>
                    <div className="ml-auto flex items-center gap-2">
                      <Button onClick={() => void saveEdit()} disabled={busy}>
                        {t('save')}
                      </Button>
                      <Button variant="ghost" onClick={() => setEditId(null)} disabled={busy}>
                        {t('cancel')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-text">
                      {t.rich('scheduleSummary', {
                        strong: (chunks) => <strong>{chunks}</strong>,
                        unit: s.unit === 'MODULE' ? t('unitModuleWord') : t('unitLessonWord'),
                        interval: s.intervalDays,
                      })}
                      {s.startOffsetDays > 0
                        ? ` · ${t('scheduleOffset', { days: s.startOffsetDays })}`
                        : ''}
                    </span>
                    {!s.isActive && <Badge variant="muted">{t('inactive')}</Badge>}
                    <div className="ml-auto flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        <Switch checked={s.isActive} onCheckedChange={() => void toggleActive(s)} />
                        <span className="text-text-muted">{t('activeLabel')}</span>
                      </div>
                      <Button variant="ghost" onClick={() => startEdit(s)} disabled={busy}>
                        {t('edit')}
                      </Button>
                      <Button variant="ghost" onClick={() => void remove(s)} disabled={busy}>
                        {t('delete')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
