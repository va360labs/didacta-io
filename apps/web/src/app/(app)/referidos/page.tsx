'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Área del miembro del programa de referidos (mod.referrals).
///
/// Muestra el enlace propio (creándolo bajo demanda), los resultados reales
/// (clics, altas, comisiones por estado) y el historial de comisiones y
/// liquidaciones. Si el programa está inactivo, lo comunica; si exige
/// membresía activa y el usuario no la tiene, explica qué falta (403 del
/// backend con código estable). Cero datos inventados (regla #3).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents, formatDate, formatNumber } from '@/lib/i18n/format';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';
import { referralsApi, type MemberReferralStats } from '@/lib/referrals';

/** Estado de comisión → key del catálogo. Viene de la API: desconocido → crudo. */
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'referidos.estadoPendiente',
  APPROVED: 'referidos.estadoAprobada',
  PAID: 'referidos.estadoPagada',
  REVOKED: 'referidos.estadoRevocada',
};

function statusLabel(status: string, t: TranslatorLike): string {
  const key = STATUS_LABEL[status];
  return key ? labelOr(t, key, status) : status;
}

const STATUS_VARIANT: Record<string, 'warning' | 'info' | 'success' | 'danger'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  REVOKED: 'danger',
};

function dateLabel(iso: string): string {
  return formatDate(iso, { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReferidosPage() {
  const t = useTranslations('alumnoSocial');
  const tErrors = useTranslations('errors');
  const [stats, setStats] = useState<MemberReferralStats | null>(null);
  const [link, setLink] = useState<{ code: string; url: string } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    referralsApi
      .myStats()
      .then((s) => {
        if (cancelled) return;
        setStats(s);
        if (!s.programActive) return;
        // Enlace bajo demanda: lo crea si no existe. 403 = requiere membresía.
        referralsApi
          .me()
          .then((l) => {
            if (!cancelled) setLink(l);
          })
          .catch((e) => {
            if (cancelled) return;
            setLinkError(
              e instanceof ApiHttpError && e.code === 'REFERRALS_MEMBERSHIP_REQUIRED'
                ? t('referidos.membresiaRequerida')
                : t('referidos.errorEnlace'),
            );
          });
      })
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('referidos.errorCarga'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t, tErrors]);

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard bloqueado: el usuario puede copiar a mano del input.
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="skeleton h-40 w-full" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  const commissionPercent = (stats.commissionBps / 100).toFixed(
    stats.commissionBps % 100 === 0 ? 0 : 2,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">{t('referidos.titulo')}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t('referidos.descripcion', { percent: commissionPercent })}
        </p>
      </div>

      {!stats.programActive ? (
        <Card>
          <CardContent className="py-6 text-sm text-text-muted">
            {t('referidos.programaInactivo')}{' '}
            {stats.totals.paidCents + stats.totals.approvedCents + stats.totals.pendingCents > 0
              ? t('referidos.historialDisponible')
              : ''}
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="referral-link-card">
          <CardHeader>
            <CardTitle>{t('referidos.tuEnlace')}</CardTitle>
            {stats.memberCopy ? <CardDescription>{stats.memberCopy}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            {linkError ? (
              <p className="text-sm text-warning-700">{linkError}</p>
            ) : !link ? (
              <div className="skeleton h-10 w-full" />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  readOnly
                  value={link.url}
                  data-testid="referral-link-input"
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" onClick={() => void copyLink()}>
                  {copied ? t('referidos.copiado') : t('referidos.copiarEnlace')}
                </Button>
              </div>
            )}
            <p className="mt-2 text-xs text-text-subtle">
              {t('referidos.atribucion', {
                days: stats.attributionWindowDays,
                scope:
                  stats.scope === 'FIRST_PAYMENT'
                    ? t('referidos.scopePrimerPago')
                    : t('referidos.scopeCadaCobro'),
              })}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-3" data-testid="referral-stats">
        {[
          { label: t('referidos.statClics'), value: formatNumber(stats.clicks) },
          { label: t('referidos.statAltas'), value: formatNumber(stats.referrals) },
          {
            label: t('referidos.statPagado'),
            value: formatCents(stats.totals.paidCents),
          },
        ].map((tile) => (
          <Card key={tile.label}>
            <CardContent className="py-4">
              <p className="text-xs text-text-subtle">{tile.label}</p>
              <p className="mt-1 text-2xl font-bold text-text">{tile.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('referidos.tusComisiones')}</CardTitle>
          <CardDescription>
            {t('referidos.resumenComisiones', {
              pending: formatCents(stats.totals.pendingCents),
              approved: formatCents(stats.totals.approvedCents),
            })}{' '}
            {stats.minPayoutCents > 0
              ? t('referidos.minimoLiquidacion', { min: formatCents(stats.minPayoutCents) })
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.commissions.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('referidos.sinComisiones')}</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {stats.commissions.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="text-text-subtle">{dateLabel(c.createdAt)}</span>
                  <span className="font-semibold text-text">
                    {formatCents(c.amountCents, c.currency)}
                  </span>
                  <span className="text-xs text-text-subtle">
                    {t('referidos.sobreBase', {
                      amount: formatCents(c.baseAmountCents, c.currency),
                    })}
                  </span>
                  <Badge variant={STATUS_VARIANT[c.status] ?? 'muted'}>
                    {statusLabel(c.status, t)}
                  </Badge>
                  {c.status === 'REVOKED' && c.revokeReason ? (
                    <span className="text-xs text-danger-700">{c.revokeReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {stats.payouts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('referidos.liquidaciones')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border-soft">
              {stats.payouts.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="text-text-subtle">{dateLabel(p.createdAt)}</span>
                  <span className="font-semibold text-text">
                    {formatCents(p.totalCents, p.currency)}
                  </span>
                  <span className="text-xs text-text-subtle">
                    {t('referidos.ref', { reference: p.externalReference })}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
