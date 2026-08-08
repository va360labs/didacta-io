'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents, formatDate } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import { mySubscriptionApi, type MySubscriptionItem } from '@/lib/my-subscription';
import {
  subscriptionsApi,
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
  return formatCents(unitAmount, currency.toUpperCase());
}

export function SubscriptionTab() {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
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
      setError(t('subscription.noToken'));
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
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('subscription.invoicesError'),
      );
    }
  }

  async function cancelSub(sub: SubscriptionRow, immediate: boolean) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const subId = sub.id;
    const message = immediate
      ? sub.planId
        ? t('subscription.cancelNowConfirmMembership')
        : t('subscription.cancelNowConfirmCourse')
      : t('subscription.cancelPeriodConfirm');
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
        immediate ? t('subscription.canceledMsg') : t('subscription.cancelScheduledMsg'),
      );
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('subscription.cancelError'),
      );
    } finally {
      setBusyId(null);
    }
  }

  /** CTA "Pagar ahora": termina el trial de la membresía y cobra ya. */
  async function payNow(subId: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('subscription.payNowConfirm'))) return;
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
        setActionSuccess(t('subscription.payNowSuccess'));
      } else {
        setActionError(t('subscription.payNowFailed'));
      }
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('subscription.payError'),
      );
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
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('subscription.portalError'),
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
      <p className="text-text-muted">{t('subscription.intro')}</p>

      {checkoutStatus === 'success' ? (
        <div
          role="status"
          className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-800"
        >
          {t('subscription.checkoutSuccess')}
        </div>
      ) : null}
      {checkoutStatus === 'cancel' ? (
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-text-muted">
          {t('subscription.checkoutCancel')}
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
            <p className="mb-2 font-semibold">{t('subscription.emptyTitle')}</p>
            <p className="text-sm">{t('subscription.emptyDesc')}</p>
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
          ? (sub.planName ?? t('subscription.membershipFallback'))
          : (sub.courseTitle ??
            t('subscription.courseFallback', { id: (sub.courseId ?? '').slice(0, 8) }));
        return (
          <Card key={sub.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Icon name={isMembership ? 'sparkles' : 'book'} size={18} />
                <span>{title}</span>
                <SubStatusBadge status={sub.status} />
              </CardTitle>
              <CardDescription>
                {formatCents(sub.unitAmount, sub.currency.toUpperCase())} /{' '}
                {labelOr(t, `interval.${sub.interval}`, sub.interval)}
                {sub.status === 'TRIALING' && sub.trialEndsAt ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-brand-700">
                      {sub.cancelAtPeriodEnd
                        ? t('subscription.trialUntilCanceled', {
                            date: formatDate(sub.trialEndsAt),
                          })
                        : t('subscription.trialUntilCharge', { date: formatDate(sub.trialEndsAt) })}
                    </span>
                  </>
                ) : sub.currentPeriodEnd ? (
                  <>
                    {' · '}
                    {t('subscription.nextCharge', { date: formatDate(sub.currentPeriodEnd) })}
                  </>
                ) : null}
                {sub.cancelAtPeriodEnd ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-warning-800">
                      {t('subscription.cancelScheduled')}
                    </span>
                  </>
                ) : null}
                {sub.gracePeriodEndsAt && sub.status === 'PAST_DUE' ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-warning-800">
                      {t('subscription.retryUntil', { date: formatDate(sub.gracePeriodEndsAt) })}
                    </span>
                  </>
                ) : null}
                {sub.status === 'UNPAID' ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-danger-700">
                      {t('subscription.suspendedUnpaid')}
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
                    {busyId === sub.id ? t('subscription.processing') : t('subscription.payNowCta')}
                  </Button>
                ) : null}
                {sub.status !== 'CANCELED' && !sub.cancelAtPeriodEnd ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => cancelSub(sub, false)}
                    disabled={busyId === sub.id}
                  >
                    {busyId === sub.id
                      ? t('subscription.canceling')
                      : t('subscription.cancelAtPeriodEnd')}
                  </Button>
                ) : null}
                {sub.status !== 'CANCELED' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => cancelSub(sub, true)}
                    disabled={busyId === sub.id}
                  >
                    {busyId === sub.id ? t('subscription.canceling') : t('subscription.cancelNow')}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" onClick={() => void loadInvoices(sub.id)}>
                  {t('subscription.viewInvoices')}
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
  const t = useTranslations('cuentaComponentes');
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
          <span>{item.planName ?? t('subscription.myFallback')}</span>
          <Badge className={badgeClass}>{item.statusLabel}</Badge>
        </CardTitle>
        <CardDescription>
          {amount ? amount : t('subscription.subscriptionWord')}
          {item.interval ? ` / ${labelOr(t, `interval.${item.interval}`, item.interval)}` : ''}
          {item.currentPeriodEnd ? (
            <>
              {' · '}
              {t('subscription.nextCharge', { date: formatDate(item.currentPeriodEnd) })}
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {item.manageable ? (
            <Button type="button" onClick={onManage} disabled={busy}>
              {busy ? t('subscription.opening') : t('subscription.manage')}
            </Button>
          ) : item.renewalUrl ? (
            <a
              href={item.renewalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-brand-700 underline"
            >
              {t('subscription.viewPayInvoice')}
            </a>
          ) : (
            <p className="text-sm text-text-muted">{t('subscription.contactAcademy')}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  const t = useTranslations('cuentaComponentes');
  // El estado viene de Stripe vía el módulo: la clase se resuelve por mapa
  // cerrado y la etiqueta con `labelOr`, para degradar al valor crudo si el
  // proveedor añade un estado que aquí todavía no está.
  const className: Record<SubscriptionStatus, string> = {
    PENDING: 'border-border-strong text-text-muted',
    TRIALING: 'bg-brand-600 text-white',
    ACTIVE: 'bg-success-600 text-white',
    PAST_DUE: 'bg-warning-600 text-white',
    UNPAID: 'bg-danger-600 text-white',
    CANCELED: 'border-border-strong text-text-muted',
  };
  return <Badge className={className[status]}>{labelOr(t, `subBadge.${status}`, status)}</Badge>;
}

function InvoicesList({ invoices }: { invoices: InvoiceRow[] }) {
  const t = useTranslations('cuentaComponentes');
  if (invoices.length === 0) {
    return <p className="text-xs text-text-subtle">{t('subscription.noInvoices')}</p>;
  }
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2">
      <ul className="divide-y divide-border-soft">
        {invoices.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="font-mono text-xs">{inv.stripeInvoiceId}</span>
            <span>{formatCents(inv.amount, inv.currency.toUpperCase())}</span>
            <InvoiceStatusBadge status={inv.status} />
            <span className="text-text-muted">
              {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)}
            </span>
            {inv.hostedInvoiceUrl ? (
              <a
                href={inv.hostedInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs font-semibold text-brand-700 underline"
              >
                {t('subscription.downloadPdf')}
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
