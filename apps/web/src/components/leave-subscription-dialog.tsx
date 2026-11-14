'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Darme de baja»: la oferta al darse de baja, para el alumno.
 *
 *   1. ¿Por qué te quieres ir? (lista corta + texto libre opcional).
 *   2. Si el aula lo ofrece y la suscripción puede: pausar 1–3 meses y/o un
 *      descuento. Debajo, la baja de siempre, con hasta cuándo conserva el
 *      acceso.
 *   3. Sin nada que ofrecer: confirmar la baja.
 *
 * Lo que se puede ofrecer lo decide la API (`GET …/leave`) con la configuración
 * del aula, el estado real en Stripe y lo que esta persona ya usó; aquí no se
 * decide nada. Cada opción es un solo `POST …/leave` con el motivo.
 */

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCentsExact, formatDate } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';
import {
  EXIT_REASONS,
  subscriptionsApi,
  type ExitReason,
  type LeaveOffer,
  type SubscriptionRow,
} from '@/modules/subscriptions';

type Step = 'loading' | 'reason' | 'offer' | 'confirm' | 'done';
type Outcome = 'PAUSED' | 'DISCOUNTED' | 'CANCELED';

export interface LeaveSubscriptionDialogProps {
  sub: SubscriptionRow;
  /** Nombre que ve el alumno (plan o curso). */
  itemName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tras decidir: la fila actualizada para repintar la tarjeta. */
  onDone: (updated: SubscriptionRow, outcome: Outcome) => void;
}

/** Fecha larga en el idioma de la pantalla («14 de diciembre de 2026»). */
function longDate(iso: string | null | undefined, locale: string): string | null {
  return iso ? formatDate(iso, { dateStyle: 'long', timeZone: 'UTC', locale }) : null;
}

export function LeaveSubscriptionDialog({
  sub,
  itemName,
  open,
  onOpenChange,
  onDone,
}: LeaveSubscriptionDialogProps): React.JSX.Element | null {
  const t = useTranslations('bajaRetencion');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [step, setStep] = useState<Step>('loading');
  const [offer, setOffer] = useState<LeaveOffer | null>(null);
  const [reason, setReason] = useState<ExitReason | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [months, setMonths] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ outcome: Outcome; row: SubscriptionRow } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('loading');
    setOffer(null);
    setReason(null);
    setReasonText('');
    setMonths(null);
    setError(null);
    setDone(null);
    const token = authStorage.getAccessToken();
    if (!token) return;
    subscriptionsApi
      .leaveOffer(token, sub.id)
      .then((o) => {
        setOffer(o);
        setMonths(o.pause?.months[0] ?? null);
        setStep('reason');
      })
      .catch((e: unknown) => {
        // Sin oferta se puede dar de baja igual: el motivo se pide siempre.
        setOffer(null);
        setStep('reason');
        if (e instanceof ApiHttpError && e.status !== 404) setError(apiErrorMessage(e, tErrors));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sub.id]);

  async function decide(choice: 'pause' | 'discount' | 'cancel') {
    const token = authStorage.getAccessToken();
    if (!token || !reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await subscriptionsApi.leave(token, sub.id, {
        reason,
        reasonText: reasonText.trim() || null,
        choice,
        ...(choice === 'pause' && months ? { pauseMonths: months } : {}),
      });
      setDone({ outcome: res.outcome, row: res.subscription });
      setStep('done');
      onDone(res.subscription, res.outcome);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('alumno.error'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  // La API dice hasta cuándo hay acceso (null en pausa: ya no lo hay). Sin
  // oferta (no contestó), la fecha de la fila.
  const accessEnds = longDate(offer ? offer.accessEndsAt : sub.currentPeriodEnd, locale);
  const hasOffers = !!offer && (!!offer.pause || !!offer.discount);
  const pauseEnds =
    offer?.pause && months ? longDate(offer.pause.endsAtByMonths[String(months)], locale) : null;
  const pauseStarts = longDate(offer?.pause?.startsAt, locale);
  const money = (cents: number, currency: string) =>
    formatCentsExact(cents, currency.toUpperCase(), { locale });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={t('alumno.titulo', { item: itemName })}
      ariaLabel={t('alumno.titulo', { item: itemName })}
      maxWidthClass="max-w-xl"
    >
      <div className="space-y-4 text-[0.9375rem] leading-relaxed" data-testid="baja-dialogo">
        {step === 'loading' ? (
          <p className="text-sm text-text-muted" aria-live="polite">
            {t('alumno.cargando')}
          </p>
        ) : null}

        {step === 'reason' ? (
          <>
            <fieldset className="space-y-2">
              <legend className="text-lg font-bold text-text">{t('alumno.pasoMotivo')}</legend>
              <p className="text-sm text-text-muted">{t('alumno.pasoMotivoAyuda')}</p>
              <div className="grid gap-2 pt-1 sm:grid-cols-2">
                {EXIT_REASONS.map((r) => (
                  <label
                    key={r}
                    data-testid={`baja-motivo-${r}`}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium',
                      reason === r
                        ? 'border-brand-600 bg-brand-50 text-text'
                        : 'border-border bg-surface text-text hover:border-border-strong',
                    )}
                  >
                    <input
                      type="radio"
                      name="baja-motivo"
                      value={r}
                      checked={reason === r}
                      onChange={() => setReason(r)}
                      className="accent-brand-600"
                    />
                    {t(`motivos.${r}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-1.5">
              <label htmlFor="baja-texto" className="block text-sm font-semibold text-text">
                {t('alumno.textoLibre')}
              </label>
              <textarea
                id="baja-texto"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder={t('alumno.textoLibrePlaceholder')}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                {t('alumno.quedarme')}
              </Button>
              <Button
                type="button"
                disabled={!reason}
                data-testid="baja-seguir"
                onClick={() => setStep(hasOffers ? 'offer' : 'confirm')}
              >
                {t('alumno.seguir')}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'offer' && offer ? (
          <>
            <div>
              <h3 className="text-lg font-bold text-text">{t('alumno.pasoOferta')}</h3>
              <p className="text-sm text-text-muted">{t('alumno.pasoOfertaAyuda')}</p>
            </div>

            {offer.pause && pauseStarts ? (
              <section
                className="space-y-3 rounded-2xl border border-border bg-surface p-4"
                data-testid="baja-oferta-pausa"
              >
                <h4 className="text-base font-bold text-text">{t('alumno.pausaTitulo')}</h4>
                <p className="text-sm text-text-muted">
                  {t('alumno.pausaTexto', { desde: pauseStarts, hasta: pauseEnds ?? '' })}
                </p>
                {offer.pause.months.length > 1 ? (
                  <div
                    role="radiogroup"
                    aria-label={t('alumno.pausaElegir')}
                    className="flex gap-2"
                  >
                    {offer.pause.months.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={months === m}
                        data-testid={`baja-pausa-${m}`}
                        onClick={() => setMonths(m)}
                        className={cn(
                          'h-10 rounded-xl border px-3 text-sm font-semibold',
                          months === m
                            ? 'border-brand-600 bg-brand-50 text-brand-700'
                            : 'border-border bg-surface text-text hover:border-border-strong',
                        )}
                      >
                        {t('alumno.pausaMeses', { n: m })}
                      </button>
                    ))}
                  </div>
                ) : null}
                <Button
                  type="button"
                  disabled={busy || !months}
                  data-testid="baja-pausar"
                  onClick={() => void decide('pause')}
                >
                  {busy ? t('alumno.procesando') : t('alumno.pausaBoton', { n: months ?? 1 })}
                </Button>
              </section>
            ) : null}

            {offer.discount ? (
              <section
                className="space-y-3 rounded-2xl border border-border bg-surface p-4"
                data-testid="baja-oferta-descuento"
              >
                <h4 className="text-base font-bold text-text">
                  {t('alumno.descuentoTitulo', { pct: offer.discount.percent })}
                </h4>
                <p className="text-sm text-text-muted">
                  {offer.discount.months
                    ? t('alumno.descuentoMeses', {
                        n: offer.discount.months,
                        despues: money(
                          offer.discount.discountedAmountCents,
                          offer.discount.currency,
                        ),
                        antes: money(offer.discount.amountCents, offer.discount.currency),
                      })
                    : t('alumno.descuentoUnaVez', {
                        despues: money(
                          offer.discount.discountedAmountCents,
                          offer.discount.currency,
                        ),
                        antes: money(offer.discount.amountCents, offer.discount.currency),
                      })}
                </p>
                <Button
                  type="button"
                  disabled={busy}
                  data-testid="baja-descuento"
                  onClick={() => void decide('discount')}
                >
                  {busy ? t('alumno.procesando') : t('alumno.descuentoBoton')}
                </Button>
              </section>
            ) : null}

            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-sm text-text-muted">
                {accessEnds
                  ? t('alumno.bajaTexto', { fecha: accessEnds })
                  : t('alumno.bajaTextoSinFecha')}
              </p>
              <div className="flex flex-wrap justify-between gap-2">
                <Button type="button" variant="ghost" onClick={() => setStep('reason')}>
                  {t('alumno.volver')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  data-testid="baja-darme-de-baja"
                  onClick={() => void decide('cancel')}
                >
                  {t('alumno.darmeDeBaja')}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {step === 'confirm' ? (
          <>
            <p className="text-text">
              {accessEnds
                ? t('alumno.bajaTexto', { fecha: accessEnds })
                : t('alumno.bajaTextoSinFecha')}
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('reason')}>
                {t('alumno.volver')}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  {t('alumno.quedarme')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  data-testid="baja-confirmar"
                  onClick={() => void decide('cancel')}
                >
                  {busy ? t('alumno.procesando') : t('alumno.confirmarBaja')}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {step === 'done' && done ? (
          <>
            <p
              role="status"
              data-testid="baja-listo"
              className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-800"
            >
              {done.outcome === 'PAUSED'
                ? t('alumno.listoPausa', {
                    desde: longDate(done.row.pauseStartsAt, locale) ?? '',
                    hasta: longDate(done.row.pauseEndsAt, locale) ?? '',
                  })
                : done.outcome === 'DISCOUNTED'
                  ? t('alumno.listoDescuento', { pct: offer?.discount?.percent ?? 0 })
                  : accessEnds
                    ? t('alumno.listoBaja', {
                        fecha: longDate(done.row.currentPeriodEnd, locale) ?? accessEnds,
                      })
                    : t('alumno.listoBajaSinFecha')}
            </p>
            <div className="flex justify-end">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('alumno.cerrar')}
              </Button>
            </div>
          </>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
