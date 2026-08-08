'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  fundaeApi,
  type FundaeAction,
  type FundaeBlock,
  type FundaeParticipant,
  type Modalidad,
} from '@/modules/fundae';

const MODALIDAD_OPTIONS: Modalidad[] = ['PRESENCIAL', 'TELEFORMACION', 'MIXTA'];

export default function FundaeActionDetailPage() {
  const params = useParams<{ id: string }>();
  const actionId = params.id;

  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [action, setAction] = useState<FundaeAction | null>(null);
  const [blocks, setBlocks] = useState<FundaeBlock[] | null>(null);
  const [participants, setParticipants] = useState<FundaeParticipant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zipPending, setZipPending] = useState(false);

  async function reload() {
    try {
      setError(null);
      const [a, list, parts] = await Promise.all([
        fundaeApi.get(actionId),
        fundaeApi.listBlocks(actionId),
        fundaeApi.listParticipants(actionId).catch(() => [] as FundaeParticipant[]),
      ]);
      setAction(a);
      setBlocks(list);
      setParticipants(parts);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function downloadAuthenticated(url: string, filename: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  async function handleDownloadZip() {
    if (!action) return;
    setZipPending(true);
    try {
      await downloadAuthenticated(
        fundaeApi.exportZipUrl(actionId),
        `fundae-${action.codigoAccion}.zip`,
      );
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setZipPending(false);
    }
  }

  async function handleDownloadEvidence(p: FundaeParticipant) {
    try {
      const idLabel = p.documentId ?? p.email.split('@')[0] ?? p.userId;
      await downloadAuthenticated(
        fundaeApi.evidencePdfUrl(actionId, p.userId),
        `evidencia-${idLabel}.pdf`,
      );
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionId]);

  if (error && !action) {
    return (
      <Card>
        <CardContent className="p-6 text-danger-700">{error}</CardContent>
      </Card>
    );
  }

  if (!action || !blocks) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const totalBlockHours = blocks.reduce((acc, b) => acc + b.hours, 0);
  const remaining = action.horasFormacion - totalBlockHours;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted">
            <Link href="/admin/fundae" className="underline">
              {t('actionDetail.breadcrumb')}
            </Link>{' '}
            / {action.codigoAccion}
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">{action.nombre}</h1>
          <div className="mt-2 flex flex-wrap gap-1.5 text-sm text-text-muted">
            <Badge>{action.modalidad}</Badge>
            <span>· {t('actionDetail.hoursTotal', { horas: String(action.horasFormacion) })}</span>
            <span>
              · {action.fechaInicio} → {action.fechaFin}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <a href={fundaeApi.exportXmlUrl(action.id)} target="_blank" rel="noopener noreferrer">
              {t('actionDetail.xml')}
            </a>
          </Button>
          <Button onClick={handleDownloadZip} disabled={zipPending}>
            {zipPending ? t('actionDetail.zipGenerating') : t('actionDetail.zipDownload')}
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('actionDetail.blocksTitle')}</CardTitle>
          <CardDescription>
            {t('actionDetail.blocksDescription', {
              total: String(totalBlockHours),
              max: String(action.horasFormacion),
              estado:
                remaining > 0
                  ? t('actionDetail.blocksRemaining', { remaining: String(remaining) })
                  : t('actionDetail.blocksComplete'),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          {blocks.length === 0 ? (
            <p className="text-sm text-text-muted">{t('actionDetail.blocksEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {blocks.map((b) => (
                <BlockRow
                  key={b.id}
                  actionId={actionId}
                  block={b}
                  onChanged={() => void reload()}
                />
              ))}
            </ul>
          )}

          <CreateBlockForm
            actionId={actionId}
            nextOrdinal={blocks.length === 0 ? 1 : Math.max(...blocks.map((b) => b.ordinal)) + 1}
            onCreated={() => void reload()}
          />
        </CardContent>
      </Card>

      {action.courseId && participants ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('actionDetail.participantsTitle', { count: String(participants.length) })}
            </CardTitle>
            <CardDescription>{t('actionDetail.participantsDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {participants.length === 0 ? (
              <p className="text-sm text-text-muted">{t('actionDetail.participantsEmpty')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {participants.map((p) => (
                  <li key={p.userId} className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text">{p.name ?? p.email}</p>
                      <p className="text-xs text-text-muted">
                        {p.email}
                        {p.documentId ? ` · ${p.documentId}` : ` · ${t('actionDetail.noDni')}`}
                      </p>
                    </div>
                    <Badge
                      variant={
                        p.status === 'APTO'
                          ? 'success'
                          : p.status === 'NO_APTO'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {t(`participantStatus.${p.status}`)}
                    </Badge>
                    <span className="text-xs text-text-muted tabular-nums">
                      {p.progressPercent}%
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDownloadEvidence(p)}
                    >
                      {t('actionDetail.evidencePdf')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function BlockRow({
  actionId,
  block,
  onChanged,
}: {
  actionId: string;
  block: FundaeBlock;
  onChanged: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (!confirm(t('actionDetail.deleteBlockConfirm', { title: block.title }))) return;
    setPending(true);
    try {
      await fundaeApi.deleteBlock(actionId, block.id);
      onChanged();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
      setPending(false);
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-4 p-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 font-display text-sm font-bold">
        {block.ordinal}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text">{block.title}</p>
        <p className="text-xs text-text-muted">
          {t('actionDetail.blockHours', { hours: String(block.hours) })} · {block.modalidad}
        </p>
        {block.contenidos ? (
          <p className="mt-1 whitespace-pre-line text-xs text-text-subtle">{block.contenidos}</p>
        ) : null}
        {error ? <p className="mt-1 text-xs text-danger-700">{error}</p> : null}
      </div>
      <Button variant="ghost" size="sm" onClick={onDelete} disabled={pending}>
        {t('actionDetail.deleteBlock')}
      </Button>
    </li>
  );
}

function CreateBlockForm({
  actionId,
  nextOrdinal,
  onCreated,
}: {
  actionId: string;
  nextOrdinal: number;
  onCreated: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState('');
  const [modalidad, setModalidad] = useState<Modalidad>('TELEFORMACION');
  const [contenidos, setContenidos] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await fundaeApi.createBlock(actionId, {
        ordinal: nextOrdinal,
        title: title.trim(),
        hours: Number(hours),
        modalidad,
        contenidos: contenidos.trim() || undefined,
      });
      setTitle('');
      setHours('');
      setContenidos('');
      onCreated();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-lg border border-dashed border-border bg-surface p-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {t('actionDetail.newBlockTitle', { ordinal: String(nextOrdinal) })}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="block-title">{t('actionDetail.blockTitleLabel')}</Label>
          <Input
            id="block-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="block-hours">{t('actionDetail.blockHoursLabel')}</Label>
          <Input
            id="block-hours"
            type="number"
            step="0.5"
            min="0.5"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            required
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="block-modalidad">{t('actionDetail.blockModalidadLabel')}</Label>
        <Select
          id="block-modalidad"
          value={modalidad}
          onChange={(e) => setModalidad(e.target.value as Modalidad)}
        >
          {MODALIDAD_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="block-contenidos">{t('actionDetail.blockContentsLabel')}</Label>
        <Textarea
          id="block-contenidos"
          value={contenidos}
          onChange={(e) => setContenidos(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder={t('actionDetail.blockContentsPlaceholder')}
        />
      </div>
      {error ? <p className="text-sm text-danger-700">{error}</p> : null}
      <Button type="submit" disabled={pending || !title.trim() || !hours}>
        {pending ? t('shared.creating') : t('actionDetail.addBlock')}
      </Button>
    </form>
  );
}
