'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  decideMemberRequest,
  listMemberRequests,
  memberRenewalContext,
  rerunMemberLookup,
  sendMemberRenewalEmail,
  type MemberRequest,
  type MemberPurchaseMatch,
  type MemberSubscriptionMatch,
} from '@/lib/inscripcion';
import {
  classifySubscriptionStatus,
  formatAmount,
  paymentTiersApi,
  type PaymentTier,
} from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';
import { RenewalEmailModal } from '@/components/renewal-email-modal';

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
  // match null = email a un solicitante SIN suscripción detectada (sin enlace de renovación).
  const [emailFor, setEmailFor] = useState<{
    req: MemberRequest;
    match: MemberSubscriptionMatch | null;
  } | null>(null);
  // Email alternativo por solicitud, para mapear una suscripción registrada con otro email.
  const [mapEmail, setMapEmail] = useState<Record<string, string>>({});

  /**
   * Tier del catálogo cuyo nombre coincide con algún plan de una suscripción
   * VIGENTE (activa/en prueba/al corriente). Una baja o un impago NO preselecciona
   * el tier: el admin decide a mano si quiere darle acceso igualmente.
   */
  function suggestTierId(req: MemberRequest, catalog: PaymentTier[]): string {
    const planNames = (req.lookup?.results ?? [])
      .filter((m) => classifySubscriptionStatus(m.status).entitled)
      .map((m) => (m.planName ?? '').trim());
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

  async function rerun(userId: string, email?: string) {
    const t = authStorage.getAccessToken();
    if (!t) return;
    setBusy(`rerun:${userId}`);
    try {
      setError(null);
      await rerunMemberLookup(t, userId, email);
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
                <SubscriptionBlock
                  request={r}
                  onRemind={(match) => setEmailFor({ req: r, match })}
                  onEmail={() => setEmailFor({ req: r, match: null })}
                />

                <PurchasesBlock request={r} />

                <MapSubscriptionRow
                  request={r}
                  value={mapEmail[r.userId] ?? ''}
                  busy={busy === `rerun:${r.userId}`}
                  onChange={(v) => setMapEmail((prev) => ({ ...prev, [r.userId]: v }))}
                  onSearch={() =>
                    void rerun(r.userId, (mapEmail[r.userId] ?? '').trim() || undefined)
                  }
                />

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

      {emailFor && (
        <RenewalEmailModal
          to={emailFor.req.email}
          productName={emailFor.match?.planName ?? null}
          unitAmount={emailFor.match?.unitAmount ?? null}
          currency={emailFor.match?.currency ?? null}
          loadContext={async () => {
            const t = authStorage.getAccessToken();
            if (!t) throw new Error('No hay sesión activa.');
            return memberRenewalContext(t, emailFor.req.userId, emailFor.match?.subscriptionId);
          }}
          send={async (payload) => {
            const t = authStorage.getAccessToken();
            if (!t) throw new Error('No hay sesión activa.');
            return sendMemberRenewalEmail(t, emailFor.req.userId, payload);
          }}
          onClose={() => setEmailFor(null)}
          onSent={(msg) => {
            setEmailFor(null);
            setNotice(msg);
          }}
        />
      )}
    </div>
  );
}

/**
 * Fila para mapear la suscripción por OTRO email, cuando el miembro se registró con
 * un email pero pagó con otro. Re-consulta el lookup por ese email y lo persiste.
 */
function MapSubscriptionRow({
  request,
  value,
  busy,
  onChange,
  onSearch,
}: {
  request: MemberRequest;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSearch: () => void;
}) {
  const usedEmail = request.lookup?.email ?? null;
  const mapped = usedEmail && usedEmail.toLowerCase() !== request.email.toLowerCase();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-surface-2 p-3">
      {mapped ? (
        <p className="text-xs text-brand-700">
          Suscripción consultada por <strong>{usedEmail}</strong> (mapeado).
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <Label htmlFor={`mapemail-${request.userId}`} className="text-xs text-text-muted">
            ¿La suscripción está a otro email? Mapéala aquí
          </Label>
          <Input
            id={`mapemail-${request.userId}`}
            type="email"
            placeholder="email de la suscripción…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) onSearch();
            }}
          />
        </div>
        <Button variant="secondary" onClick={onSearch} disabled={busy || !value.trim()}>
          {busy ? 'Buscando…' : 'Buscar suscripción'}
        </Button>
      </div>
    </div>
  );
}

/** Bloque de estado de suscripción de una solicitud. */
function SubscriptionBlock({
  request,
  onRemind,
  onEmail,
}: {
  request: MemberRequest;
  onRemind: (match: MemberSubscriptionMatch) => void;
  /** Enviar un email al solicitante SIN suscripción detectada (sin enlace de renovación). */
  onEmail: () => void;
}) {
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
  const results = lookup.results ?? [];
  if (lookup.matchCount === 0 || results.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
        <span className="text-sm text-text-muted">
          Sin suscripción detectada en las cuentas de pago conectadas.
        </span>
        <Button variant="ghost" size="sm" onClick={onEmail}>
          Enviar email
        </Button>
      </div>
    );
  }
  // ¿Alguna suscripción concede acceso hoy? Si todas son bajas/impagos, lo decimos
  // explícitamente (no es lo mismo que "sin suscripción").
  const hasEntitled = results.some((m) => classifySubscriptionStatus(m.status).entitled);
  return (
    <div
      className={
        hasEntitled
          ? 'rounded-lg border border-success/30 bg-success/5 px-3 py-2'
          : 'rounded-lg border border-warning/40 bg-warning/5 px-3 py-2'
      }
    >
      <p
        className={
          hasEntitled
            ? 'mb-1 text-sm font-medium text-success-700'
            : 'mb-1 text-sm font-medium text-warning-700'
        }
      >
        {hasEntitled
          ? `Suscripción vigente (${results.length})`
          : `⚠ Suscripción no vigente — baja o impago (${results.length})`}
      </p>
      <ul className="flex flex-col gap-1">
        {results.map((m) => (
          <li
            key={m.subscriptionId}
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-text"
          >
            <span>{describeMatch(m)}</span>
            <Button variant="ghost" onClick={() => onRemind(m)}>
              Enviar recordatorio
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Compras PUNTUALES (pedidos) del solicitante. Quien compró un "acceso lifetime"
 * no tiene suscripción viva: sin este bloque el bloque de arriba diría "sin
 * suscripción" y se rechazaría a un cliente que sí pagó. Solo se pinta si hay
 * compras (para no añadir ruido a las solicitudes normales).
 */
function PurchasesBlock({ request }: { request: MemberRequest }) {
  const purchases = request.lookup?.purchases ?? [];
  if (purchases.length === 0) return null;
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
      <p className="mb-1 text-sm font-medium text-brand-700">
        Compras detectadas ({purchases.length})
      </p>
      <ul className="flex flex-col gap-1">
        {purchases.map((p) => (
          <li key={`${p.connectionId}:${p.orderId}`} className="text-sm text-text">
            {describePurchase(p)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Describe un pedido en una línea: nº · fecha · estado · importe — productos. */
function describePurchase(p: MemberPurchaseMatch): string {
  const date = p.createdAt ? new Date(p.createdAt) : null;
  const head = [
    p.orderNumber ? `#${p.orderNumber}` : `#${p.orderId}`,
    date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('es-ES') : '',
    p.status,
    p.total !== null ? formatAmount(p.total, p.currency) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const products = p.products.length ? ` — ${p.products.join(', ')}` : '';
  return `${head}${products} (${p.connectionName})`;
}

function describeMatch(m: MemberSubscriptionMatch): string {
  const plan = m.planName ?? 'Plan';
  const { label } = classifySubscriptionStatus(m.status);
  const amount = m.unitAmount !== null ? ` · ${formatAmount(m.unitAmount, m.currency)}` : '';
  return `${plan} — ${label}${amount} (${m.connectionName})`;
}
