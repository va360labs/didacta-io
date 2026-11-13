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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { UserChip } from '@/components/user-chip';
import {
  accessGroupsApi,
  type AccessGroupDetail,
  type AccessGroupKind,
  type AccessGroupListItem,
  type CourseCatalogItem,
  type UserCandidate,
} from '@/lib/access-groups';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { labelOr } from '@/lib/i18n/labels';
import { paymentTiersApi } from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';

const KIND_VARIANT: Record<AccessGroupKind, 'success' | 'warning' | 'muted'> = {
  ALL_COURSES: 'success',
  MULTI_COURSE: 'warning',
  COURSE: 'muted',
};

export default function GruposAccesoPage() {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');

  // Textos de notices/confirms usados dentro de funciones async cuyo scope
  // local llama `t` a su variable de token: se resuelven aquí, en el scope
  // del hook, y las funciones capturan el resultado.
  const noticeCreated = t('groups.created');
  const noticeMarkedDefault = t('groups.markedDefault');
  const noticeCoursesSaved = t('groups.coursesSaved');
  const noticeTierUnlinked = t('groups.tierUnlinkedNotice');
  const deleteConfirmText = t('groups.deleteConfirm');
  const noticeDeleted = (count: number) => t('groups.deleted', { count });
  const noticeTierLinked = (name: string) => t('groups.tierLinkedNotice', { name });

  const [groups, setGroups] = useState<AccessGroupListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Crear grupo
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AccessGroupKind>('MULTI_COURSE');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Detalle / gestión
  const [detail, setDetail] = useState<AccessGroupDetail | null>(null);
  const [courseCatalog, setCourseCatalog] = useState<CourseCatalogItem[]>([]);
  const [selectedCourses, setSelectedCourses] = useState<Set<string>>(new Set());
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<UserCandidate[]>([]);
  const [busy, setBusy] = useState(false);

  // Vínculo con tier (mod.payment-connections)
  const [tierCatalog, setTierCatalog] = useState<string[]>([]);
  const [linkedTier, setLinkedTier] = useState('');

  function token(): string | null {
    return authStorage.getAccessToken();
  }

  async function reload() {
    const t = token();
    if (!t) return;
    try {
      setError(null);
      const res = await accessGroupsApi.list(t);
      setGroups(res.groups);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createGroup() {
    const t = token();
    if (!t || !newName.trim()) return;
    setCreating(true);
    try {
      setError(null);
      await accessGroupsApi.create(t, {
        name: newName.trim(),
        kind: newKind,
        description: newDescription.trim() || undefined,
      });
      setNewName('');
      setNewDescription('');
      setNotice(noticeCreated);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setCreating(false);
    }
  }

  async function openDetail(id: string) {
    const t = token();
    if (!t) return;
    setBusy(true);
    try {
      setError(null);
      const [d, catalog] = await Promise.all([
        accessGroupsApi.get(t, id),
        accessGroupsApi.courseCatalog(t),
      ]);
      setDetail(d);
      setCourseCatalog(catalog);
      setSelectedCourses(new Set(d.courseIds));
      setUserQuery('');
      setUserResults([]);
      setLinkedTier(d.linkedTierName ?? '');
      // Best-effort: el catálogo de tiers requiere super_admin; si falla, el
      // campo sigue siendo texto libre (el vínculo es por nombre de tier).
      try {
        const tiers = await paymentTiersApi.listCatalog(t);
        setTierCatalog(tiers.tiers.map((x) => x.name));
      } catch {
        setTierCatalog([]);
      }
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function markDefault(id: string) {
    const t = token();
    if (!t) return;
    try {
      await accessGroupsApi.update(t, id, { isDefaultForApproval: true });
      setNotice(noticeMarkedDefault);
      await reload();
      if (detail?.id === id) await openDetail(id);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function toggleAutoGrant(g: AccessGroupListItem) {
    const t = token();
    if (!t) return;
    try {
      await accessGroupsApi.update(t, g.id, { autoGrantNewCourses: !g.autoGrantNewCourses });
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function deleteGroup(id: string) {
    const t = token();
    if (!t) return;
    if (!window.confirm(deleteConfirmText)) return;
    try {
      const res = await accessGroupsApi.remove(t, id);
      setNotice(noticeDeleted(res.revokedMembers));
      if (detail?.id === id) setDetail(null);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  function toggleCourse(courseId: string) {
    setSelectedCourses((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  }

  async function saveCourses() {
    const t = token();
    if (!t || !detail) return;
    setBusy(true);
    try {
      const d = await accessGroupsApi.setCourses(t, detail.id, Array.from(selectedCourses));
      setDetail(d);
      setNotice(noticeCoursesSaved);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function saveTierLink() {
    const t = token();
    if (!t || !detail) return;
    setBusy(true);
    try {
      setError(null);
      const value = linkedTier.trim();
      const d = await accessGroupsApi.update(t, detail.id, { linkedTierName: value || null });
      setDetail(d);
      setNotice(value ? noticeTierLinked(value) : noticeTierUnlinked);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function searchUsers() {
    const t = token();
    if (!t) return;
    try {
      const res = await accessGroupsApi.userCatalog(t, userQuery);
      setUserResults(res);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function assignUser(userId: string) {
    const t = token();
    if (!t || !detail) return;
    setBusy(true);
    try {
      await accessGroupsApi.assignMembers(t, detail.id, [userId]);
      await openDetail(detail.id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function revokeUser(userId: string) {
    const t = token();
    if (!t || !detail) return;
    setBusy(true);
    try {
      await accessGroupsApi.revokeMember(t, detail.id, userId);
      await openDetail(detail.id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('groups.title')}</h1>
        <p className="text-text-muted">{t('groups.subtitle')}</p>
      </header>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-brand-500/30 bg-brand-50 px-4 py-3 text-sm text-brand-700">
          {notice}
        </div>
      )}

      {/* Crear grupo */}
      <Card>
        <CardHeader>
          <CardTitle>{t('groups.newTitle')}</CardTitle>
          <CardDescription>{t('groups.newDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label htmlFor="ag-name">{t('groups.nameLabel')}</Label>
            <Input
              id="ag-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('groups.namePlaceholder')}
            />
          </div>
          <div className="w-full sm:w-52">
            <Label htmlFor="ag-kind">{t('groups.kindLabel')}</Label>
            <Select
              id="ag-kind"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as AccessGroupKind)}
            >
              <option value="ALL_COURSES">{t('groupKind.ALL_COURSES')}</option>
              <option value="MULTI_COURSE">{t('groupKind.MULTI_COURSE')}</option>
              <option value="COURSE">{t('groupKind.COURSE')}</option>
            </Select>
          </div>
          <Button onClick={() => void createGroup()} disabled={creating || !newName.trim()}>
            {creating ? t('groups.creating') : t('groups.create')}
          </Button>
        </CardContent>
        <CardContent className="pt-0">
          <Label htmlFor="ag-desc">{t('groups.descriptionLabel')}</Label>
          <Textarea
            id="ag-desc"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            rows={2}
            placeholder={t('groups.descriptionPlaceholder')}
          />
        </CardContent>
      </Card>

      {/* Lista de grupos */}
      <div className="flex flex-col gap-3">
        {groups === null ? (
          <Skeleton className="h-24 w-full" />
        ) : groups.length === 0 ? (
          <p className="text-text-muted">{t('groups.empty')}</p>
        ) : (
          groups.map((g) => (
            <Card key={g.id} className={detail?.id === g.id ? 'border-brand-500' : undefined}>
              <CardContent className="flex flex-wrap items-center gap-3 py-4">
                <div className="flex-1 min-w-[12rem]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-text">{g.name}</span>
                    <Badge variant={KIND_VARIANT[g.kind]}>
                      {labelOr(t, `groupKind.${g.kind}`, g.kind)}
                    </Badge>
                    {g.isDefaultForApproval && (
                      <Badge variant="success">{t('groups.defaultBadge')}</Badge>
                    )}
                    {g.linkedTierName && (
                      <Badge variant="warning">
                        {t('groups.tierBadge', { name: g.linkedTierName })}
                      </Badge>
                    )}
                    {g.kind === 'ALL_COURSES' && g.autoGrantNewCourses && (
                      <Badge variant="muted">{t('groups.autoGrantBadge')}</Badge>
                    )}
                  </div>
                  <p className="text-sm text-text-muted">
                    {t('groups.memberCount', { count: g.memberCount })}
                    {` · ${
                      g.courseCount !== null
                        ? t('groups.courseCountSuffix', { count: g.courseCount })
                        : t('groups.allCoursesSuffix')
                    }`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void openDetail(g.id)}>
                    {t('groups.manage')}
                  </Button>
                  {!g.isDefaultForApproval && (
                    <Button variant="ghost" onClick={() => void markDefault(g.id)}>
                      {t('groups.markDefault')}
                    </Button>
                  )}
                  {g.kind === 'ALL_COURSES' && (
                    <div className="flex items-center gap-2 px-2">
                      <Switch
                        checked={g.autoGrantNewCourses}
                        onCheckedChange={() => void toggleAutoGrant(g)}
                      />
                      <span className="text-sm text-text-muted">{t('groups.autoGrantSwitch')}</span>
                    </div>
                  )}
                  <Button variant="ghost" onClick={() => void deleteGroup(g.id)}>
                    {t('groups.delete')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Panel de gestión */}
      {detail && (
        <Card>
          <CardHeader>
            <CardTitle>{t('groups.manageTitle', { name: detail.name })}</CardTitle>
            <CardDescription>
              {labelOr(t, `groupKind.${detail.kind}`, detail.kind)} ·{' '}
              {t('groups.memberCount', { count: detail.memberCount })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* Cursos */}
            {detail.kind === 'ALL_COURSES' ? (
              <p className="text-sm text-text-muted">
                {t.rich('groups.allCoursesInfo', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            ) : (
              <div>
                <h3 className="mb-2 font-medium text-text">{t('groups.coursesTitle')}</h3>
                <div className="flex flex-col gap-1">
                  {courseCatalog.length === 0 ? (
                    <p className="text-sm text-text-muted">{t('groups.noCourses')}</p>
                  ) : (
                    courseCatalog.map((c) => {
                      const on = selectedCourses.has(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleCourse(c.id)}
                          className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${
                            on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-border'
                          }`}
                        >
                          <span>{c.title}</span>
                          <span>{on ? '✓' : '+'}</span>
                        </button>
                      );
                    })
                  )}
                </div>
                <Button className="mt-3" onClick={() => void saveCourses()} disabled={busy}>
                  {t('groups.saveCourses')}
                </Button>
              </div>
            )}

            {/* Vínculo con tier */}
            <div>
              <h3 className="mb-1 font-medium text-text">{t('groups.tierTitle')}</h3>
              <p className="mb-2 text-sm text-text-muted">{t('groups.tierHelp')}</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Label htmlFor="ag-tier">{t('groups.tierNameLabel')}</Label>
                  <Input
                    id="ag-tier"
                    list="ag-tier-options"
                    value={linkedTier}
                    onChange={(e) => setLinkedTier(e.target.value)}
                    placeholder={t('groups.tierNamePlaceholder')}
                  />
                  <datalist id="ag-tier-options">
                    {tierCatalog.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </div>
                <Button variant="secondary" onClick={() => void saveTierLink()} disabled={busy}>
                  {t('groups.saveTierLink')}
                </Button>
              </div>
              {detail.linkedTierName && (
                <p className="mt-2 text-sm text-brand-700">
                  {t.rich('groups.linkedToTier', {
                    name: detail.linkedTierName,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              )}
            </div>

            {/* Miembros */}
            <div>
              <h3 className="mb-2 font-medium text-text">{t('groups.membersTitle')}</h3>
              <div className="flex gap-2">
                <Input
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                  placeholder={t('groups.memberSearchPlaceholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void searchUsers();
                  }}
                />
                <Button variant="secondary" onClick={() => void searchUsers()}>
                  {t('groups.search')}
                </Button>
              </div>
              {userResults.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {userResults.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <span>
                        {u.name ?? u.email} <span className="text-text-muted">({u.email})</span>
                      </span>
                      <Button variant="ghost" onClick={() => void assignUser(u.id)} disabled={busy}>
                        {t('groups.add')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4">
                <p className="mb-1 text-sm text-text-muted">
                  {t('groups.currentMembers', { count: detail.members.length })}
                </p>
                <div className="flex flex-col gap-1">
                  {detail.members.length === 0 ? (
                    <p className="text-sm text-text-muted">{t('groups.noMembers')}</p>
                  ) : (
                    detail.members.map((m) => (
                      <div
                        key={m.userId}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <UserChip
                            userId={m.userId}
                            name={m.name}
                            email={m.email}
                            showAvatar={false}
                            size={20}
                            nameClassName="block truncate"
                            subtitle={m.name && m.email ? m.email : null}
                          />
                          {m.source === 'TIER' && (
                            <Badge variant="warning">{t('groups.byTier')}</Badge>
                          )}
                          {m.source === 'MEMBERSHIP' && (
                            <Badge variant="info">{t('groups.byMembership')}</Badge>
                          )}
                        </span>
                        <Button
                          variant="ghost"
                          onClick={() => void revokeUser(m.userId)}
                          disabled={busy}
                        >
                          {t('groups.remove')}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                {t('groups.close')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
