'use client';

/**
 * Panel alumno · Mis suscripciones (mod.subscriptions).
 *
 * Lista las suscripciones del alumno con status badge, próximo cobro,
 * historial de invoices y acción de cancelar.
 *
 * No es EE — todo CE. Sin EeGate.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  subscriptionsApi,
  formatAmount,
  formatInterval,
  type InvoiceRow,
  type SubscriptionRow,
  type SubscriptionStatus,
} from '@/modules/subscriptions';

export default function MisSuscripcionesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [invoicesById, setInvoicesById] = useState<Record<string, InvoiceRow[]>>({});

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) {
      setError('Sesión sin token. Volvé a iniciar sesión.');
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const res = await subscriptionsApi.listMine(token);
        setSubs(res.subscriptions);
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? e.message : 'No se pudieron cargar tus suscripciones.',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function loadInvoices(subId: string) {
    if (invoicesById[subId]) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const res = await subscriptionsApi.listInvoices(token, subId);
      setInvoicesById((prev) => ({ ...prev, [subId]: res.invoices }));
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudieron cargar las facturas.');
    }
  }

  async function cancelSub(subId: string, immediate: boolean) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const message = immediate
      ? '¿Cancelar la suscripción AHORA? Perderás acceso al curso inmediatamente.'
      : '¿Cancelar al final del periodo actual? Mantendrás acceso hasta esa fecha.';
    if (!window.confirm(message)) return;
    setBusyId(subId);
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await subscriptionsApi.cancel(token, subId, immediate);
      setSubs((prev) => prev.map((s) => (s.id === subId ? res.subscription : s)));
      setActionSuccess(
        immediate ? 'Suscripción cancelada.' : 'Cancelación al final del periodo aplicada.',
      );
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo cancelar la suscripción.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">Mis suscripciones</h1>
        <p className="text-text-muted">
          Gestiona tus suscripciones recurrentes a cursos. Puedes cancelar al final del periodo
          (mantenés acceso hasta esa fecha) o de inmediato.
        </p>
      </header>

      {actionError ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {actionError}
        </div>
      ) : null}
      {actionSuccess ? (
        <div
          role="status"
          className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-800"
        >
          {actionSuccess}
        </div>
      ) : null}

      {subs.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-text-muted">
            <p className="mb-2 font-semibold">Aún no tienes ninguna suscripción.</p>
            <p className="text-sm">
              Cuando te suscribas a un curso desde el catálogo, aparecerá aquí.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {subs.map((sub) => (
        <Card key={sub.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Icon name="book" size={18} />
              <span className="font-mono text-sm">curso {sub.courseId.slice(0, 8)}…</span>
              <SubStatusBadge status={sub.status} />
            </CardTitle>
            <CardDescription>
              {formatAmount(sub.unitAmount, sub.currency)} / {formatInterval(sub.interval)}
              {sub.currentPeriodEnd ? (
                <>
                  {' · '}
                  Próximo cobro: {new Date(sub.currentPeriodEnd).toLocaleDateString('es-ES')}
                </>
              ) : null}
              {sub.cancelAtPeriodEnd ? (
                <>
                  {' · '}
                  <span className="font-semibold text-warning-800">
                    Cancelación programada al final del periodo
                  </span>
                </>
              ) : null}
              {sub.gracePeriodEndsAt && sub.status === 'PAST_DUE' ? (
                <>
                  {' · '}
                  <span className="font-semibold text-warning-800">
                    Reintentando cobro hasta{' '}
                    {new Date(sub.gracePeriodEndsAt).toLocaleDateString('es-ES')}
                  </span>
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {sub.status !== 'CANCELED' && !sub.cancelAtPeriodEnd ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => cancelSub(sub.id, false)}
                  disabled={busyId === sub.id}
                >
                  {busyId === sub.id ? 'Cancelando…' : 'Cancelar al final del periodo'}
                </Button>
              ) : null}
              {sub.status !== 'CANCELED' ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => cancelSub(sub.id, true)}
                  disabled={busyId === sub.id}
                >
                  {busyId === sub.id ? 'Cancelando…' : 'Cancelar ahora'}
                </Button>
              ) : null}
              <Button type="button" variant="ghost" onClick={() => void loadInvoices(sub.id)}>
                Ver facturas
              </Button>
            </div>

            {invoicesById[sub.id] ? <InvoicesList invoices={invoicesById[sub.id]!} /> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  const map: Record<SubscriptionStatus, { label: string; className: string }> = {
    PENDING: { label: 'Pendiente', className: 'border-border-strong text-text-muted' },
    ACTIVE: { label: 'Activa', className: 'bg-success-600 text-white' },
    PAST_DUE: { label: 'Pago pendiente', className: 'bg-warning-600 text-white' },
    UNPAID: { label: 'Impagada', className: 'bg-danger-600 text-white' },
    CANCELED: { label: 'Cancelada', className: 'border-border-strong text-text-muted' },
  };
  const cfg = map[status];
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function InvoicesList({ invoices }: { invoices: InvoiceRow[] }) {
  if (invoices.length === 0) {
    return <p className="text-xs text-text-subtle">Sin facturas todavía.</p>;
  }
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2">
      <ul className="divide-y divide-border-soft">
        {invoices.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="font-mono text-xs">{inv.stripeInvoiceId}</span>
            <span>{formatAmount(inv.amount, inv.currency)}</span>
            <InvoiceStatusBadge status={inv.status} />
            <span className="text-text-muted">
              {new Date(inv.periodStart).toLocaleDateString('es-ES')} –{' '}
              {new Date(inv.periodEnd).toLocaleDateString('es-ES')}
            </span>
            {inv.hostedInvoiceUrl ? (
              <a
                href={inv.hostedInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs font-semibold text-brand-700 underline"
              >
                Ver / descargar PDF ↗
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InvoiceStatusBadge({ status }: { status: InvoiceRow['status'] }) {
  const map: Record<InvoiceRow['status'], string> = {
    OPEN: 'border-border-strong text-text-muted',
    PAID: 'bg-success-600 text-white',
    UNCOLLECTIBLE: 'bg-danger-600 text-white',
    VOID: 'border-border-strong text-text-muted',
  };
  return <Badge className={map[status]}>{status}</Badge>;
}
