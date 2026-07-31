'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Administración del programa de referidos (mod.referrals).
///
/// - Config del programa: comisión, ámbito, ventanas, mínimo, copy. Los
///   cambios NO recalculan comisiones ya devengadas (bps sellados por fila).
/// - Referidores: ranking con métricas reales y liquidación manual del saldo
///   aprobado (referencia externa obligatoria — v1 sin Stripe Connect).
/// - Comisiones: listado con filtros y acciones aprobar / revocar (motivo).

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import {
  formatReferralCents,
  referralsAdminApi,
  type AdminCommissionRow,
  type AdminReferrerRow,
  type ReferralCommissionStatus,
  type ReferralsConfig,
} from '@/lib/referrals';

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

interface ConfigForm {
  active: boolean;
  commissionPercent: string;
  scope: 'FIRST_PAYMENT' | 'RECURRING';
  recurringMonths: string;
  attributionWindowDays: string;
  guaranteeDays: string;
  minPayoutEur: string;
  requireActiveMembership: boolean;
  memberCopy: string;
}

function toForm(config: ReferralsConfig): ConfigForm {
  return {
    active: config.active,
    commissionPercent: (config.commissionBps / 100).toString(),
    scope: config.scope,
    recurringMonths: config.recurringMonths === null ? '' : String(config.recurringMonths),
    attributionWindowDays: String(config.attributionWindowDays),
    guaranteeDays: String(config.guaranteeDays),
    minPayoutEur: (config.minPayoutCents / 100).toString(),
    requireActiveMembership: config.requireActiveMembership,
    memberCopy: config.memberCopy ?? '',
  };
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function AdminReferidosPage() {
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [referrers, setReferrers] = useState<AdminReferrerRow[]>([]);
  const [commissions, setCommissions] = useState<AdminCommissionRow[]>([]);
  const [totals, setTotals] = useState<
    Array<{ status: ReferralCommissionStatus; totalCents: number; count: number }>
  >([]);
  const [statusFilter, setStatusFilter] = useState<'' | ReferralCommissionStatus>('');
  const [minPayoutCents, setMinPayoutCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (filter: '' | ReferralCommissionStatus = '') => {
    const [config, refs, comms] = await Promise.all([
      referralsAdminApi.getConfig(),
      referralsAdminApi.listReferrers(),
      referralsAdminApi.listCommissions(filter ? { status: filter } : {}),
    ]);
    setForm(toForm(config));
    setMinPayoutCents(config.minPayoutCents);
    setReferrers(refs);
    setCommissions(comms.commissions);
    setTotals(comms.totalsByStatus);
  }, []);

  useEffect(() => {
    reload().catch((e) => {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los referidos.');
    });
  }, [reload]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await reload(statusFilter);
      setNotice(label);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'La operación falló. Reintenta.');
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!form) return;
    const percent = Number(form.commissionPercent.replace(',', '.'));
    const minPayout = Number(form.minPayoutEur.replace(',', '.'));
    await run('Configuración guardada. Solo afecta a devengos futuros.', async () => {
      await referralsAdminApi.updateConfig({
        active: form.active,
        commissionBps: Math.round(percent * 100),
        scope: form.scope,
        recurringMonths: form.recurringMonths.trim() === '' ? null : Number(form.recurringMonths),
        attributionWindowDays: Number(form.attributionWindowDays),
        guaranteeDays: Number(form.guaranteeDays),
        minPayoutCents: Math.round(minPayout * 100),
        requireActiveMembership: form.requireActiveMembership,
        memberCopy: form.memberCopy.trim() === '' ? null : form.memberCopy.trim(),
      });
    });
  }

  async function liquidate(referrer: AdminReferrerRow) {
    const reference = window.prompt(
      `Liquidar ${formatReferralCents(referrer.approvedCents)} a ${referrer.code}.\n\nReferencia externa del pago (transferencia, PayPal…):`,
    );
    if (!reference || reference.trim().length < 3) return;
    await run('Liquidación registrada.', async () => {
      const approved = await referralsAdminApi.listCommissions({
        status: 'APPROVED',
        referrerUserId: referrer.referrerUserId,
      });
      await referralsAdminApi.recordPayout({
        referrerUserId: referrer.referrerUserId,
        commissionIds: approved.commissions.map((c) => c.id),
        externalReference: reference.trim(),
      });
    });
  }

  async function revoke(commission: AdminCommissionRow) {
    const reason = window.prompt(
      `Revocar la comisión de ${formatReferralCents(commission.amountCents, commission.currency)}.\n\nMotivo (obligatorio, lo verá el miembro):`,
    );
    if (!reason || reason.trim().length < 3) return;
    await run('Comisión revocada.', () =>
      referralsAdminApi.revokeCommission(commission.id, reason.trim()),
    );
  }

  if (!form) {
    return (
      <div className="mx-auto max-w-4xl space-y-2">
        <div className="skeleton h-40 w-full" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">Programa de referidos</h1>
        <p className="mt-1 text-sm text-text-muted">
          Los miembros comparten su enlace de /unete y ganan un % de los cobros reales de quien
          entra. La liquidación es manual con referencia externa (v1 sin pagos automáticos).
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700"
        >
          {notice}
        </div>
      ) : null}

      <Card data-testid="referrals-config-card">
        <CardHeader>
          <CardTitle>Configuración</CardTitle>
          <CardDescription>
            Los cambios no recalculan comisiones ya devengadas: cada comisión sella el % vigente en
            el momento del cobro.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-3">
              <Switch
                id="ref-active"
                checked={form.active}
                onCheckedChange={(v) => setForm({ ...form, active: v })}
              />
              <Label htmlFor="ref-active">Programa activo</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="ref-require"
                checked={form.requireActiveMembership}
                onCheckedChange={(v) => setForm({ ...form, requireActiveMembership: v })}
              />
              <Label htmlFor="ref-require">Exigir membresía activa al referidor</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-percent">Comisión (%)</Label>
              <Input
                id="ref-percent"
                inputMode="decimal"
                value={form.commissionPercent}
                onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-scope">Ámbito del devengo</Label>
              <Select
                id="ref-scope"
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as ConfigForm['scope'] })}
              >
                <option value="RECURRING">Recurrente (cada cobro)</option>
                <option value="FIRST_PAYMENT">Solo el primer cobro</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-months">Meses de recurrencia (vacío = ilimitado)</Label>
              <Input
                id="ref-months"
                inputMode="numeric"
                value={form.recurringMonths}
                onChange={(e) => setForm({ ...form, recurringMonths: e.target.value })}
                disabled={form.scope !== 'RECURRING'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-window">Ventana de atribución (días)</Label>
              <Input
                id="ref-window"
                inputMode="numeric"
                value={form.attributionWindowDays}
                onChange={(e) => setForm({ ...form, attributionWindowDays: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-guarantee">Días de garantía antes de aprobar</Label>
              <Input
                id="ref-guarantee"
                inputMode="numeric"
                value={form.guaranteeDays}
                onChange={(e) => setForm({ ...form, guaranteeDays: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ref-min">Mínimo de liquidación (€, 0 = sin mínimo)</Label>
              <Input
                id="ref-min"
                inputMode="decimal"
                value={form.minPayoutEur}
                onChange={(e) => setForm({ ...form, minPayoutEur: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ref-copy">Mensaje para el área del miembro (opcional)</Label>
              <textarea
                id="ref-copy"
                rows={3}
                value={form.memberCopy}
                onChange={(e) => setForm({ ...form, memberCopy: e.target.value })}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="Ej.: Comparte tu enlace y gana el 30% de cada cuota."
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end border-t border-border-soft pt-3">
            <Button type="button" onClick={() => void saveConfig()} disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar configuración'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="referrals-referrers-card">
        <CardHeader>
          <CardTitle>Referidores</CardTitle>
          <CardDescription>
            Saldo aprobado = pendiente de liquidar. La liquidación marca las comisiones como pagadas
            con la referencia del pago real.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {referrers.length === 0 ? (
            <p className="text-sm text-text-subtle">
              Aún no hay referidores: aparecerán cuando los miembros generen su enlace.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-soft text-left text-xs text-text-subtle">
                    <th className="py-2 pr-3">Código</th>
                    <th className="py-2 pr-3">Clics</th>
                    <th className="py-2 pr-3">Altas</th>
                    <th className="py-2 pr-3">Pendiente</th>
                    <th className="py-2 pr-3">Aprobado</th>
                    <th className="py-2 pr-3">Pagado</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {referrers.map((r) => (
                    <tr key={r.referrerUserId} className="border-b border-border-soft">
                      <td className="py-2 pr-3 font-mono">{r.code}</td>
                      <td className="py-2 pr-3">{r.clicks}</td>
                      <td className="py-2 pr-3">{r.referrals}</td>
                      <td className="py-2 pr-3">{formatReferralCents(r.pendingCents)}</td>
                      <td className="py-2 pr-3 font-semibold">
                        {formatReferralCents(r.approvedCents)}
                      </td>
                      <td className="py-2 pr-3">{formatReferralCents(r.paidCents)}</td>
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            busy ||
                            r.approvedCents === 0 ||
                            (minPayoutCents > 0 && r.approvedCents < minPayoutCents)
                          }
                          onClick={() => void liquidate(r)}
                          title={
                            minPayoutCents > 0 && r.approvedCents < minPayoutCents
                              ? `Por debajo del mínimo (${formatReferralCents(minPayoutCents)})`
                              : undefined
                          }
                        >
                          Liquidar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="referrals-commissions-card">
        <CardHeader>
          <CardTitle>Comisiones</CardTitle>
          <CardDescription>
            {totals.length === 0
              ? 'Sin comisiones todavía.'
              : totals
                  .map(
                    (t) =>
                      `${STATUS_LABEL[t.status] ?? t.status}: ${t.count} (${formatReferralCents(t.totalCents)})`,
                  )
                  .join(' · ')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 max-w-xs">
            <Label htmlFor="ref-filter">Filtrar por estado</Label>
            <Select
              id="ref-filter"
              value={statusFilter}
              onChange={(e) => {
                const next = e.target.value as '' | ReferralCommissionStatus;
                setStatusFilter(next);
                void reload(next).catch(() => setError('No pudimos filtrar.'));
              }}
            >
              <option value="">Todas</option>
              <option value="PENDING">Pendientes</option>
              <option value="APPROVED">Aprobadas</option>
              <option value="PAID">Pagadas</option>
              <option value="REVOKED">Revocadas</option>
            </Select>
          </div>
          {commissions.length === 0 ? (
            <p className="text-sm text-text-subtle">Nada que mostrar con este filtro.</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {commissions.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="text-text-subtle">{dateLabel(c.createdAt)}</span>
                  <span className="font-semibold text-text">
                    {formatReferralCents(c.amountCents, c.currency)}
                  </span>
                  <span className="text-xs text-text-subtle">
                    sobre {formatReferralCents(c.baseAmountCents, c.currency)} ·{' '}
                    {(c.commissionBps / 100).toFixed(0)}%
                  </span>
                  <Badge variant={STATUS_VARIANT[c.status] ?? 'muted'}>
                    {STATUS_LABEL[c.status] ?? c.status}
                  </Badge>
                  {c.status === 'REVOKED' && c.revokeReason ? (
                    <span className="text-xs text-danger-700">{c.revokeReason}</span>
                  ) : null}
                  <span className="ml-auto flex gap-2">
                    {c.status === 'PENDING' ? (
                      <>
                        <button
                          type="button"
                          className="text-xs text-brand-700 hover:underline"
                          disabled={busy}
                          onClick={() =>
                            void run('Comisión aprobada.', () =>
                              referralsAdminApi.approveCommission(c.id),
                            )
                          }
                        >
                          Aprobar ya
                        </button>
                        <button
                          type="button"
                          className="text-xs text-danger-700 hover:underline"
                          disabled={busy}
                          onClick={() => void revoke(c)}
                        >
                          Revocar
                        </button>
                      </>
                    ) : c.status === 'APPROVED' ? (
                      <button
                        type="button"
                        className="text-xs text-danger-700 hover:underline"
                        disabled={busy}
                        onClick={() => void revoke(c)}
                      >
                        Revocar
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
