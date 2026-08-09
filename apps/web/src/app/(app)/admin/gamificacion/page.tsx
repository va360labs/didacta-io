'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { UserChip } from '@/components/user-chip';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import {
  gamificationAdminApi,
  gamificationApi,
  type ChallengeView,
  type LevelView,
  type PerkRequestView,
  type PerkView,
  type RuleView,
  type SubmissionView,
} from '@/modules/gamification';

/// Panel de mod.gamification (bloque 1). Todo el catálogo lo define el operador:
/// las reglas se siembran con los pesos del ranking anterior, y los NIVELES y
/// los RETOS nacen vacíos a propósito — sus nombres y premios son decisiones de
/// marca, no datos que pueda inventar el sistema.

export default function AdminGamificacionPage() {
  const t = useTranslations('adminEngagement');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">{t('gamification.title')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('gamification.subtitle')}</p>
      </div>

      {error ? (
        <div className="rounded-xl border border-(--didacta-coral)/40 bg-(--didacta-coral)/5 p-4 text-sm text-text">
          {error}
        </div>
      ) : null}

      <Tabs defaultValue="retos">
        <TabsList>
          <TabsTrigger value="retos">{t('gamification.tabChallenges')}</TabsTrigger>
          <TabsTrigger value="entregas">{t('gamification.tabSubmissions')}</TabsTrigger>
          <TabsTrigger value="niveles">{t('gamification.tabLevels')}</TabsTrigger>
          <TabsTrigger value="beneficios">{t('gamification.tabPerks')}</TabsTrigger>
          <TabsTrigger value="solicitudes">{t('gamification.tabRequests')}</TabsTrigger>
          <TabsTrigger value="reglas">{t('gamification.tabRules')}</TabsTrigger>
        </TabsList>

        <TabsContent value="retos">
          <ChallengesPanel onError={setError} />
        </TabsContent>
        <TabsContent value="entregas">
          <SubmissionsPanel onError={setError} />
        </TabsContent>
        <TabsContent value="niveles">
          <LevelsPanel onError={setError} />
        </TabsContent>
        <TabsContent value="beneficios">
          <PerksPanel onError={setError} />
        </TabsContent>
        <TabsContent value="solicitudes">
          <PerkRequestsPanel onError={setError} />
        </TabsContent>
        <TabsContent value="reglas">
          <RulesPanel onError={setError} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Retos ────────────────────────────────────────────────────────────────────

function ChallengesPanel({ onError }: { onError: (m: string | null) => void }) {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [challenges, setChallenges] = useState<ChallengeView[] | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [points, setPoints] = useState('100');
  const [proofRequired, setProofRequired] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setChallenges(await gamificationAdminApi.listChallenges());
  }, []);

  useEffect(() => {
    reload().catch((e) => onError(apiErrorMessage(e, tErrors)));
  }, [reload, onError, tErrors]);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await gamificationAdminApi.createChallenge({
        title,
        description: description.trim() || undefined,
        points: Number(points),
        proofRequired,
      });
      setTitle('');
      setDescription('');
      setPoints('100');
      await reload();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(challenge: ChallengeView, status: ChallengeView['status']) {
    onError(null);
    try {
      await gamificationAdminApi.updateChallenge(challenge.id, { status });
      await reload();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  async function remove(challenge: ChallengeView) {
    onError(null);
    try {
      await gamificationAdminApi.deleteChallenge(challenge.id);
      await reload();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('challenges.newTitle')}</CardTitle>
          <CardDescription>{t('challenges.newDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <div className="space-y-1.5">
              <Label htmlFor="reto-titulo">{t('challenges.titleLabel')}</Label>
              <Input
                id="reto-titulo"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('challenges.titlePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reto-puntos">{t('challenges.pointsLabel')}</Label>
              <Input
                id="reto-puntos"
                type="number"
                min={1}
                value={points}
                onChange={(e) => setPoints(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reto-desc">{t('challenges.descLabel')}</Label>
            <Textarea
              id="reto-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('challenges.descPlaceholder')}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={proofRequired}
              onChange={(e) => setProofRequired(e.target.checked)}
            />
            {t('challenges.proofCheckbox')}
          </label>
          <Button onClick={() => void create()} disabled={busy || title.trim().length < 3}>
            {busy ? t('challenges.creating') : t('challenges.create')}
          </Button>
        </CardContent>
      </Card>

      {challenges === null ? (
        <p className="text-sm text-text-muted">{t('challenges.loading')}</p>
      ) : challenges.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">{t('challenges.emptyTitle')}</p>
            <p className="mt-1 text-sm text-text-muted">{t('challenges.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {challenges.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-text">{c.title}</p>
                    <Badge variant={c.status === 'OPEN' ? 'success' : 'muted'}>
                      {labelOr(t, `challengeStatus.${c.status}`, c.status)}
                    </Badge>
                    <Badge variant="info">
                      {t('challenges.pointsBadge', { points: c.points })}
                    </Badge>
                    {c.proofRequired ? (
                      <Badge variant="muted">{t('challenges.proofBadge')}</Badge>
                    ) : null}
                  </div>
                  {c.description ? (
                    <p className="mt-1 text-sm text-text-muted">{c.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-text-muted">
                    {t('challenges.submissionCount', { count: c.submissionCount ?? 0 })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {c.status !== 'OPEN' ? (
                    <Button size="sm" onClick={() => void setStatus(c, 'OPEN')}>
                      {t('challenges.open')}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => void setStatus(c, 'CLOSED')}>
                      {t('challenges.close')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void remove(c)}>
                    {t('challenges.delete')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Entregas ─────────────────────────────────────────────────────────────────

function SubmissionsPanel({ onError }: { onError: (m: string | null) => void }) {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [submissions, setSubmissions] = useState<SubmissionView[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [soloPendientes, setSoloPendientes] = useState(true);

  // Todas de una vez: revisar una entrega no puede hacerla desaparecer sin
  // dejar rastro de qué se aprobó y qué se rechazó.
  const reload = useCallback(async () => {
    setSubmissions(await gamificationAdminApi.listSubmissions());
  }, []);

  useEffect(() => {
    reload().catch((e) => onError(apiErrorMessage(e, tErrors)));
  }, [reload, onError, tErrors]);

  async function review(submission: SubmissionView, approve: boolean) {
    onError(null);
    try {
      const note = notes[submission.id]?.trim();
      await gamificationAdminApi.review(submission.id, {
        approve,
        ...(note ? { reviewNote: note } : {}),
      });
      await reload();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  const todas = submissions ?? [];
  const pendientes = todas.filter((s) => s.status === 'PENDING');
  const visibles = soloPendientes ? pendientes : todas;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSoloPendientes(true)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            soloPendientes
              ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
              : 'border-border text-text-muted hover:text-text'
          }`}
        >
          {t('submissions.pendingTab')}
          {pendientes.length > 0 ? ` (${pendientes.length})` : ''}
        </button>
        <button
          type="button"
          onClick={() => setSoloPendientes(false)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            !soloPendientes
              ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
              : 'border-border text-text-muted hover:text-text'
          }`}
        >
          {t('submissions.allTab')}
          {todas.length > 0 ? ` (${todas.length})` : ''}
        </button>
      </div>

      {submissions === null ? (
        <p className="text-sm text-text-muted">{t('submissions.loading')}</p>
      ) : visibles.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">
              {soloPendientes ? t('submissions.emptyPendingTitle') : t('submissions.emptyAllTitle')}
            </p>
            <p className="mt-1 text-sm text-text-muted">{t('submissions.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        visibles.map((s) => (
          <Card key={s.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-text">{s.challengeTitle}</p>
                  <div className="flex items-center gap-1.5 text-sm text-text-muted">
                    <UserChip
                      userId={s.userId}
                      name={s.displayName}
                      fallback={t('submissions.studentFallback')}
                      showAvatar={false}
                      size={20}
                      nameClassName="block truncate text-sm text-text-muted"
                    />
                    <span>· {formatDate(s.createdAt)}</span>
                  </div>
                </div>
                {s.status !== 'PENDING' ? (
                  <Badge variant={s.status === 'APPROVED' ? 'success' : 'muted'}>
                    {s.status === 'APPROVED'
                      ? t('submissions.approvedBadge')
                      : t('submissions.rejectedBadge')}
                  </Badge>
                ) : null}
                {s.proofUrl ? (
                  <a
                    href={s.proofUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sm font-medium text-(--didacta-trust) underline"
                  >
                    {t('submissions.viewProof')}
                    {s.proofName ? ` (${s.proofName})` : ''}
                  </a>
                ) : (
                  <span className="text-sm text-text-muted">{t('submissions.noProof')}</span>
                )}
              </div>

              {s.note ? (
                <p className="whitespace-pre-line rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
                  {s.note}
                </p>
              ) : null}

              {s.reviewNote ? (
                <p className="whitespace-pre-line text-sm text-text-muted">
                  <span className="font-medium text-text">{t('submissions.yourComment')}</span>{' '}
                  {s.reviewNote}
                </p>
              ) : null}

              {s.status === 'PENDING' ? (
                <>
                  <Textarea
                    rows={2}
                    placeholder={t('submissions.notePlaceholder')}
                    value={notes[s.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  />

                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void review(s, true)}>
                      {t('submissions.approve')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void review(s, false)}>
                      {t('submissions.reject')}
                    </Button>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ── Niveles ──────────────────────────────────────────────────────────────────

function LevelsPanel({ onError }: { onError: (m: string | null) => void }) {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [levels, setLevels] = useState<LevelView[] | null>(null);
  const [name, setName] = useState('');
  const [minPoints, setMinPoints] = useState('100');
  const [benefitText, setBenefitText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLevels(await gamificationApi.listLevels());
  }, []);

  useEffect(() => {
    load().catch((e) => onError(apiErrorMessage(e, tErrors)));
  }, [load, onError, tErrors]);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await gamificationAdminApi.createLevel({
        key: slugify(name),
        name,
        minPoints: Number(minPoints),
        benefitText: benefitText.trim() || undefined,
      });
      setName('');
      setMinPoints('100');
      setBenefitText('');
      await load();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function remove(level: LevelView) {
    onError(null);
    try {
      await gamificationAdminApi.deleteLevel(level.id);
      await load();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('levels.newTitle')}</CardTitle>
          <CardDescription>{t('levels.newDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <div className="space-y-1.5">
              <Label htmlFor="nivel-nombre">{t('levels.nameLabel')}</Label>
              <Input
                id="nivel-nombre"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('levels.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nivel-puntos">{t('levels.minPointsLabel')}</Label>
              <Input
                id="nivel-puntos"
                type="number"
                min={0}
                value={minPoints}
                onChange={(e) => setMinPoints(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nivel-beneficio">{t('levels.benefitLabel')}</Label>
            <Textarea
              id="nivel-beneficio"
              rows={2}
              value={benefitText}
              onChange={(e) => setBenefitText(e.target.value)}
              placeholder={t('levels.benefitPlaceholder')}
            />
          </div>
          <Button onClick={() => void create()} disabled={busy || name.trim().length < 2}>
            {busy ? t('levels.creating') : t('levels.create')}
          </Button>
        </CardContent>
      </Card>

      {levels === null ? (
        <p className="text-sm text-text-muted">{t('levels.loading')}</p>
      ) : levels.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">{t('levels.emptyTitle')}</p>
            <p className="mt-1 text-sm text-text-muted">{t('levels.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {levels.map((l) => (
            <Card key={l.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <p className="font-semibold text-text">{l.name}</p>
                  <p className="text-xs text-text-muted">
                    {t('levels.fromPoints', { points: l.minPoints })}
                  </p>
                  {l.benefitText ? (
                    <p className="mt-1 text-sm text-text-muted">{l.benefitText}</p>
                  ) : null}
                </div>
                <Button variant="ghost" size="sm" onClick={() => void remove(l)}>
                  {t('levels.delete')}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'nivel'
  );
}

// ── Beneficios ───────────────────────────────────────────────────────────────

function PerksPanel({ onError }: { onError: (m: string | null) => void }) {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [perks, setPerks] = useState<PerkView[] | null>(null);
  const [levels, setLevels] = useState<LevelView[]>([]);
  const [levelId, setLevelId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [maxPerUser, setMaxPerUser] = useState('1');
  const [cooldownDays, setCooldownDays] = useState('0');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, levelList] = await Promise.all([
      gamificationAdminApi.listPerks(),
      gamificationApi.listLevels(),
    ]);
    setPerks(list);
    setLevels(levelList);
    setLevelId((prev) => prev || (levelList[0]?.id ?? ''));
  }, []);

  useEffect(() => {
    load().catch((e) => onError(apiErrorMessage(e, tErrors)));
  }, [load, onError, tErrors]);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await gamificationAdminApi.createPerk({
        levelId,
        title,
        description: description.trim() || undefined,
        maxPerUser: Number(maxPerUser),
        cooldownDays: Number(cooldownDays),
      });
      setTitle('');
      setDescription('');
      await load();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(perk: PerkView) {
    onError(null);
    try {
      await gamificationAdminApi.updatePerk(perk.id, { active: !perk.active });
      await load();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  async function remove(perk: PerkView) {
    onError(null);
    try {
      await gamificationAdminApi.deletePerk(perk.id);
      await load();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  if (levels.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent className="py-10 text-center">
          <p className="font-semibold text-text">{t('perks.needLevelTitle')}</p>
          <p className="mt-1 text-sm text-text-muted">{t('perks.needLevelHint')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('perks.newTitle')}</CardTitle>
          <CardDescription>{t('perks.newDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
            <div className="space-y-1.5">
              <Label htmlFor="perk-titulo">{t('perks.titleLabel')}</Label>
              <Input
                id="perk-titulo"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('perks.titlePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perk-nivel">{t('perks.levelLabel')}</Label>
              <select
                id="perk-nivel"
                value={levelId}
                onChange={(e) => setLevelId(e.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
              >
                {levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {t('perks.levelOption', { name: l.name, points: l.minPoints })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="perk-desc">{t('perks.descLabel')}</Label>
            <Textarea
              id="perk-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('perks.descPlaceholder')}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="perk-max">{t('perks.maxLabel')}</Label>
              <Input
                id="perk-max"
                type="number"
                min={0}
                value={maxPerUser}
                onChange={(e) => setMaxPerUser(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perk-cooldown">{t('perks.cooldownLabel')}</Label>
              <Input
                id="perk-cooldown"
                type="number"
                min={0}
                value={cooldownDays}
                onChange={(e) => setCooldownDays(e.target.value)}
              />
            </div>
          </div>

          <Button onClick={() => void create()} disabled={busy || title.trim().length < 3}>
            {busy ? t('perks.creating') : t('perks.create')}
          </Button>
        </CardContent>
      </Card>

      {perks === null ? (
        <p className="text-sm text-text-muted">{t('perks.loading')}</p>
      ) : perks.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">{t('perks.emptyTitle')}</p>
            <p className="mt-1 text-sm text-text-muted">{t('perks.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {perks.map((perk) => (
            <Card key={perk.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-text">{perk.title}</p>
                    <Badge variant={perk.active ? 'success' : 'muted'}>
                      {perk.active ? t('perks.activeBadge') : t('perks.pausedBadge')}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {perk.levelName} · {t('perks.metaPoints', { points: perk.levelMinPoints })} ·{' '}
                    {perk.maxPerUser === 0
                      ? t('perks.noLimit')
                      : t('perks.perStudent', { count: perk.maxPerUser })}
                    {perk.cooldownDays > 0
                      ? ` · ${t('perks.everyDays', { days: perk.cooldownDays })}`
                      : ''}
                  </p>
                  {perk.description ? (
                    <p className="mt-1 text-sm text-text-muted">{perk.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => void toggle(perk)}>
                    {perk.active ? t('perks.pause') : t('perks.activate')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void remove(perk)}>
                    {t('perks.delete')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Solicitudes de beneficio ─────────────────────────────────────────────────

function PerkRequestsPanel({ onError }: { onError: (m: string | null) => void }) {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [requests, setRequests] = useState<PerkRequestView[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [view, setView] = useState<'PENDING' | 'APPROVED' | 'CLOSED'>('PENDING');

  // Se traen TODAS y se filtran aquí: así los contadores de cada pestaña salen
  // gratis y ninguna solicitud queda invisible.
  const load = useCallback(async () => {
    setRequests(await gamificationAdminApi.listPerkRequests());
  }, []);

  useEffect(() => {
    load().catch((e) => onError(apiErrorMessage(e, tErrors)));
  }, [load, onError, tErrors]);

  async function handle(request: PerkRequestView, status: 'APPROVED' | 'DONE' | 'REJECTED') {
    onError(null);
    try {
      const note = notes[request.id]?.trim();
      await gamificationAdminApi.handlePerkRequest(request.id, {
        status,
        ...(note ? { staffNote: note } : {}),
      });
      await load();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  const all = requests ?? [];
  const porAprobar = all.filter((r) => r.status === 'PENDING');
  const porCumplir = all.filter((r) => r.status === 'APPROVED');
  const cerradas = all.filter((r) => r.status === 'DONE' || r.status === 'REJECTED');
  const visible = view === 'PENDING' ? porAprobar : view === 'APPROVED' ? porCumplir : cerradas;

  const TABS: Array<{ key: typeof view; label: string; count: number }> = [
    { key: 'PENDING', label: t('requests.tabPending'), count: porAprobar.length },
    { key: 'APPROVED', label: t('requests.tabApproved'), count: porCumplir.length },
    { key: 'CLOSED', label: t('requests.tabHistory'), count: cerradas.length },
  ];

  const EMPTY: Record<typeof view, { title: string; hint: string }> = {
    PENDING: {
      title: t('requests.emptyPendingTitle'),
      hint: t('requests.emptyPendingHint'),
    },
    APPROVED: {
      title: t('requests.emptyApprovedTitle'),
      hint: t('requests.emptyApprovedHint'),
    },
    CLOSED: {
      title: t('requests.emptyClosedTitle'),
      hint: t('requests.emptyClosedHint'),
    },
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setView(tab.key)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              view === tab.key
                ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
                : 'border-border text-text-muted hover:text-text'
            }`}
          >
            {tab.label}
            {tab.count > 0 ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>

      {requests === null ? (
        <p className="text-sm text-text-muted">{t('requests.loading')}</p>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">{EMPTY[view].title}</p>
            <p className="mt-1 text-sm text-text-muted">{EMPTY[view].hint}</p>
          </CardContent>
        </Card>
      ) : (
        visible.map((r) => (
          <Card key={r.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-text">{r.perkTitle}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm text-text-muted">
                    <UserChip
                      userId={r.userId}
                      name={r.displayName}
                      fallback={t('requests.studentFallback')}
                      showAvatar={false}
                      size={20}
                      nameClassName="block truncate text-sm text-text-muted"
                    />
                    <span>
                      · {t('requests.requestedOn', { date: formatDate(r.createdAt) })}
                      {r.handledAt
                        ? ` · ${t('requests.respondedOn', { date: formatDate(r.handledAt) })}`
                        : ''}
                    </span>
                  </div>
                </div>
                <Badge
                  variant={
                    r.status === 'DONE'
                      ? 'success'
                      : r.status === 'REJECTED'
                        ? 'muted'
                        : r.status === 'APPROVED'
                          ? 'warning'
                          : 'info'
                  }
                >
                  {labelOr(t, `requestStatus.${r.status}`, r.status)}
                </Badge>
              </div>

              {r.note ? (
                <p className="whitespace-pre-line rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
                  {r.note}
                </p>
              ) : null}

              {r.staffNote ? (
                <p className="whitespace-pre-line text-sm text-text-muted">
                  <span className="font-medium text-text">{t('requests.yourReply')}</span>{' '}
                  {r.staffNote}
                </p>
              ) : null}

              {r.status === 'PENDING' || r.status === 'APPROVED' ? (
                <>
                  <Textarea
                    rows={2}
                    placeholder={t('requests.replyPlaceholder')}
                    value={notes[r.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                  <div className="flex flex-wrap gap-2">
                    {r.status === 'PENDING' ? (
                      <Button size="sm" onClick={() => void handle(r, 'APPROVED')}>
                        {t('requests.approve')}
                      </Button>
                    ) : null}
                    <Button
                      variant={r.status === 'APPROVED' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => void handle(r, 'DONE')}
                    >
                      {t('requests.markDone')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handle(r, 'REJECTED')}>
                      {t('requests.reject')}
                    </Button>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ── Reglas ───────────────────────────────────────────────────────────────────

function RulesPanel({ onError }: { onError: (m: string | null) => void }) {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [backfill, setBackfill] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRules(await gamificationAdminApi.listRules());
  }, []);

  useEffect(() => {
    reload().catch((e) => onError(apiErrorMessage(e, tErrors)));
  }, [reload, onError, tErrors]);

  async function save(rule: RuleView, patch: Partial<RuleView>) {
    onError(null);
    try {
      await gamificationAdminApi.updateRule(rule.key, {
        ...(patch.points !== undefined ? { points: patch.points } : {}),
        ...(patch.dailyCap !== undefined ? { dailyCap: patch.dailyCap } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      await reload();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    }
  }

  async function runBackfill() {
    setBusy(true);
    onError(null);
    setBackfill(null);
    try {
      const summary = await gamificationAdminApi.runBackfill();
      setBackfill(
        t('rules.backfillDone', {
          awarded: summary.awarded,
          posts: summary.posts,
          comments: summary.comments,
          resources: summary.resources,
          courses: summary.courses,
          referrals: summary.referrals,
        }),
      );
      await reload();
    } catch (e) {
      onError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('rules.title')}</CardTitle>
          <CardDescription>{t('rules.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rules === null ? (
            <p className="text-sm text-text-muted">{t('rules.loading')}</p>
          ) : (
            rules.map((rule) => (
              <div
                key={rule.key}
                className="flex flex-wrap items-end gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
              >
                <div className="min-w-[180px] flex-1">
                  <p className="text-sm font-medium text-text">
                    {labelOr(t, `ruleLabels.${rule.key.replace(/\./g, '_')}`, rule.key)}
                  </p>
                  <p className="text-xs text-text-muted">{rule.key}</p>
                </div>
                <div className="w-24 space-y-1">
                  <Label htmlFor={`pts-${rule.key}`} className="text-xs">
                    {t('rules.pointsLabel')}
                  </Label>
                  <Input
                    id={`pts-${rule.key}`}
                    type="number"
                    min={0}
                    defaultValue={rule.points}
                    onBlur={(e) => {
                      const points = Number(e.target.value);
                      if (points !== rule.points) void save(rule, { points });
                    }}
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label htmlFor={`cap-${rule.key}`} className="text-xs">
                    {t('rules.capLabel')}
                  </Label>
                  <Input
                    id={`cap-${rule.key}`}
                    type="number"
                    min={0}
                    defaultValue={rule.dailyCap}
                    onBlur={(e) => {
                      const dailyCap = Number(e.target.value);
                      if (dailyCap !== rule.dailyCap) void save(rule, { dailyCap });
                    }}
                  />
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => void save(rule, { enabled: e.target.checked })}
                  />
                  {t('rules.active')}
                </label>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rules.backfillTitle')}</CardTitle>
          <CardDescription>{t('rules.backfillDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => void runBackfill()} disabled={busy}>
            {busy ? t('rules.backfillRunning') : t('rules.backfillRun')}
          </Button>
          {backfill ? <p className="text-sm text-text-muted">{backfill}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
