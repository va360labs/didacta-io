'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  decideMemberRequest,
  listMemberRequests,
  rerunMemberLookup,
  type MemberRequest,
  type MemberSubscriptionMatch,
} from '@/lib/inscripcion';
import { formatAmount, paymentTiersApi, type PaymentTier } from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';

/**
 * Panel admin de solicitudes de inscripción. Por cada solicitud PENDING muestra
 * el estado de su suscripción (consultada en TODAS las cuentas conectadas) y un
 * selector de TIER que viene PRESELECCIONADO si la suscripción detectada coincide
 * con un tier del catálogo (por nombre de plan); se puede cambiar a mano. Al
 * aprobar, se asigna ese tier (que, si está vinculado a un grupo, da el acceso).
 */
export default function SolicitudesMiembrosPage() {
  const [requests, setRequests] = useState<MemberRequest[] | null>(null);
  const [tiers, setTiers] = useState<PaymentTier[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Tier del catálogo cuyo nombre coincide con algún plan de la suscripción detectada. */
  function suggestTierId(req: MemberRequest, catalog: PaymentTier[]): string {
    const planNames = (req.lookup?.results ?? []).map((m) => (m.planName ?? '').trim());
    const match = catalog.find((t) => planNames.includes(t.name.trim()));
    return match?.id ?? '';
  }

  async function load() {
    const t = authStorage.getAccessToken();
    if (!t) return;
    try {
      setError(null);
      const [reqs, catalog] = await Promise.all([
        listMemberRequests(t),
        paymentTiersApi
          .listCatalog(t)
          .then((r) => r.tiers)
          .catch(() => [] as PaymentTier[]),
      ]);
      setRequests(reqs);
      setTiers(catalog);
      // Preselección: el tier que coincide con la suscripción (salvo que el admin
      // ya hubiera tocado el selector de esa fila en esta sesión).
      setSelected((prev) => {
        const next = { ...prev };
        for (const r of reqs) {
          if (next[r.userId] === undefined) next[r.userId] = suggestTierId(r, catalog);
        }
        return next;
      });
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
    setBusy(`rerun:${userId}`);
    try {
      setError(null);
      await rerunMemberLookup(t, userId);
      await load();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos volver a consultar.');
    } finally {
      setBusy(null);
    }
  }

  async function approve(req: MemberRequest) {
    const t = authStorage.getAccessToken();
    if (!t) return;
    setBusy(`approve:${req.userId}`);
    try {
      setError(null);
      const tierId = selected[req.userId] || null;
      // 1) Asigna el tier (emite el evento → reconcilia el grupo vinculado/acceso).
      if (tierId) await paymentTiersApi.assignUserTier(t, req.userId, tierId);
      // 2) Aprueba (ACTIVE + grupo por defecto + bienvenida).
      await decideMemberRequest(t, req.userId, 'approve');
      const tierName = tiers.find((x) => x.id === tierId)?.name;
      setNotice(
        `${req.name ?? req.email} aprobado${tierName ? ` con el tier «${tierName}»` : ''}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos aprobar la solicitud.');
    } finally {
      setBusy(null);
    }
  }

  async function reject(req: MemberRequest) {
    const t = authStorage.getAccessToken();
    if (!t) return;
    if (!window.confirm(`¿Rechazar la solicitud de ${req.name ?? req.email}?`)) return;
    setBusy(`reject:${req.userId}`);
    try {
      setError(null);
      await decideMemberRequest(t, req.userId, 'reject');
      setNotice(`${req.name ?? req.email} rechazado.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos rechazar la solicitud.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Solicitudes de inscripción</h1>
        <p className="text-text-muted">
          Miembros que solicitaron acceso, pendientes de validar. Por cada uno se consulta su
          suscripción en todas las cuentas de pago conectadas y se preselecciona el tier que
          corresponda (puedes cambiarlo antes de aprobar).
        </p>
      </header>

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
                    variant="ghost"
                    onClick={() => void rerun(r.userId)}
                    disabled={busy === `rerun:${r.userId}`}
                  >
                    {busy === `rerun:${r.userId}` ? 'Consultando…' : 'Volver a consultar'}
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
              <CardContent className="flex flex-col gap-4">
                <SubscriptionBlock request={r} />

                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[14rem] flex-1">
                    <Label htmlFor={`tier-${r.userId}`}>Tier a asignar</Label>
                    <Select
                      id={`tier-${r.userId}`}
                      value={selected[r.userId] ?? ''}
                      onChange={(e) =>
                        setSelected((prev) => ({ ...prev, [r.userId]: e.target.value }))
                      }
                    >
                      <option value="">— Sin tier —</option>
                      {tiers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                    {selected[r.userId] && selected[r.userId] === suggestTierId(r, tiers) && (
                      <p className="mt-1 text-xs text-brand-700">
                        Preseleccionado por su suscripción detectada.
                      </p>
                    )}
                  </div>
                  <Button onClick={() => void approve(r)} disabled={busy === `approve:${r.userId}`}>
                    {busy === `approve:${r.userId}` ? 'Aprobando…' : 'Aprobar'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void reject(r)}
                    disabled={busy === `reject:${r.userId}`}
                  >
                    Rechazar
                  </Button>
                </div>
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
