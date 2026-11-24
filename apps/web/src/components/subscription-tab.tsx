'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Pestaña "Suscripción" de /account.
 *
 * Muestra DOS fuentes de suscripción del usuario:
 *  1. Su plan en la cuenta de pago EXTERNA del tenant (mod.payment-connections),
 *     con botón "Gestionar mi suscripción" → Customer Portal de Stripe.
 *  2. Sus suscripciones recurrentes a cursos (mod.subscriptions): ver / darse
 *     de baja / facturas. «Darme de baja» abre la oferta al darse de baja
 *     (motivo + pausa o descuento si el aula los ofrece); es el único camino de
 *     baja (el portal de Stripe ya no la ofrece).
 *
 * En un aula con NIVELES, la tarjeta de la membresía dice en qué nivel está y
 * ofrece «Cambiar de plan» (`ChangePlanDialog`, con prorrateo de Stripe) y, si
 * hay nivel gratis, pasar a él, que es darse de baja (el diálogo de siempre).
 * Qué se puede hacer lo dice la API (`change-options`): sin opciones, nada
 * nuevo en pantalla.
 *
 * Antes vivía como página suelta en /account/subscriptions (ruta huérfana). Todo
 * CE, sin EeGate.
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ChangePlanDialog } from '@/components/change-plan-dialog';
import { Icon } from '@/components/icon';
import { LeaveSubscriptionDialog } from '@/components/leave-subscription-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents, formatDate } from '@/lib/i18n/format';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';
import { mySubscriptionApi, type MySubscriptionItem } from '@/lib/my-subscription';
import {
  subscriptionsApi,
  type InvoiceRow,
  type PlanChangeBlockReason,
  type PlanChangeOptions,
  type SubscriptionRow,
  type SubscriptionStatus,
} from '@/modules/subscriptions';

/** ¿Hay una membresía viva por la que preguntar si se puede cambiar de plan? */
function hasLiveMembership(subs: SubscriptionRow[]): boolean {
  return subs.some((s) => s.planId !== null && s.status !== 'CANCELED');
}

/**
 * Lo que la fila cruda de una acción (pagar ahora, baja, cambio) no trae y sí
 * puso el listado: nombres, nivel, portal y descuento vivo.
 */
function keepEnrichment(updated: SubscriptionRow, prev: SubscriptionRow): SubscriptionRow {
  return {
    ...updated,
    planName: prev.planName,
    tierId: prev.tierId,
    tierName: prev.tierName,
    courseTitle: prev.courseTitle,
    billingPortal: prev.billingPortal,
  };
}

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
  /** Las dos fuentes fallaron: no sabemos si tiene suscripciones o no. */
  const [sinRespuesta, setSinRespuesta] = useState(false);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [external, setExternal] = useState<MySubscriptionItem[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState<string | null>(null);
  const [invoicesById, setInvoicesById] = useState<Record<string, InvoiceRow[]>>({});
  /** Suscripción con el diálogo «Darme de baja» abierto. */
  const [leaving, setLeaving] = useState<SubscriptionRow | null>(null);
  /**
   * Cambio de plan de la membresía según la API: a qué puede pasar, si algo lo
   * impide y si hay nivel gratis. `null`: sin membresía o la API no contestó
   * (la tarjeta queda como siempre).
   */
  const [changeOptions, setChangeOptions] = useState<PlanChangeOptions | null>(null);
  const [changingPlan, setChangingPlan] = useState(false);
  const tBaja = useTranslations('bajaRetencion');
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
        // Solo con una membresía viva se pregunta qué cambios de plan hay.
        // Best-effort: si no contesta, la tarjeta queda como siempre.
        if (hasLiveMembership(inPlatform.value.subscriptions)) {
          try {
            setChangeOptions(await subscriptionsApi.membershipChangeOptions(token));
          } catch {
            setChangeOptions(null);
          }
        }
      }
      if (ext.status === 'fulfilled') {
        setExternal(ext.value.subscriptions);
      }
      // Si NINGUNA de las dos fuentes contestó, no sabemos nada: no es que el
      // alumno no tenga suscripciones, es que no hemos podido preguntarlo. Sin
      // esta distinción, `isEmpty` pintaba "no tienes ninguna suscripción" en
      // una pantalla de dinero cada vez que la API se caía.
      setSinRespuesta(inPlatform.status === 'rejected' && ext.status === 'rejected');
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

  /**
   * Recarga la lista y lo que se puede cambiar de plan: tras una baja (ya no
   * se puede cambiar) o un cambio de plan (nivel y precio nuevos).
   */
  function refreshSubscriptions() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void subscriptionsApi
      .listMine(token)
      .then((r) => setSubs(r.subscriptions))
      .catch(() => undefined);
    // Si no contesta, se queda lo que había: no se cierra un diálogo abierto.
    void subscriptionsApi
      .membershipChangeOptions(token)
      .then((o) => setChangeOptions(o))
      .catch(() => undefined);
  }

  /** Tras decidir en «Darme de baja»: repinta la tarjeta conservando el enriquecimiento. */
  function onLeaveDone(updated: SubscriptionRow) {
    setSubs((prev) =>
      prev.map((s) =>
        s.id === updated.id
          ? { ...keepEnrichment(updated, s), retentionDiscount: s.retentionDiscount }
          : s,
      ),
    );
    // El descuento recién aceptado se ve al recargar la lista.
    refreshSubscriptions();
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
      // enriquecimiento (planName/tierName/courseTitle) que puso el listado.
      setSubs((prev) =>
        prev.map((s) => (s.id === res.subscription.id ? keepEnrichment(res.subscription, s) : s)),
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

  /** Portal de Stripe de una suscripción propia (tarjeta, facturas, baja). */
  async function openSubscriptionPortal(subId: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPortalBusy(subId);
    setActionError(null);
    try {
      const res = await subscriptionsApi.billingPortal(token, subId);
      window.location.href = res.url;
      // No reseteamos portalBusy: navegamos fuera de la app.
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('subscription.portalError'),
      );
      setPortalBusy(null);
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

  const isEmpty = external.length === 0 && subs.length === 0 && !sinRespuesta;

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

      {sinRespuesta ? (
        <Card>
          <CardContent className="p-6 text-center text-text-muted">
            <p className="mb-2 font-semibold">{t('subscription.unavailableTitle')}</p>
            <p className="text-sm">{t('subscription.unavailableDesc')}</p>
          </CardContent>
        </Card>
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

      {leaving ? (
        <LeaveSubscriptionDialog
          sub={leaving}
          itemName={
            leaving.planId
              ? (leaving.planName ?? t('subscription.membershipFallback'))
              : (leaving.courseTitle ??
                t('subscription.courseFallback', { id: (leaving.courseId ?? '').slice(0, 8) }))
          }
          open
          onOpenChange={(next) => {
            if (!next) setLeaving(null);
          }}
          onDone={(updated) => onLeaveDone(updated)}
        />
      ) : null}

      {changingPlan && changeOptions ? (
        <ChangePlanDialog
          options={changeOptions}
          open
          onOpenChange={(next) => {
            if (!next) setChangingPlan(false);
          }}
          onDone={() => refreshSubscriptions()}
        />
      ) : null}

      {subs.map((sub) => {
        const isMembership = sub.planId !== null;
        const title = isMembership
          ? (sub.planName ?? t('subscription.membershipFallback'))
          : (sub.courseTitle ??
            t('subscription.courseFallback', { id: (sub.courseId ?? '').slice(0, 8) }));
        // Cambio de plan: solo en la tarjeta de la membresía de la que habla la API.
        const change =
          isMembership && changeOptions?.subscription?.id === sub.id ? changeOptions : null;
        const canLeave = sub.status !== 'CANCELED' && !sub.cancelAtPeriodEnd;
        return (
          <Card key={sub.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Icon name={isMembership ? 'sparkles' : 'book'} size={18} />
                <span>{title}</span>
                {isMembership && sub.tierName ? (
                  <span
                    className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700"
                    data-testid="sub-nivel"
                  >
                    {t('subscription.nivel', { name: sub.tierName })}
                  </span>
                ) : null}
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
                    {/* Con una pausa aceptada, el próximo cobro es el de la vuelta:
                        las renovaciones de dentro de la pausa no se cobran. */}
                    {t('subscription.nextCharge', {
                      date: formatDate(
                        sub.pauseEndsAt && sub.status !== 'CANCELED'
                          ? sub.pauseEndsAt
                          : sub.currentPeriodEnd,
                      ),
                    })}
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
                {sub.status === 'PAUSED' && sub.pauseEndsAt ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-brand-700" data-testid="sub-en-pausa">
                      {tBaja('alumno.enPausaHasta', { fecha: formatDate(sub.pauseEndsAt) })}
                    </span>
                  </>
                ) : sub.pauseStartsAt && sub.pauseEndsAt && sub.status !== 'CANCELED' ? (
                  <>
                    {' · '}
                    <span
                      className="font-semibold text-brand-700"
                      data-testid="sub-pausa-programada"
                    >
                      {tBaja('alumno.pausaProgramada', {
                        desde: formatDate(sub.pauseStartsAt),
                        hasta: formatDate(sub.pauseEndsAt),
                      })}
                    </span>
                  </>
                ) : null}
                {sub.retentionDiscount ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-success-700" data-testid="sub-descuento">
                      {sub.retentionDiscount.endsAt && sub.retentionDiscount.duration !== 'once'
                        ? tBaja('alumno.descuentoActivo', {
                            pct: sub.retentionDiscount.percent,
                            fecha: formatDate(sub.retentionDiscount.endsAt),
                          })
                        : tBaja('alumno.descuentoActivoSinFecha', {
                            pct: sub.retentionDiscount.percent,
                          })}
                    </span>
                  </>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {sub.billingPortal && sub.status !== 'CANCELED' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void openSubscriptionPortal(sub.id)}
                    disabled={portalBusy === sub.id}
                  >
                    {portalBusy === sub.id ? t('subscription.opening') : t('subscription.manage')}
                  </Button>
                ) : null}
                {isMembership && sub.status === 'TRIALING' && !sub.cancelAtPeriodEnd ? (
                  <Button
                    type="button"
                    onClick={() => void payNow(sub.id)}
                    disabled={busyId === sub.id}
                  >
                    {busyId === sub.id ? t('subscription.processing') : t('subscription.payNowCta')}
                  </Button>
                ) : null}
                {change && change.options.length > 0 && change.blockedReason === null ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setChangingPlan(true)}
                    disabled={busyId === sub.id}
                    data-testid="sub-cambiar-plan"
                  >
                    {t('cambioPlan.boton')}
                  </Button>
                ) : null}
                {/* Pasar al nivel gratis es darse de baja: el diálogo de siempre. */}
                {change?.freeTier && canLeave ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setLeaving(sub)}
                    disabled={busyId === sub.id}
                    data-testid="sub-pasar-a-gratis"
                  >
                    {t('cambioPlan.pasarAGratis', { name: change.freeTier.name })}
                  </Button>
                ) : null}
                {canLeave ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setLeaving(sub)}
                    disabled={busyId === sub.id}
                    data-testid="sub-darme-de-baja"
                  >
                    {tBaja('alumno.boton')}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" onClick={() => void loadInvoices(sub.id)}>
                  {t('subscription.viewInvoices')}
                </Button>
              </div>

              {change && change.options.length > 0 && change.blockedReason !== null ? (
                <p className="text-sm text-text-muted" data-testid="sub-cambio-bloqueado">
                  {blockedReasonText(t, change.blockedReason)}
                </p>
              ) : null}

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

/** Por qué no puede cambiar de plan ahora, en llano (`cuentaComponentes`). */
function blockedReasonText(t: TranslatorLike, reason: PlanChangeBlockReason): string {
  switch (reason) {
    case 'cancel_scheduled':
      return t('cambioPlan.bloqueado.cancel_scheduled');
    case 'pause_scheduled':
      return t('cambioPlan.bloqueado.pause_scheduled');
    case 'no_membership':
      return t('cambioPlan.bloqueado.no_membership');
    default:
      return t('cambioPlan.bloqueado.not_active');
  }
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
    PAUSED: 'border-brand-300 bg-brand-50 text-brand-700',
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
            <span>
              {formatCents(inv.totalCents ?? inv.amount, inv.currency.toUpperCase())}
              {inv.creditAppliedCents ? (
                <span
                  className="block text-xs text-text-subtle"
                  data-testid="factura-saldo-referidos"
                >
                  {t('subscription.saldoReferidos', {
                    amount: formatCents(-inv.creditAppliedCents, inv.currency.toUpperCase()),
                    paid: formatCents(inv.amount, inv.currency.toUpperCase()),
                  })}
                </span>
              ) : null}
            </span>
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
