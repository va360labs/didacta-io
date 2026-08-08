'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import {
  fundaeCompaniesApi,
  fundaeRlptApi,
  fileToBase64,
  formatCents,
  type FundaeCompany,
  type RlptNotice,
  type RlptNoticeType,
  type UploadRlptInput,
} from '@/modules/fundae';

const TIPO_VARIANT: Record<RlptNoticeType, 'success' | 'warning' | 'info'> = {
  NOTIFICACION_INICIAL: 'info',
  ACUSE_RECIBO: 'success',
  ACTA_DISCREPANCIA: 'warning',
};

const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

const NOTICE_DATE_FORMAT = { day: '2-digit', month: 'short', year: 'numeric' } as const;

export default function FundaeEmpresaDetailPage() {
  const params = useParams<{ id: string }>();
  const companyId = params?.id;
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [company, setCompany] = useState<FundaeCompany | null>(null);
  const [notices, setNotices] = useState<RlptNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!companyId) return;
    setError(null);
    try {
      const [c, n] = await Promise.all([
        fundaeCompaniesApi.get(companyId),
        fundaeRlptApi.list(companyId),
      ]);
      setCompany(c);
      setNotices(n);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function handleDelete(notice: RlptNotice) {
    if (
      !confirm(
        t('companyDetail.rlptDeleteConfirm', {
          tipo: t(`rlptTipo.${notice.tipo}`).toLowerCase(),
          fecha: formatDate(notice.fechaNotificacionAt, NOTICE_DATE_FORMAT),
        }),
      )
    ) {
      return;
    }
    try {
      await fundaeRlptApi.remove(notice.companyId, notice.id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  if (!companyId) return null;

  return (
    <section className="space-y-6">
      <nav className="text-sm text-text-muted">
        <Link href="/admin/fundae/empresas" className="hover:underline">
          {t('companyDetail.back')}
        </Link>
      </nav>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {company === null ? (
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-48 w-full" />
        </div>
      ) : (
        <>
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm font-semibold text-text">{company.nif}</code>
              {company.deletedAt ? (
                <Badge variant="muted">{t('companies.deletedBadge')}</Badge>
              ) : null}
              {company.cccPrincipal ? (
                <Badge variant="info">
                  {t('companies.cccBadge', { ccc: company.cccPrincipal })}
                </Badge>
              ) : null}
              {company.plantilla !== null ? (
                <Badge variant="muted">
                  {t('companies.employeesBadge', { count: String(company.plantilla) })}
                </Badge>
              ) : null}
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {company.razonSocial}
            </h1>
            <p className="text-sm tabular-nums text-text-muted">
              {t('companies.creditSummary', {
                total: formatCents(company.creditoTotalCents),
                used: formatCents(company.creditoUsadoCents),
              })}
              {company.creditoDisponibleCents !== null ? (
                <>
                  {' · '}
                  <span className="font-semibold text-text">
                    {t('companies.creditAvailable', {
                      available: formatCents(company.creditoDisponibleCents),
                    })}
                  </span>
                </>
              ) : null}
            </p>
          </header>

          <RlptSection
            companyId={company.id}
            notices={notices}
            onUploaded={reload}
            onDelete={handleDelete}
          />
        </>
      )}
    </section>
  );
}

function RlptSection({
  companyId,
  notices,
  onUploaded,
  onDelete,
}: {
  companyId: string;
  notices: RlptNotice[] | null;
  onUploaded: () => Promise<void>;
  onDelete: (n: RlptNotice) => void;
}) {
  const t = useTranslations('adminFundae');
  const [showForm, setShowForm] = useState(false);
  const hasNotificacionInicial = notices?.some((n) => n.tipo === 'NOTIFICACION_INICIAL') ?? false;
  const hasActaDiscrepancia = notices?.some((n) => n.tipo === 'ACTA_DISCREPANCIA') ?? false;
  const initialPlazoCumplido =
    notices?.some(
      (n) =>
        n.tipo === 'NOTIFICACION_INICIAL' && new Date(n.plazoVencimientoAt).getTime() <= Date.now(),
    ) ?? false;
  const grupoPodriaIniciarse =
    hasActaDiscrepancia || (hasNotificacionInicial && initialPlazoCumplido);

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold">{t('companyDetail.rlptTitle')}</h2>
          <p className="mt-1 max-w-3xl text-text-muted">
            {t.rich('companyDetail.rlptDescription', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </div>
        <Button type="button" onClick={() => setShowForm((v) => !v)}>
          <Icon name="plus" size={16} />
          {showForm ? t('shared.close') : t('companyDetail.uploadDocument')}
        </Button>
      </header>

      <div
        role="status"
        className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
          grupoPodriaIniciarse
            ? 'border-success-100 bg-success-50 text-success-700'
            : 'border-warning-100 bg-warning-50 text-warning-700'
        }`}
      >
        <Icon name={grupoPodriaIniciarse ? 'check' : 'alert'} size={16} />
        {grupoPodriaIniciarse
          ? t('companyDetail.statusOk')
          : !hasNotificacionInicial
            ? t('companyDetail.statusMissingInitial')
            : t('companyDetail.statusWaiting')}
      </div>

      {showForm ? (
        <UploadForm
          companyId={companyId}
          onUploaded={async () => {
            setShowForm(false);
            await onUploaded();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {notices === null ? (
        <div className="skeleton h-24 w-full" />
      ) : notices.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-text-muted">
            {t('companyDetail.noticesEmpty')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {notices.map((n) => (
            <Card key={n.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={TIPO_VARIANT[n.tipo]}>{t(`rlptTipo.${n.tipo}`)}</Badge>
                    <span className="text-sm tabular-nums text-text-muted">
                      {t('companyDetail.noticeDates', {
                        fecha: formatDate(n.fechaNotificacionAt, NOTICE_DATE_FORMAT),
                        plazo: formatDate(n.plazoVencimientoAt, NOTICE_DATE_FORMAT),
                      })}
                    </span>
                  </div>
                  <p className="text-xs font-mono text-text-subtle">
                    {t('companyDetail.noticeHash', {
                      hash: n.evidenceHash.slice(0, 16),
                      kb: (n.evidenceSize / 1024).toFixed(1),
                    })}
                  </p>
                  {n.observaciones ? (
                    <p className="text-sm text-text-muted">{n.observaciones}</p>
                  ) : null}
                </div>
                <Button type="button" size="sm" variant="ghost" onClick={() => onDelete(n)}>
                  <Icon name="trash" size={13} />
                  {t('companyDetail.deleteNotice')}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function UploadForm({
  companyId,
  onUploaded,
  onCancel,
}: {
  companyId: string;
  onUploaded: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      const file = form.get('file') as File | null;
      if (!file || file.size === 0) {
        setError(t('companyDetail.fileRequired'));
        return;
      }
      if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
        setError(t('companyDetail.fileTypeNotAllowed', { type: file.type }));
        return;
      }
      const base64 = await fileToBase64(file);
      const payload: UploadRlptInput = {
        tipo: form.get('tipo') as RlptNoticeType,
        fechaNotificacionAt: form.get('fechaNotificacionAt')
          ? new Date(String(form.get('fechaNotificacionAt'))).toISOString()
          : undefined,
        observaciones: form.get('observaciones')?.toString() || undefined,
        data: base64,
        contentType: file.type as (typeof ALLOWED_MIME)[number],
        filename: file.name,
      };
      await fundaeRlptApi.upload(companyId, payload);
      await onUploaded();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('companyDetail.uploadTitle')}</CardTitle>
        <CardDescription>{t('companyDetail.uploadDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tipo">
                {t('companyDetail.tipoLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Select id="tipo" name="tipo" required defaultValue="NOTIFICACION_INICIAL">
                <option value="NOTIFICACION_INICIAL">{t('rlptTipo.NOTIFICACION_INICIAL')}</option>
                <option value="ACUSE_RECIBO">{t('rlptTipo.ACUSE_RECIBO')}</option>
                <option value="ACTA_DISCREPANCIA">{t('rlptTipo.ACTA_DISCREPANCIA')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaNotificacionAt">
                {t('companyDetail.fechaLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaNotificacionAt" name="fechaNotificacionAt" type="date" required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="file">
              {t('companyDetail.fileLabel')} <span className="text-danger-700">*</span>
            </Label>
            <input
              id="file"
              name="file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              required
              className="block w-full text-sm text-text"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="observaciones">{t('companyDetail.observacionesLabel')}</Label>
            <Textarea id="observaciones" name="observaciones" rows={2} maxLength={2000} />
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
              {pending ? t('companyDetail.uploading') : t('companyDetail.uploadDocument')}
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
