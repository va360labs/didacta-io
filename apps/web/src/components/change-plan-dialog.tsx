'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Cambiar de plan»: el alumno pasa su membresía a otro nivel (o a otra
 * periodicidad del suyo) desde la pestaña Suscripción de su cuenta.
 *
 *   1. Ve lo que tiene ahora y los planes a los que puede pasar, agrupados por
 *      nivel (si sube o baja de precio al mes, precio y periodicidad).
 *   2. Al elegir uno, la API calcula lo que pasará (`change-preview`) y se
 *      explica en llano: lo que se cobra hoy, lo que queda a favor o que sigue
 *      la prueba gratis sin cobrar nada.
 *   3. Confirmar hace el cambio (`change`): subir cobra la diferencia ya (si la
 *      tarjeta falla, el plan NO cambia y se dice); bajar deja la diferencia a
 *      favor en la próxima factura.
 *
 * Qué opciones hay y si se puede cambiar lo decide la API
 * (`GET …/me/membership/change-options`); aquí no se decide nada.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCentsExact } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { cn } from '@/lib/utils';
import {
  subscriptionsApi,
  type PlanChangeOption,
  type PlanChangeOptions,
  type PlanChangePreview,
  type PlanChangeResult,
} from '@/modules/subscriptions';

export interface ChangePlanDialogProps {
  /** Lo que devolvió `change-options` (con opciones y sin bloqueo). */
  options: PlanChangeOptions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tras cambiar: para recargar la lista de suscripciones. */
  onDone: (result: PlanChangeResult, option: PlanChangeOption) => void;
}

/** «29 €/mes», «290 €/año», «50 € cada 2 meses»… con decimales exactos. */
export function pricePerPeriod(
  t: TranslatorLike,
  cents: number,
  currency: string,
  intervalMonths: number,
  locale: string,
): string {
  const price = formatCentsExact(cents, currency.toUpperCase(), { locale });
  if (intervalMonths === 12) return t('cambioPlan.porAnio', { price });
  if (intervalMonths === 6) return t('cambioPlan.porSemestre', { price });
  if (intervalMonths === 3) return t('cambioPlan.porTrimestre', { price });
  if (intervalMonths === 1) return t('cambioPlan.porMes', { price });
  return t('cambioPlan.porMeses', { price, months: intervalMonths });
}

/** Las opciones agrupadas por nivel, en el orden en que llegan (el del creador). */
export function groupByTier(
  options: PlanChangeOption[],
): Array<{ tierId: string; tierName: string; options: PlanChangeOption[] }> {
  const groups = new Map<
    string,
    { tierId: string; tierName: string; options: PlanChangeOption[] }
  >();
  for (const option of options) {
    const group = groups.get(option.tierId) ?? {
      tierId: option.tierId,
      tierName: option.tierName,
      options: [],
    };
    group.options.push(option);
    groups.set(option.tierId, group);
  }
  return [...groups.values()];
}

export function ChangePlanDialog({
  options,
  open,
  onOpenChange,
  onDone,
}: ChangePlanDialogProps): React.JSX.Element | null {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [chosen, setChosen] = useState<PlanChangeOption | null>(null);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ option: PlanChangeOption; result: PlanChangeResult } | null>(
    null,
  );
  // Si se eligen dos opciones seguidas, solo vale la respuesta de la última.
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    previewSeq.current += 1;
    setChosen(null);
    setPreview(null);
    setPreviewing(false);
    setBusy(false);
    setError(null);
    setDone(null);
  }, [open]);

  async function choose(option: PlanChangeOption) {
    const token = authStorage.getAccessToken();
    if (!token || busy) return;
    const seq = ++previewSeq.current;
    setChosen(option);
    setPreview(null);
    setError(null);
    setPreviewing(true);
    try {
      const res = await subscriptionsApi.membershipChangePreview(token, option.planId);
      if (seq === previewSeq.current) setPreview(res);
    } catch (e) {
      if (seq === previewSeq.current) {
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('cambioPlan.error'));
      }
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  }

  async function confirm() {
    const token = authStorage.getAccessToken();
    if (!token || !chosen || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await subscriptionsApi.membershipChange(token, chosen.planId);
      setDone({ option: chosen, result });
      onDone(result, chosen);
    } catch (e) {
      // 402 `MEMBERSHIP_PLAN_CHANGE_PAYMENT_FAILED`: la tarjeta no pasó y el
      // plan sigue como estaba; el mensaje traducido lo dice.
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('cambioPlan.error'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const current = options.subscription;
  const money = (cents: number, currency: string) =>
    formatCentsExact(cents, currency.toUpperCase(), { locale });
  const perPeriod = (o: { amountCents: number; currency: string; intervalMonths: number }) =>
    pricePerPeriod(t, o.amountCents, o.currency, o.intervalMonths, locale);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={t('cambioPlan.titulo')}
      ariaLabel={t('cambioPlan.titulo')}
      maxWidthClass="max-w-xl"
    >
      <div className="space-y-4 text-[0.9375rem] leading-relaxed" data-testid="cambio-plan-dialogo">
        {done ? (
          <>
            <div
              role="status"
              data-testid="cambio-plan-ok"
              className="space-y-1 rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-800"
            >
              <p>
                {t('cambioPlan.ok', { tier: done.option.tierName, price: perPeriod(done.option) })}
              </p>
              {done.result.charged ? (
                <p>
                  {t('cambioPlan.okCobrado', {
                    amount: money(done.result.charged.amountCents, done.result.charged.currency),
                  })}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('cambioPlan.cerrar')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {current ? (
              <p className="text-text">
                {current.tierName
                  ? t('cambioPlan.actualConNivel', {
                      tier: current.tierName,
                      price: perPeriod(current),
                    })
                  : t('cambioPlan.actualSinNivel', { price: perPeriod(current) })}
              </p>
            ) : null}

            <p className="text-sm font-semibold text-text">{t('cambioPlan.elige')}</p>
            <div className="space-y-4">
              {groupByTier(options.options).map((group) => (
                <section key={group.tierId} className="space-y-2">
                  <h3 className="text-base font-bold text-text">
                    {group.tierName}
                    {current?.tierId === group.tierId ? (
                      <span className="ml-2 text-sm font-medium text-text-muted">
                        ({t('cambioPlan.tuNivel')})
                      </span>
                    ) : null}
                  </h3>
                  <div role="radiogroup" aria-label={group.tierName} className="grid gap-2">
                    {group.options.map((option) => {
                      const isChosen = chosen?.planId === option.planId;
                      return (
                        <button
                          key={option.planId}
                          type="button"
                          role="radio"
                          aria-checked={isChosen}
                          disabled={busy}
                          data-testid={`cambio-plan-opcion-${option.planId}`}
                          onClick={() => void choose(option)}
                          className={cn(
                            'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left',
                            isChosen
                              ? 'border-brand-600 bg-brand-50'
                              : 'border-border bg-surface hover:border-border-strong',
                          )}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex flex-wrap items-baseline gap-2">
                              {option.compareAtCents &&
                              option.compareAtCents > option.amountCents ? (
                                <span className="text-sm text-text-subtle line-through">
                                  {money(option.compareAtCents, option.currency)}
                                </span>
                              ) : null}
                              <span className="font-semibold text-text">{perPeriod(option)}</span>
                            </span>
                            <span
                              className={cn(
                                'text-[13px]',
                                option.direction === 'upgrade'
                                  ? 'text-brand-700'
                                  : 'text-success-700',
                              )}
                            >
                              {option.direction === 'upgrade'
                                ? t('cambioPlan.sube')
                                : t('cambioPlan.baja')}
                            </span>
                          </span>
                          {option.isFeatured ? (
                            <span className="shrink-0 rounded-full bg-success-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                              {t('cambioPlan.recomendado')}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            {previewing ? (
              <p className="text-sm text-text-muted" aria-live="polite">
                {t('cambioPlan.calculando')}
              </p>
            ) : null}

            {chosen && preview ? (
              <div
                data-testid="cambio-plan-resumen"
                aria-live="polite"
                className="space-y-1.5 rounded-2xl border border-border bg-surface-2 p-4 text-sm text-text"
              >
                {preview.trialing ? (
                  <p>{t('cambioPlan.resumenPrueba', { price: perPeriod(chosen) })}</p>
                ) : (
                  <>
                    <p className="font-semibold">
                      {preview.amountDueNow > 0
                        ? t('cambioPlan.resumenCobroHoy', {
                            amount: money(preview.amountDueNow, preview.currency),
                          })
                        : t('cambioPlan.resumenSinCobroHoy')}
                    </p>
                    {preview.creditCents > 0 ? (
                      <p>
                        {t('cambioPlan.resumenCredito', {
                          amount: money(preview.creditCents, preview.currency),
                        })}
                      </p>
                    ) : null}
                    <p>{t('cambioPlan.resumenDespues', { price: perPeriod(chosen) })}</p>
                  </>
                )}
                {current?.tierId !== chosen.tierId ? (
                  <p>
                    {t('cambioPlan.resumenAcceso', { tier: chosen.tierName })}
                    {chosen.direction === 'downgrade' && current?.tierName
                      ? ` ${t('cambioPlan.resumenPierdes', { tier: current.tierName })}`
                      : ''}
                  </p>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t('cambioPlan.cancelar')}
              </Button>
              <Button
                type="button"
                disabled={!chosen || !preview || previewing || busy}
                data-testid="cambio-plan-confirmar"
                onClick={() => void confirm()}
              >
                {busy
                  ? t('cambioPlan.procesando')
                  : preview && !preview.trialing && preview.amountDueNow > 0
                    ? t('cambioPlan.confirmarPagando', {
                        amount: money(preview.amountDueNow, preview.currency),
                      })
                    : t('cambioPlan.confirmar')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
