'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  listMemberRequests,
  rerunMemberLookup,
  type MemberRequest,
  type MemberSubscriptionMatch,
} from '@/lib/inscripcion';
import { formatAmount } from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';

/**
 * Panel admin de solicitudes de inscripción de miembros. Lista las solicitudes
 * PENDING y, por cada una, el estado de su suscripción consultada en TODAS las
 * cuentas de pago conectadas (Stripe/PayPal/WooCommerce), con un botón para
 * volver a consultar (p.ej. tras conectar una cuenta o si dio error).
 */
export default function SolicitudesMiembrosPage() {
  const [requests, setRequests] = useState<MemberRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);

  async function load() {
    const t = authStorage.getAccessToken();
    if (!t) return;
    try {
      setError(null);
      setRequests(await listMemberRequests(t));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las solicitudes.');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function rerun(userId: string) {
    const t = authStorage.getAccessToken();
    if (!t) return;
    setRerunning(userId);
    try {
      setError(null);
      await rerunMemberLookup(t, userId);
      await load();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos volver a consultar.');
    } finally {
      setRerunning(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Solicitudes de inscripción</h1>
        <p className="text-text-muted">
          Miembros que solicitaron acceso por la página de inscripción, pendientes de validar. Por
          cada uno se consulta su suscripción en todas las cuentas de pago conectadas.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {requests === null ? (
        <Skeleton className="h-32 w-full" />
      ) : requests.length === 0 ? (
        <p className="text-text-muted">No hay solicitudes pendientes.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {requests.map((r) => (
            <Card key={r.userId}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">{r.name ?? r.email}</CardTitle>
                  <Button
                    variant="secondary"
                    onClick={() => void rerun(r.userId)}
                    disabled={rerunning === r.userId}
                  >
                    {rerunning === r.userId ? 'Consultando…' : 'Volver a consultar suscripción'}
                  </Button>
                </div>
                <CardDescription>
                  {r.email}
                  {r.telegramId ? ` · Telegram ${r.telegramId}` : ''}
                  {r.telegramInGroup === true
                    ? ' · en el grupo'
                    : r.telegramInGroup === false
                      ? ' · NO en el grupo'
                      : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SubscriptionBlock request={r} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bloque de estado de suscripción de una solicitud. */
function SubscriptionBlock({ request }: { request: MemberRequest }) {
  const lookup = request.lookup;
  if (!lookup || lookup.status === 'PENDING') {
    return (
      <p className="text-sm text-text-muted">
        {lookup?.status === 'PENDING'
          ? 'Consultando la suscripción…'
          : 'Aún no se ha consultado la suscripción.'}
      </p>
    );
  }
  if (lookup.status === 'ERROR') {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning-700">
        ⚠ No se pudo verificar la suscripción
        {lookup.error ? `: ${lookup.error}` : ''}. Revisa que las cuentas de pago estén conectadas y
        vuelve a consultar.
      </div>
    );
  }
  // DONE
  if (lookup.matchCount === 0 || lookup.results.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-muted">
        Sin suscripción detectada en las cuentas de pago conectadas.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2">
      <p className="mb-1 text-sm font-medium text-success-700">
        Suscripción detectada ({lookup.results.length})
      </p>
      <ul className="flex flex-col gap-1">
        {lookup.results.map((m) => (
          <li key={m.subscriptionId} className="text-sm text-text">
            {describeMatch(m)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeMatch(m: MemberSubscriptionMatch): string {
  const plan = m.planName ?? 'Plan';
  const amount = m.unitAmount !== null ? ` · ${formatAmount(m.unitAmount, m.currency)}` : '';
  return `${plan} — ${m.status}${amount} (${m.connectionName})`;
}
