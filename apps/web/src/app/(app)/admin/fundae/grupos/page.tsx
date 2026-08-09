'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import {
  fundaeGroupParticipantsApi,
  fundaeGroupsApi,
  formatCents,
  type CreateCostInput,
  type CreateGroupInput,
  type FundaeCost,
  type FundaeGroup,
  type FundaeGroupParticipant,
  type GroupCompletionResult,
  type GroupStatus,
  type Modalidad,
} from '@/modules/fundae';

const STATUS_VARIANT: Record<GroupStatus, 'info' | 'success' | 'muted' | 'warning'> = {
  DRAFT: 'muted',
  ACTIVE: 'success',
  CLOSED: 'info',
  CANCELLED: 'warning',
};

/**
 * Vista admin de grupos bonificables Fundae (LMS-81).
 * Lista filtrable + alta + transiciones de estado + costes.
 */
export default function FundaeGruposPage() {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [groups, setGroups] = useState<FundaeGroup[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<GroupStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<{
    group: FundaeGroup;
    costs: FundaeCost[];
    participants: FundaeGroupParticipant[];
  } | null>(null);

  async function reload() {
    try {
      setError(null);
      const list = await fundaeGroupsApi.list({
        status: statusFilter !== '' ? (statusFilter as GroupStatus) : undefined,
      });
      setGroups(list);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function openDetail(g: FundaeGroup) {
    try {
      const [group, costs, participants] = await Promise.all([
        fundaeGroupsApi.get(g.id),
        fundaeGroupsApi.listCosts(g.id),
        fundaeGroupParticipantsApi.list(g.id),
      ]);
      setDetail({ group, costs, participants });
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function handleTransition(id: string, action: 'start' | 'close' | 'cancel') {
    if (!confirm(t('groups.transitionConfirm', { verb: t(`transitionVerb.${action}`) }))) return;
    try {
      await fundaeGroupsApi[action](id);
      await reload();
      if (detail?.group.id === id) {
        const [group, costs, participants] = await Promise.all([
          fundaeGroupsApi.get(id),
          fundaeGroupsApi.listCosts(id),
          fundaeGroupParticipantsApi.list(id),
        ]);
        setDetail({ group, costs, participants });
      }
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function handleRemoveCost(groupId: string, costId: string) {
    if (!confirm(t('groups.deleteCostConfirm'))) return;
    try {
      await fundaeGroupsApi.removeCost(groupId, costId);
      const costs = await fundaeGroupsApi.listCosts(groupId);
      setDetail((prev) => (prev ? { ...prev, costs } : prev));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('groups.title')}</h1>
          <p className="mt-1 max-w-3xl text-text-muted">{t('groups.description')}</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setDetail(null);
            setShowForm((v) => !v);
          }}
        >
          <Icon name="plus" size={16} />
          {showForm ? t('shared.close') : t('groups.newGroup')}
        </Button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="statusFilter">{t('groups.statusFilterLabel')}</Label>
          <select
            id="statusFilter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as GroupStatus | '')}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">{t('groups.statusAll')}</option>
            {(['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`groupStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="secondary" onClick={() => void reload()}>
          <Icon name="arrow-right" size={14} />
          {t('groups.refresh')}
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <GroupForm
          onSaved={async (g) => {
            setShowForm(false);
            await reload();
            await openDetail(g);
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {detail ? (
        <GroupDetail
          group={detail.group}
          costs={detail.costs}
          participants={detail.participants}
          onTransition={(action) => void handleTransition(detail.group.id, action)}
          onRemoveCost={(costId) => void handleRemoveCost(detail.group.id, costId)}
          onCostAdded={async () => {
            const costs = await fundaeGroupsApi.listCosts(detail.group.id);
            setDetail((prev) => (prev ? { ...prev, costs } : prev));
          }}
          onParticipantsChanged={async () => {
            const participants = await fundaeGroupParticipantsApi.list(detail.group.id);
            setDetail((prev) => (prev ? { ...prev, participants } : prev));
          }}
          onClose={() => setDetail(null)}
        />
      ) : null}

      {groups === null ? (
        <div className="space-y-3">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">{t('groups.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('groups.emptyDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <Card key={g.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-text">
                      {t('groups.groupNumber', { numero: String(g.numeroGrupo) })}
                    </span>
                    <Badge variant={STATUS_VARIANT[g.status]}>
                      {labelOr(t, `groupStatus.${g.status}`, g.status)}
                    </Badge>
                    <Badge variant="muted">
                      {labelOr(t, `modalidad.${g.modalidad}`, g.modalidad)}
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted">
                    {formatDate(g.fechaInicioPrevista)} → {formatDate(g.fechaFinPrevista)}
                  </p>
                  <p className="text-sm tabular-nums text-text-muted">
                    {t('groups.creditRow', {
                      estimado: formatCents(g.creditoEstimadoCents),
                      consumido: formatCents(g.creditoConsumidoCents),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void openDetail(g)}
                  >
                    <Icon name="eye" size={13} />
                    {t('groups.viewDetail')}
                  </Button>
                  {g.status === 'DRAFT' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTransition(g.id, 'start')}
                    >
                      <Icon name="play" size={13} />
                      {t('groups.start')}
                    </Button>
                  ) : null}
                  {g.status === 'ACTIVE' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTransition(g.id, 'close')}
                    >
                      <Icon name="check" size={13} />
                      {t('groups.close')}
                    </Button>
                  ) : null}
                  {g.status === 'DRAFT' || g.status === 'ACTIVE' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTransition(g.id, 'cancel')}
                    >
                      <Icon name="alert" size={13} />
                      {t('groups.cancel')}
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

// ──────────────────── FORMULARIO ALTA ────────────────────

function GroupForm({
  onSaved,
  onCancel,
}: {
  onSaved: (g: FundaeGroup) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      const creditoEur = Number(form.get('creditoEur') ?? 0);
      const dto: CreateGroupInput = {
        actionId: form.get('actionId')?.toString().trim() ?? '',
        companyId: form.get('companyId')?.toString().trim() ?? '',
        modalidad: (form.get('modalidad')?.toString() ?? 'PRESENCIAL') as Modalidad,
        fechaInicioPrevista: new Date(
          form.get('fechaInicioPrevista')?.toString() ?? '',
        ).toISOString(),
        fechaFinPrevista: new Date(form.get('fechaFinPrevista')?.toString() ?? '').toISOString(),
        creditoEstimadoCents: creditoEur > 0 ? Math.round(creditoEur * 100) : undefined,
        notas: form.get('notas')?.toString() || undefined,
      };
      const created = await fundaeGroupsApi.create(dto);
      await onSaved(created);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('groups.formTitle')}</CardTitle>
        <CardDescription>{t('groups.formDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="actionId">
                {t('groups.actionIdLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="actionId"
                name="actionId"
                required
                placeholder={t('groups.actionIdPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="companyId">
                {t('groups.companyIdLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="companyId"
                name="companyId"
                required
                placeholder={t('groups.companyIdPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="modalidad">{t('groups.modalidadLabel')}</Label>
              <select
                id="modalidad"
                name="modalidad"
                defaultValue="PRESENCIAL"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {(['PRESENCIAL', 'TELEFORMACION', 'MIXTA'] as const).map((m) => (
                  <option key={m} value={m}>
                    {t(`modalidad.${m}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaInicioPrevista">
                {t('groups.startDateLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaInicioPrevista" name="fechaInicioPrevista" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaFinPrevista">
                {t('groups.endDateLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaFinPrevista" name="fechaFinPrevista" type="date" required />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="creditoEur">{t('groups.creditLabel')}</Label>
              <Input
                id="creditoEur"
                name="creditoEur"
                type="number"
                step="0.01"
                min={0}
                placeholder={t('groups.creditPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notas">{t('groups.notesLabel')}</Label>
              <Textarea id="notas" name="notas" rows={2} maxLength={2000} />
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
              {pending ? t('shared.creating') : t('groups.createGroup')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              {t('shared.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ──────────────────── PANEL DETALLE ────────────────────

function GroupDetail({
  group,
  costs,
  participants,
  onTransition,
  onRemoveCost,
  onCostAdded,
  onParticipantsChanged,
  onClose,
}: {
  group: FundaeGroup;
  costs: FundaeCost[];
  participants: FundaeGroupParticipant[];
  onTransition: (action: 'start' | 'close' | 'cancel') => void;
  onRemoveCost: (costId: string) => void;
  onCostAdded: () => Promise<void>;
  onParticipantsChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const isEditable = group.status === 'DRAFT' || group.status === 'ACTIVE';
  const [showCostForm, setShowCostForm] = useState(false);
  const [enrollUserId, setEnrollUserId] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [completionResult, setCompletionResult] = useState<GroupCompletionResult | null>(null);

  async function handleBulkEnroll() {
    if (!confirm(t('groups.bulkEnrollConfirm'))) return;
    setParticipantError(null);
    try {
      const res = await fundaeGroupParticipantsApi.bulkEnroll(group.id);
      alert(
        t('groups.bulkEnrollResult', {
          enrolled: res.enrolled,
          skipped: res.skipped,
        }),
      );
      await onParticipantsChanged();
    } catch (e) {
      setParticipantError(apiErrorMessage(e, tErrors));
    }
  }

  async function handleEnroll(e: FormEvent) {
    e.preventDefault();
    if (!enrollUserId) return;
    setEnrolling(true);
    setParticipantError(null);
    try {
      await fundaeGroupParticipantsApi.enroll(group.id, { userId: enrollUserId });
      setEnrollUserId('');
      await onParticipantsChanged();
    } catch (e) {
      setParticipantError(apiErrorMessage(e, tErrors));
    } finally {
      setEnrolling(false);
    }
  }

  async function handleRemoveParticipant(participantId: string) {
    if (!confirm(t('groups.removeParticipantConfirm'))) return;
    setParticipantError(null);
    try {
      await fundaeGroupParticipantsApi.remove(group.id, participantId);
      await onParticipantsChanged();
    } catch (e) {
      setParticipantError(apiErrorMessage(e, tErrors));
    }
  }

  async function handleComputeCompletion(preview: boolean) {
    try {
      const res = await fundaeGroupsApi.finalize(group.id, { preview });
      setCompletionResult(res);
      if (!preview) {
        await onParticipantsChanged();
      }
    } catch (e) {
      alert(apiErrorMessage(e, tErrors));
    }
  }

  async function handleDownloadAuditZip() {
    try {
      const blob = await fundaeGroupsApi.auditZip(group.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fundae-grupo-${group.numeroGrupo}-auditoria.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(apiErrorMessage(e, tErrors));
    }
  }

  async function handleDownloadXml(kind: 'start' | 'end') {
    try {
      const xml =
        kind === 'start'
          ? await fundaeGroupsApi.startXml(group.id)
          : await fundaeGroupsApi.endXml(group.id);
      const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fundae-grupo-${group.numeroGrupo}-${kind === 'start' ? 'inicio' : 'fin'}.xml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(apiErrorMessage(e, tErrors));
    }
  }

  return (
    <Card className="border-l-4 border-l-primary">
      <CardHeader className="flex flex-row items-start justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {t('groups.groupNumber', { numero: String(group.numeroGrupo) })}
            <Badge variant={STATUS_VARIANT[group.status]}>
              {labelOr(t, `groupStatus.${group.status}`, group.status)}
            </Badge>
          </CardTitle>
          <CardDescription>
            {labelOr(t, `modalidad.${group.modalidad}`, group.modalidad)} ·{' '}
            {formatDate(group.fechaInicioPrevista)} → {formatDate(group.fechaFinPrevista)}
          </CardDescription>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          <Icon name="alert" size={14} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <span className="text-text-muted">{t('groups.creditEstimatedLabel')}</span>{' '}
            <span className="font-semibold">{formatCents(group.creditoEstimadoCents)}</span>
          </div>
          <div>
            <span className="text-text-muted">{t('groups.consumedLabel')}</span>{' '}
            <span className="font-semibold">{formatCents(group.creditoConsumidoCents)}</span>
          </div>
          <div>
            <span className="text-text-muted">{t('groups.tipoBreakdownLabel')}</span>{' '}
            <span className="font-mono text-xs">
              {formatCents(group.costsByTipo.DIRECTO)} / {formatCents(group.costsByTipo.INDIRECTO)}{' '}
              / {formatCents(group.costsByTipo.ORGANIZACION)}
            </span>
          </div>
        </div>

        {isEditable ? (
          <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
            {group.status === 'DRAFT' ? (
              <Button type="button" size="sm" onClick={() => onTransition('start')}>
                <Icon name="play" size={13} />
                {t('groups.startGroup')}
              </Button>
            ) : null}
            {group.status === 'ACTIVE' ? (
              <Button type="button" size="sm" onClick={() => onTransition('close')}>
                <Icon name="check" size={13} />
                {t('groups.closeGroup')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onTransition('cancel')}
            >
              <Icon name="alert" size={13} />
              {t('groups.cancelGroup')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void handleDownloadXml('start')}
            >
              <Icon name="file" size={13} />
              {t('groups.xmlStart')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void handleDownloadXml('end')}
            >
              <Icon name="file" size={13} />
              {t('groups.xmlEnd')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void handleDownloadAuditZip()}
            >
              <Icon name="package" size={13} />
              {t('groups.auditZip')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void handleComputeCompletion(true)}
            >
              <Icon name="chart" size={13} />
              {t('groups.completionPreviewBtn')}
            </Button>
            {group.status === 'CLOSED' || group.status === 'ACTIVE' ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void handleComputeCompletion(false)}
              >
                <Icon name="check" size={13} />
                {t('groups.completionPersistBtn')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {completionResult ? (
          <div className="rounded-lg border border-border-soft bg-surface-soft p-3 text-xs">
            <div className="mb-2 flex items-center gap-2">
              <h5 className="text-sm font-semibold">
                {t('groups.completionTitle', {
                  estado: completionResult.preview
                    ? t('groups.completionPreview')
                    : t('groups.completionPersisted'),
                })}
              </h5>
              <Badge variant="info">
                {t('groups.thresholdBadge', {
                  pct: completionResult.umbralAplicadoPct,
                })}
              </Badge>
              <Badge variant="success">
                {t('groups.aptoCount', { count: completionResult.aptos })}
              </Badge>
              <Badge variant="warning">
                {t('groups.noAptoCount', { count: completionResult.noAptos })}
              </Badge>
              <Badge variant="muted">
                {t('groups.enCursoCount', { count: completionResult.enCurso })}
              </Badge>
              <button
                type="button"
                onClick={() => setCompletionResult(null)}
                className="ml-auto text-text-muted hover:text-text"
              >
                {t('groups.closeCompletion')}
              </button>
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-left text-text-subtle">
                  <th className="pb-1 font-medium">{t('groups.colAlumno')}</th>
                  <th className="pb-1 text-right font-medium">{t('groups.colProgreso')}</th>
                  <th className="pb-1 text-right font-medium">{t('groups.colHoras')}</th>
                  <th className="pb-1 text-right font-medium">{t('groups.colResultado')}</th>
                </tr>
              </thead>
              <tbody>
                {completionResult.participants.map((p) => (
                  <tr key={p.participantId} className="border-t border-border-soft">
                    <td className="py-1 pr-2">{p.userName ?? p.userEmail ?? p.userId}</td>
                    <td className="py-1 text-right tabular-nums">{p.progressPercent}%</td>
                    <td className="py-1 text-right tabular-nums">
                      {t('groups.hoursShort', { hours: p.horasAsistidas })}
                    </td>
                    <td className="py-1 text-right">
                      <Badge
                        variant={
                          p.resultado === 'APTO'
                            ? 'success'
                            : p.resultado === 'NO_APTO'
                              ? 'warning'
                              : 'muted'
                        }
                      >
                        {p.resultado}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-border-soft pt-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">{t('groups.costsTitle')}</h4>
            {isEditable ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowCostForm((v) => !v)}
              >
                <Icon name="plus" size={13} />
                {t('groups.addCost')}
              </Button>
            ) : null}
          </div>

          {showCostForm ? (
            <CostForm
              groupId={group.id}
              onSaved={async () => {
                setShowCostForm(false);
                await onCostAdded();
              }}
              onCancel={() => setShowCostForm(false)}
            />
          ) : null}

          {costs.length === 0 ? (
            <p className="text-xs text-text-muted">{t('groups.costsEmpty')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-subtle">
                  <th className="pb-1 font-medium">{t('groups.colTipo')}</th>
                  <th className="pb-1 font-medium">{t('groups.colConcepto')}</th>
                  <th className="pb-1 text-right font-medium">{t('groups.colImporte')}</th>
                  {isEditable ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="border-t border-border-soft">
                    <td className="py-1 pr-2">
                      <Badge variant="muted">{labelOr(t, `costTipo.${c.tipo}`, c.tipo)}</Badge>
                    </td>
                    <td className="py-1 pr-2">{c.concepto}</td>
                    <td className="py-1 text-right tabular-nums font-semibold">
                      {formatCents(c.amountCents)}
                    </td>
                    {isEditable ? (
                      <td className="py-1 pl-2">
                        <button
                          type="button"
                          onClick={() => onRemoveCost(c.id)}
                          className="text-danger-600 hover:text-danger-800"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-2 border-t border-border-soft pt-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">
              {t('groups.participantsTitle', {
                count: participants.filter((p) => p.status === 'ENROLLED').length,
              })}
            </h4>
            {isEditable ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void handleBulkEnroll()}
              >
                <Icon name="users" size={13} />
                {t('groups.bulkEnroll')}
              </Button>
            ) : null}
          </div>

          {isEditable ? (
            <form onSubmit={handleEnroll} className="flex gap-2">
              <Input
                value={enrollUserId}
                onChange={(e) => setEnrollUserId(e.target.value)}
                placeholder={t('groups.enrollPlaceholder')}
                className="h-8 font-mono text-xs"
                required
              />
              <Button type="submit" size="sm" disabled={enrolling || !enrollUserId}>
                {enrolling ? '…' : t('groups.enroll')}
              </Button>
            </form>
          ) : null}

          {participantError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700"
            >
              {participantError}
            </div>
          ) : null}

          {participants.length === 0 ? (
            <p className="text-xs text-text-muted">{t('groups.participantsEmpty')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-subtle">
                  <th className="pb-1 font-medium">{t('groups.colAlumno')}</th>
                  <th className="pb-1 font-medium">{t('groups.colNif')}</th>
                  <th className="pb-1 font-medium">{t('groups.colEstado')}</th>
                  {isEditable ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {participants.map((p) => (
                  <tr key={p.id} className="border-t border-border-soft">
                    <td className="py-1 pr-2">
                      <div className="font-medium">{p.userName ?? '—'}</div>
                      <div className="text-text-subtle">{p.userEmail ?? '—'}</div>
                    </td>
                    <td className="py-1 pr-2 font-mono">{p.nifAlumno ?? '—'}</td>
                    <td className="py-1 pr-2">
                      <Badge variant={p.status === 'ENROLLED' ? 'success' : 'muted'}>
                        {labelOr(t, `enrollmentStatus.${p.status}`, p.status)}
                      </Badge>
                    </td>
                    {isEditable && p.status === 'ENROLLED' ? (
                      <td className="py-1 pl-2">
                        <button
                          type="button"
                          onClick={() => void handleRemoveParticipant(p.id)}
                          className="text-danger-600 hover:text-danger-800"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    ) : (
                      <td />
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────── FORMULARIO COSTE ────────────────────

function CostForm({
  groupId,
  onSaved,
  onCancel,
}: {
  groupId: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      const importeEur = Number(form.get('importeEur') ?? 0);
      const dto: CreateCostInput = {
        tipo: (form.get('tipo')?.toString() ?? 'DIRECTO') as CreateCostInput['tipo'],
        concepto: form.get('concepto')?.toString().trim() ?? '',
        amountCents: Math.round(importeEur * 100),
        notas: form.get('notas')?.toString() || undefined,
      };
      await fundaeGroupsApi.addCost(groupId, dto);
      await onSaved();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border-soft p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="tipo" className="text-xs">
            {t('groups.costTipoLabel')}
          </Label>
          <select
            id="tipo"
            name="tipo"
            defaultValue="DIRECTO"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {(['DIRECTO', 'INDIRECTO', 'ORGANIZACION'] as const).map((tipo) => (
              <option key={tipo} value={tipo}>
                {t(`costTipo.${tipo}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="concepto" className="text-xs">
            {t('groups.costConceptoLabel')} <span className="text-danger-700">*</span>
          </Label>
          <Input id="concepto" name="concepto" required maxLength={200} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="importeEur" className="text-xs">
            {t('groups.costImporteLabel')} <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="importeEur"
            name="importeEur"
            type="number"
            step="0.01"
            min={0}
            required
            className="h-8 text-xs"
          />
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('groups.adding') : t('groups.add')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t('shared.cancel')}
        </Button>
      </div>
    </form>
  );
}
