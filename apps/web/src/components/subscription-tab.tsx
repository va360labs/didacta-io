'use client';

/**
 * Pestaña "Suscripción" de /cuenta.
 *
 * Muestra DOS fuentes de suscripción del usuario:
 *  1. Su plan en la cuenta de pago EXTERNA del tenant (mod.payment-connections),
 *     con botón "Gestionar mi suscripción" → Customer Portal de Stripe.
 *  2. Sus suscripciones recurrentes a cursos (mod.subscriptions): ver / cancelar
 *     / facturas.
 *
 * Antes vivía como página suelta en /cuenta/suscripciones (ruta huérfana). Todo
 * CE, sin EeGate.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { mySubscriptionApi, type MySubscriptionItem } from '@/lib/my-subscription';
import {
  subscriptionsApi,
  formatAmount,
  formatInterval,
  type InvoiceRow,
  type SubscriptionRow,
  type SubscriptionStatus,
} from '@/modules/subscriptions';

/** Lee el `?status` del retorno de Stripe (success/cancel) una sola vez al montar. */
function useCheckoutStatus(): 'success' | 'cancel' | null {
  const [status, setStatus] = useState<'success' | 'cancel' | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const s = new URLSearchParams(window.location.search).get('status');
    if (s === 'success' || s === 'cancel') setStatus(s);
  }, []);
  return status;
}

/** Importe legible desde céntimos, tolerante a null. */
function amountLabel(unitAmount: number | null, currency: string | null): string | null {
  if (unitAmount == null || !currency) return null;
  return formatAmount(unitAmount, currency);
}

export function SubscriptionTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [external, setExternal] = useState<MySubscriptionItem[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState<string | null>(null);
  const [invoicesById, setInvoicesById] = useState<Record<string, InvoiceRow[]>>({});
  const checkoutStatus = useCheckoutStatus();

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) {
      setError('Sesión sin token. Vuelve a iniciar sesión.');
      setLoading(false);
      return;
    }
    void (async () => {
      // Dos fuentes best-effort e INDEPENDIENTES. Si una falla (módulo no
      // configurado, 403/404/500…), esa fuente queda vacía sin romper la
      // pestaña: para los usuarios con pago externo la fuente principal es
      // `mySubscriptionApi`, no las suscripciones a cursos in-platform.
      const [inPlatform, ext] = await Promise.allSettled([
        subscriptionsApi.listMine(token),
        mySubscriptionApi.get(token),
      ]);
      if (inPlatform.status === 'fulfilled') {
        setSubs(inPlatform.value.subscriptions);
      }
      if (ext.status === 'fulfilled') {
        setExternal(ext.value.subscriptions);
      }
      setLoading(false);
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

  async function cancelSub(sub: SubscriptionRow, immediate: boolean) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const subId = sub.id;
    const what = sub.planId ? 'a los cursos de la membresía' : 'al curso';
    const message = immediate
      ? `¿Cancelar la suscripción AHORA? Perderás acceso ${what} inmediatamente.`
      : '¿Cancelar al final del periodo actual? Mantendrás acceso hasta esa fecha.';
    if (!window.confirm(message)) return;
    setBusyId(subId);
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await subscriptionsApi.cancel(token, subId, immediate);
      // Conservar planName/courseTitle: la respuesta trae la fila sin enriquecer.
      setSubs((prev) =>
        prev.map((s) =>
          s.id === subId
            ? { ...res.subscription, planName: s.planName, courseTitle: s.courseTitle }
            : s,
        ),
      );
      setActionSuccess(
        immediate ? 'Suscripción cancelada.' : 'Cancelación al final del periodo aplicada.',
      );
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo cancelar la suscripción.');
    } finally {
      setBusyId(null);
    }
  }

  /** CTA "Pagar ahora": termina el trial de la membresía y cobra ya. */
  async function payNow(subId: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (
      !window.confirm(
        '¿Terminar tu periodo de prueba y pagar ahora? Se cobrará el primer periodo inmediatamente y tendrás acceso completo a todo el contenido.',
      )
    )
      return;
    setBusyId(subId);
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await subscriptionsApi.membershipPayNow(token);
      // La respuesta del módulo trae la fila cruda: conservamos el
      // enriquecimiento (planName/courseTitle) que puso el listado.
      setSubs((prev) =>
        prev.map((s) =>
          s.id === res.subscription.id
            ? { ...res.subscription, planName: s.planName, courseTitle: s.courseTitle }
            : s,
        ),
      );
      if (res.subscription.status === 'ACTIVE') {
        setActionSuccess(
          '¡Pago realizado! Tu membresía está activa y todo el contenido desbloqueado.',
        );
      } else {
        setActionError(
          'No se pudo completar el cobro con tu tarjeta. Stripe lo reintentará automáticamente; si el problema persiste, contacta con tu academia.',
        );
      }
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo procesar el pago.');
    } finally {
      setBusyId(null);
    }
  }

  async function openPortal(item: MySubscriptionItem) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPortalBusy(item.id);
    setActionError(null);
    try {
      const res = await mySubscriptionApi.billingPortal(token, item.id);
      window.location.href = res.url;
      // No reseteamos portalBusy: navegamos fuera de la app.
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo abrir el portal de gestión.',
      );
      setPortalBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton />
        <Skeleton />
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

  const isEmpty = external.length === 0 && subs.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-text-muted">
        Consulta y gestiona tu suscripción: cambiar el método de pago, ver facturas o cancelar.
      </p>

      {checkoutStatus === 'success' ? (
        <div
          role="status"
          className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-800"
        >
          ✓ ¡Suscripción completada! Puede tardar unos segundos en aparecer aquí.
        </div>
      ) : null}
      {checkoutStatus === 'cancel' ? (
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-text-muted">
          No completaste el pago. No se ha creado ninguna suscripción.
        </div>
      ) : null}

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

      {isEmpty ? (
        <Card>
          <CardContent className="p-6 text-center text-text-muted">
            <p className="mb-2 font-semibold">Aún no tienes ninguna suscripción.</p>
            <p className="text-sm">
              Cuando te suscribas desde el catálogo, aparecerá aquí para gestionarla.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {external.map((item) => (
        <ExternalSubCard
          key={item.id}
          item={item}
          busy={portalBusy === item.id}
          onManage={() => void openPortal(item)}
        />
      ))}

      {subs.map((sub) => {
        const isMembership = sub.planId !== null;
        const title = isMembership
          ? (sub.planName ?? 'Membresía')
          : (sub.courseTitle ?? `curso ${(sub.courseId ?? '').slice(0, 8)}…`);
        return (
          <Card key={sub.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Icon name={isMembership ? 'sparkles' : 'book'} size={18} />
                <span>{title}</span>
                <SubStatusBadge status={sub.status} />
              </CardTitle>
              <CardDescription>
                {formatAmount(sub.unitAmount, sub.currency)} / {formatInterval(sub.interval)}
                {sub.status === 'TRIALING' && sub.trialEndsAt ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-brand-700">
                      {sub.cancelAtPeriodEnd
                        ? `Prueba gratis hasta el ${new Date(sub.trialEndsAt).toLocaleDateString('es-ES')} — no se te cobrará (cancelación programada)`
                        : `Prueba gratis hasta el ${new Date(sub.trialEndsAt).toLocaleDateString('es-ES')} — después se cobra el primer periodo`}
                    </span>
                  </>
                ) : sub.currentPeriodEnd ? (
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
                {sub.status === 'UNPAID' ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-danger-700">
                      Acceso suspendido por impago
                    </span>
                  </>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {isMembership && sub.status === 'TRIALING' && !sub.cancelAtPeriodEnd ? (
                  <Button
                    type="button"
                    onClick={() => void payNow(sub.id)}
                    disabled={busyId === sub.id}
                  >
                    {busyId === sub.id ? 'Procesando…' : 'Pagar ahora y activar'}
                  </Button>
                ) : null}
                {sub.status !== 'CANCELED' && !sub.cancelAtPeriodEnd ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => cancelSub(sub, false)}
                    disabled={busyId === sub.id}
                  >
                    {busyId === sub.id ? 'Cancelando…' : 'Cancelar al final del periodo'}
                  </Button>
                ) : null}
                {sub.status !== 'CANCELED' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => cancelSub(sub, true)}
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
        );
      })}
    </div>
  );
}

function Skeleton() {
  return <div className="skeleton h-32 w-full" />;
}

/** Tarjeta de la suscripción EXTERNA (payment-connections) con el CTA de portal. */
function ExternalSubCard({
  item,
  busy,
  onManage,
}: {
  item: MySubscriptionItem;
  busy: boolean;
  onManage: () => void;
}) {
  const amount = amountLabel(item.unitAmount, item.currency);
  const badgeClass = item.entitled
    ? 'bg-success-600 text-white'
    : item.statusCategory === 'past_due'
      ? 'bg-warning-600 text-white'
      : 'border-border-strong text-text-muted';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon name="award" size={18} />
          <span>{item.planName ?? 'Mi suscripción'}</span>
          <Badge className={badgeClass}>{item.statusLabel}</Badge>
        </CardTitle>
        <CardDescription>
          {amount ? amount : 'Suscripción'}
          {item.interval ? ` / ${formatInterval(item.interval)}` : ''}
          {item.currentPeriodEnd ? (
            <>
              {' · '}
              Próximo cobro: {new Date(item.currentPeriodEnd).toLocaleDateString('es-ES')}
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {item.manageable ? (
            <Button type="button" onClick={onManage} disabled={busy}>
              {busy ? 'Abriendo…' : 'Gestionar mi suscripción'}
            </Button>
          ) : item.renewalUrl ? (
            <a
              href={item.renewalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-brand-700 underline"
            >
              Ver / pagar factura ↗
            </a>
          ) : (
            <p className="text-sm text-text-muted">
              Para gestionar esta suscripción, contacta con el equipo de tu academia.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  const map: Record<SubscriptionStatus, { label: string; className: string }> = {
    PENDING: { label: 'Pendiente', className: 'border-border-strong text-text-muted' },
    TRIALING: { label: 'En prueba', className: 'bg-brand-600 text-white' },
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
