'use client';

/**
 * Dashboard de control de suscripciones (mod.payment-connections).
 *
 * Vista única de TODAS las suscripciones de TODAS las cuentas conectadas
 * (Stripe + WooCommerce + PayPal), leída de la tabla materializada por el sync
 * (no en vivo). Muestra estado normalizado (vigente / impago / baja), filtros y
 * contadores, y permite "Sincronizar ahora" (on-demand). Solo super_admin.
 *
 * Todo el dato viene en vivo de la API (BD real). Cero datos de cartón.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  classifySubscriptionStatus,
  formatAmount,
  subscriptionsDashboardApi,
  type DashboardSubscriber,
  type SubscribersSummary,
} from '@/lib/payment-connections';

const PAGE_SIZE = 50;

/** Categorías mostrables en el filtro (orden y etiqueta legible). */
const CATEGORY_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos los estados' },
  { value: 'active', label: 'Vigente' },
  { value: 'past_due', label: 'Impago (con acceso)' },
  { value: 'unpaid', label: 'Impago suspendida' },
  { value: 'canceled', label: 'Baja' },
  { value: 'paused', label: 'Pausada' },
  { value: 'incomplete', label: 'Incompleta' },
  { value: 'unknown', label: 'Desconocido' },
];

const CATEGORY_BADGE: Record<string, string> = {
  active: 'border-success/30 bg-success/10 text-success-700',
  past_due: 'border-warning/40 bg-warning/10 text-warning-700',
  unpaid: 'border-danger/30 bg-danger/10 text-danger',
  canceled: 'border-border bg-surface-2 text-text-muted',
  paused: 'border-warning/30 bg-warning/5 text-warning-700',
  incomplete: 'border-border bg-surface-2 text-text-muted',
  unknown: 'border-border bg-surface-2 text-text-muted',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-ES');
}

export function SubscriptionsDashboard() {
  const [summary, setSummary] = useState<SubscribersSummary | null>(null);
  const [rows, setRows] = useState<DashboardSubscriber[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [provider, setProvider] = useState('');
  const [statusCategory, setStatusCategory] = useState('');
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const t = authStorage.getAccessToken();
    if (!t) return;
    try {
      setError(null);
      const [sum, list] = await Promise.all([
        subscriptionsDashboardApi.summary(t),
        subscriptionsDashboardApi.list(t, {
          provider: provider || undefined,
          statusCategory: statusCategory || undefined,
          onlyUnmatched: onlyUnmatched || undefined,
          q: q.trim() || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      ]);
      setSummary(sum);
      setRows(list.rows);
      setTotal(list.total);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las suscripciones.');
    }
  }, [provider, statusCategory, onlyUnmatched, q, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    const t = authStorage.getAccessToken();
    if (!t) return;
    setSyncing(true);
    setNotice(null);
    try {
      setError(null);
      const r = await subscriptionsDashboardApi.sync(t);
      const failed = r.failures.length
        ? ` · ${r.failures.length} cuenta(s) no se pudo(ieron) consultar`
        : '';
      setNotice(
        `Sincronizadas ${r.connections} cuenta(s): ${r.upserted} suscriptor(es), ${r.markedGone} baja(s)${failed}.`,
      );
      setPage(0);
      await load();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos sincronizar.');
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Control de suscripciones</CardTitle>
            <p className="mt-1 text-sm text-text-muted">
              Todas las suscripciones de todas las cuentas conectadas, con su estado real.
              {summary?.lastSyncedAt
                ? ` Última sincronización: ${new Date(summary.lastSyncedAt).toLocaleString('es-ES')}` +
                  (summary.lastSyncStatus && summary.lastSyncStatus !== 'success'
                    ? ` (${summary.lastSyncStatus})`
                    : '')
                : ' Aún no se ha sincronizado.'}
            </p>
          </div>
          <Button onClick={() => void sync()} disabled={syncing}>
            {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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

        {/* Contadores por estado */}
        {summary && (
          <div className="flex flex-wrap gap-2">
            <Badge className="border-border bg-surface-2 text-text">Total {summary.total}</Badge>
            {CATEGORY_FILTERS.filter((c) => c.value && summary.byCategory[c.value]).map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => {
                  setStatusCategory(statusCategory === c.value ? '' : c.value);
                  setPage(0);
                }}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                  CATEGORY_BADGE[c.value] ?? 'border-border bg-surface-2 text-text-muted'
                } ${statusCategory === c.value ? 'ring-2 ring-brand-500/40' : ''}`}
              >
                {c.label} {summary.byCategory[c.value]}
              </button>
            ))}
          </div>
        )}

        {/* Filtros */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-44 flex-1">
            <Label htmlFor="sub-q">Buscar por email</Label>
            <Input
              id="sub-q"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="email@ejemplo.com"
            />
          </div>
          <div className="w-44">
            <Label htmlFor="sub-provider">Proveedor</Label>
            <Select
              id="sub-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Todos</option>
              <option value="stripe">Stripe</option>
              <option value="woocommerce">WooCommerce</option>
              <option value="paypal">PayPal</option>
            </Select>
          </div>
          <div className="w-52">
            <Label htmlFor="sub-status">Estado</Label>
            <Select
              id="sub-status"
              value={statusCategory}
              onChange={(e) => {
                setStatusCategory(e.target.value);
                setPage(0);
              }}
            >
              {CATEGORY_FILTERS.map((c) => (
                <option key={c.value || 'all'} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-text">
            <input
              type="checkbox"
              checked={onlyUnmatched}
              onChange={(e) => {
                setOnlyUnmatched(e.target.checked);
                setPage(0);
              }}
            />
            Solo no registrados en Didacta
          </label>
        </div>

        {/* Tabla */}
        {rows === null ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-text-muted">
            {summary && summary.total === 0
              ? 'Aún no hay suscriptores sincronizados. Pulsa «Sincronizar ahora».'
              : 'No hay suscriptores con esos filtros.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="py-2 pr-3 font-medium">Suscriptor</th>
                  <th className="py-2 pr-3 font-medium">Proveedor</th>
                  <th className="py-2 pr-3 font-medium">Plan</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  <th className="py-2 pr-3 font-medium">Importe</th>
                  <th className="py-2 pr-3 font-medium">Próx. renovación</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const info = classifySubscriptionStatus(r.status);
                  return (
                    <tr key={r.id} className="border-b border-border/60">
                      <td className="py-2 pr-3">
                        <div className="text-text">{r.userEmail || '—'}</div>
                        {r.userId === null && (
                          <span className="text-xs text-text-muted">No en Didacta</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 capitalize">{r.provider}</td>
                      <td className="py-2 pr-3">{r.productName ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                            CATEGORY_BADGE[r.statusCategory] ?? CATEGORY_BADGE['unknown']
                          }`}
                        >
                          {info.label}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        {r.unitAmount !== null ? formatAmount(r.unitAmount, r.currency) : '—'}
                        {r.interval ? <span className="text-text-muted">/{r.interval}</span> : ''}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">{fmtDate(r.currentPeriodEnd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Paginación */}
        {rows !== null && total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>
              {total} suscriptor(es) · página {page + 1} de {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Anterior
              </Button>
              <Button
                variant="ghost"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
