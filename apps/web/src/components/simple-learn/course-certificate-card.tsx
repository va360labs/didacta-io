'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { InviteAndEarnCard } from '@/components/invite-and-earn-card';
import { openLinkedIn } from '@/lib/certificate-linkedin';
import { formatDate } from '@/lib/i18n/format';
import { useTenantDisplayName } from '@/lib/tenant-context';
import type { Certificate } from '@/modules/certificates';

/**
 * ¿Se pinta la tarjeta del certificado dentro del curso? Solo en modo
 * sencillo, con el curso TERMINADO y el certificado ya emitido (se emite de
 * forma asíncrona: mientras no llega, el curso sigue como estaba).
 */
export function showCourseCertificateCard(args: {
  simple: boolean;
  enrollmentStatus: string | null | undefined;
  hasCertificate: boolean;
}): boolean {
  return args.simple && args.enrollmentStatus === 'COMPLETED' && args.hasCertificate;
}

/**
 * Modo sencillo: el certificado vive DENTRO del curso. Al terminarlo, una
 * tarjeta destacada con la vista previa, «Descargar PDF» y «Añadir a
 * LinkedIn» (el mismo flujo que «Mis certificados»), y debajo «Invita y gana»
 * si el aula tiene el programa de referidos activo.
 */
export function CourseCertificateCard({
  certificate,
  courseTitle,
  downloading,
  onDownload,
}: {
  certificate: Certificate;
  courseTitle: string;
  downloading: boolean;
  onDownload: () => void;
}) {
  const t = useTranslations('modoSencilloAprender.certificado');
  const academy = useTenantDisplayName();
  const student = certificate.snapshot?.studentName ?? '';
  const title = certificate.snapshot?.courseTitle ?? courseTitle;
  const issued = certificate.snapshot?.issuedAt ?? certificate.issuedAt;

  return (
    <div className="grid gap-4" data-testid="certificado-en-curso">
      <section className="grid gap-5 rounded-2xl border border-brand-200 bg-[linear-gradient(180deg,var(--color-brand-50),var(--color-surface)_75%)] p-5 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center lg:p-6">
        <div className="min-w-0">
          <h2 className="text-xl font-extrabold tracking-tight text-text">{t('titulo')}</h2>
          <p className="mt-1.5 max-w-[52ch] text-text-muted">{t('texto')}</p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
            <button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 text-[15px] font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              <Icon name="download-cloud" size={18} />
              {downloading ? t('descargando') : t('descargar')}
            </button>
            <button
              type="button"
              onClick={() => openLinkedIn(certificate, academy, title)}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 text-[15px] font-semibold text-text hover:border-border-strong"
            >
              <Icon name="briefcase" size={18} />
              {t('linkedin')}
            </button>
          </div>
        </div>
        <div
          className="mx-auto w-full max-w-[300px] rounded-xl border border-border bg-surface px-4 py-5 text-center shadow-lg"
          aria-label={t('vistaPrevia')}
        >
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-brand-600 text-white">
            <Icon name="award" size={20} />
          </span>
          <div className="mt-2.5 text-[11px] font-bold tracking-wide text-text-subtle">
            {t('etiqueta')}
          </div>
          {student ? (
            <div className="mt-1 truncate text-lg font-extrabold text-text">{student}</div>
          ) : null}
          <div className="mt-1 text-xs text-text-muted">{t('haCompletado')}</div>
          <div className="mt-0.5 truncate text-sm font-bold text-text">{title}</div>
          <div className="mt-3 flex justify-between gap-2 border-t border-border-soft pt-2.5 text-[11px] text-text-subtle">
            <span className="truncate">{academy}</span>
            <span className="shrink-0 tabular-nums">
              {formatDate(issued, { dateStyle: 'medium' })}
            </span>
          </div>
        </div>
      </section>
      <InviteAndEarnCard variant="inline" context="course" />
    </div>
  );
}
