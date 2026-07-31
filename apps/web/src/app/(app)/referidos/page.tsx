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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { formatReferralCents, referralsApi, type MemberReferralStats } from '@/lib/referrals';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobada',
  PAID: 'Pagada',
  REVOKED: 'Revocada',
};

const STATUS_VARIANT: Record<string, 'warning' | 'info' | 'success' | 'danger'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  REVOKED: 'danger',
};

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function ReferidosPage() {
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
                ? 'Necesitas una membresía activa para participar en el programa de referidos.'
                : 'No pudimos generar tu enlace. Recarga para reintentar.',
            );
          });
      })
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof ApiHttpError ? e.message : 'No pudimos cargar tus referidos. Recarga.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <h1 className="text-xl font-bold text-text">Referidos</h1>
        <p className="mt-1 text-sm text-text-muted">
          Recomienda la comunidad con tu enlace y gana el {commissionPercent}% de los pagos de quien
          entre por él.
        </p>
      </div>

      {!stats.programActive ? (
        <Card>
          <CardContent className="py-6 text-sm text-text-muted">
            El programa de referidos no está activo en este momento.
            {stats.totals.paidCents + stats.totals.approvedCents + stats.totals.pendingCents > 0
              ? ' Tu historial de comisiones sigue disponible más abajo.'
              : ''}
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="referral-link-card">
          <CardHeader>
            <CardTitle>Tu enlace</CardTitle>
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
                  {copied ? '¡Copiado!' : 'Copiar enlace'}
                </Button>
              </div>
            )}
            <p className="mt-2 text-xs text-text-subtle">
              La atribución dura {stats.attributionWindowDays} días desde el último clic. Las
              comisiones se aprueban{' '}
              {stats.scope === 'FIRST_PAYMENT' ? 'sobre el primer pago' : 'sobre cada cobro'} tras
              un periodo de garantía.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-3" data-testid="referral-stats">
        {[
          { label: 'Clics en tu enlace', value: String(stats.clicks) },
          { label: 'Altas atribuidas', value: String(stats.referrals) },
          {
            label: 'Pagado hasta hoy',
            value: formatReferralCents(stats.totals.paidCents),
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
          <CardTitle>Tus comisiones</CardTitle>
          <CardDescription>
            Pendiente: {formatReferralCents(stats.totals.pendingCents)} · Aprobado (por liquidar):{' '}
            {formatReferralCents(stats.totals.approvedCents)}
            {stats.minPayoutCents > 0
              ? ` · Mínimo de liquidación: ${formatReferralCents(stats.minPayoutCents)}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.commissions.length === 0 ? (
            <p className="text-sm text-text-subtle">
              Todavía no hay comisiones. Se generan cuando alguien que entró con tu enlace paga su
              suscripción.
            </p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {stats.commissions.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="text-text-subtle">{dateLabel(c.createdAt)}</span>
                  <span className="font-semibold text-text">
                    {formatReferralCents(c.amountCents, c.currency)}
                  </span>
                  <span className="text-xs text-text-subtle">
                    (sobre {formatReferralCents(c.baseAmountCents, c.currency)})
                  </span>
                  <Badge variant={STATUS_VARIANT[c.status] ?? 'muted'}>
                    {STATUS_LABEL[c.status] ?? c.status}
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
            <CardTitle>Liquidaciones recibidas</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border-soft">
              {stats.payouts.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="text-text-subtle">{dateLabel(p.createdAt)}</span>
                  <span className="font-semibold text-text">
                    {formatReferralCents(p.totalCents, p.currency)}
                  </span>
                  <span className="text-xs text-text-subtle">Ref: {p.externalReference}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
