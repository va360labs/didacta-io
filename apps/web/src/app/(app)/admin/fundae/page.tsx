'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { fundaeApi, type ActionStatus, type FundaeAction, type Modalidad } from '@/modules/fundae';

const STATUS_VARIANT: Record<ActionStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  ACTIVE: 'success',
  DRAFT: 'warning',
  CLOSED: 'muted',
  ARCHIVED: 'muted',
};

export default function FundaePage() {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [actions, setActions] = useState<FundaeAction[] | null>(null);
  // Por acción: número si la API contestó OK, 'error' si falló, undefined si
  // todavía no se resolvió. Permite distinguir "0 participantes reales" de
  // "no pudimos consultar" en el badge.
  const [participantCounts, setParticipantCounts] = useState<Record<string, number | 'error'>>({});
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    try {
      setError(null);
      const list = await fundaeApi.list();
      setActions(list);
      const withCourse = list.filter((a) => a.courseId);
      const entries = await Promise.all(
        withCourse.map(async (a) => {
          try {
            const { total } = await fundaeApi.countParticipants(a.id);
            return [a.id, total] as const;
          } catch {
            return [a.id, 'error' as const] as const;
          }
        }),
      );
      setParticipantCounts(Object.fromEntries(entries));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleArchive(id: string, codigo: string) {
    if (!confirm(t('actions.archiveConfirm', { codigo }))) return;
    try {
      await fundaeApi.archive(id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function handleExport(action: FundaeAction) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(fundaeApi.exportXmlUrl(action.id), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fundae-${action.codigoAccion}.xml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('actions.title')}</h1>
          <p className="mt-1 max-w-3xl text-text-muted">{t('actions.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild type="button" variant="secondary">
            <Link href="/admin/fundae/grupos">
              <Icon name="users" size={14} />
              {t('actions.groupsLink')}
            </Link>
          </Button>
          <Button asChild type="button" variant="secondary">
            <Link href="/admin/fundae/empresas">
              <Icon name="building" size={14} />
              {t('actions.companiesLink')}
            </Link>
          </Button>
          <Button type="button" onClick={() => setShowForm((v) => !v)}>
            <Icon name="plus" size={16} />
            {showForm ? t('shared.close') : t('actions.newAction')}
          </Button>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <CreateActionForm
          onCreated={async () => {
            setShowForm(false);
            await reload();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {actions === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : actions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="file" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">{t('actions.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('actions.emptyDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {actions.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <span
                  aria-hidden="true"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
                  style={{
                    background: 'var(--didacta-info-bg)',
                    color: 'var(--didacta-info-fg)',
                  }}
                >
                  <Icon name="file" size={22} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-semibold text-text">
                      {a.codigoAccion}
                    </code>
                    <Badge variant={STATUS_VARIANT[a.status]} dot>
                      {t(`actionStatus.${a.status}`)}
                    </Badge>
                    <Badge variant="muted">{t(`modalidad.${a.modalidad}`)}</Badge>
                    {a.courseId ? (
                      participantCounts[a.id] === 'error' ? (
                        <Badge variant="warning" title={t('actions.participantsErrorTitle')}>
                          <Icon name="users" size={12} />
                          {t('actions.participantsUnknown')}
                        </Badge>
                      ) : (
                        <Badge variant="info">
                          <Icon name="users" size={12} />
                          {t('actions.participantsCount', {
                            count: String(participantCounts[a.id] ?? '…'),
                          })}
                        </Badge>
                      )
                    ) : null}
                  </div>
                  <p className="font-display text-base font-semibold leading-tight text-text">
                    {a.nombre}
                  </p>
                  <p className="text-sm tabular-nums text-text-muted">
                    {t('actions.meta', {
                      inicio: a.fechaInicio,
                      fin: a.fechaFin,
                      horas: String(a.horasFormacion),
                    })}
                    {a.lugar ? ` · ${a.lugar}` : ''}
                  </p>
                  {a.notas ? (
                    <p className="line-clamp-2 text-xs text-text-subtle">{a.notas}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/admin/fundae/${a.id}` as never}>{t('actions.viewBlocks')}</Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => handleExport(a)}
                  >
                    <Icon name="file" size={13} />
                    {t('actions.downloadXml')}
                  </Button>
                  {a.status !== 'ARCHIVED' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleArchive(a.id, a.codigoAccion)}
                    >
                      <Icon name="trash" size={13} />
                      {t('actions.archive')}
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

function CreateActionForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => Promise<void>;
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
      await fundaeApi.create({
        codigoAccion: String(form.get('codigoAccion') ?? '').trim(),
        nombre: String(form.get('nombre') ?? '').trim(),
        modalidad: form.get('modalidad') as Modalidad,
        horasFormacion: Number(form.get('horasFormacion') ?? 0),
        fechaInicio: String(form.get('fechaInicio') ?? ''),
        fechaFin: String(form.get('fechaFin') ?? ''),
        lugar: form.get('lugar') ? String(form.get('lugar')) : undefined,
        cifCentro: form.get('cifCentro') ? String(form.get('cifCentro')) : undefined,
        notas: form.get('notas') ? String(form.get('notas')) : undefined,
        courseId: form.get('courseId') ? String(form.get('courseId')) : undefined,
      });
      await onCreated();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="plus" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle>{t('actions.formTitle')}</CardTitle>
            <CardDescription>{t('actions.formDescription')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="codigoAccion">
                {t('actions.codeLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="codigoAccion"
                name="codigoAccion"
                required
                maxLength={25}
                placeholder={t('actions.codePlaceholder')}
                className="font-mono"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="modalidad">
                {t('actions.modalidadLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Select id="modalidad" name="modalidad" required defaultValue="TELEFORMACION">
                <option value="PRESENCIAL">{t('modalidad.PRESENCIAL')}</option>
                <option value="TELEFORMACION">{t('modalidad.TELEFORMACION')}</option>
                <option value="MIXTA">{t('modalidad.MIXTA')}</option>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nombre">
              {t('actions.nameLabel')} <span className="text-danger-700">*</span>
            </Label>
            <Input id="nombre" name="nombre" required maxLength={200} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="fechaInicio">
                {t('actions.startDateLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaInicio" name="fechaInicio" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaFin">
                {t('actions.endDateLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaFin" name="fechaFin" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="horasFormacion">
                {t('actions.hoursLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="horasFormacion"
                name="horasFormacion"
                type="number"
                step="0.5"
                min={0.5}
                max={9999}
                required
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lugar">{t('actions.placeLabel')}</Label>
              <Input
                id="lugar"
                name="lugar"
                maxLength={200}
                placeholder={t('actions.placePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cifCentro">{t('actions.cifLabel')}</Label>
              <Input id="cifCentro" name="cifCentro" maxLength={20} className="font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="courseId">{t('actions.courseIdLabel')}</Label>
            <Input id="courseId" name="courseId" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notas">{t('actions.notesLabel')}</Label>
            <Textarea id="notas" name="notas" rows={2} maxLength={2000} />
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
              {pending ? t('shared.creating') : t('actions.create')}
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
