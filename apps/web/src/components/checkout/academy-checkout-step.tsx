'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * EL PASO DE PAGO, DENTRO DEL AULA.
 *
 * Antes, al pulsar «Comprar» el comprador salía a la página de Stripe y no
 * veía nada del aula en la que estaba comprando: ni su logo, ni su color, ni
 * quién vendía. Eso daba desconfianza justo en el momento de pagar. Ahora el
 * pago ocurre aquí, en la página de venta del aula y con su piel:
 *
 *  - cabecera con la marca del aula (logo y nombre) y «Pago seguro»;
 *  - a un lado, el resumen de la compra: portada, qué se compra, quién lo
 *    imparte y el total. El total es el DE LA SESIÓN de pago recién creada,
 *    no el que se pintó al cargar la ficha: si el precio cambió entretanto,
 *    lo que se enseña es lo que se va a cobrar;
 *  - al otro, el formulario de Stripe (embebido), y debajo quién vende, la
 *    política de desistimiento o de renovación y el contacto del aula.
 *
 * Ocupa la pantalla entera sobre la ficha (misma URL): «Volver» o el botón
 * atrás del navegador devuelven a la ficha tal como estaba.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { initialsOf } from '@/lib/academy-home';
import { formatCents } from '@/lib/membership';
import type { CheckoutSeller } from '@/lib/checkout';
import { CheckoutTrust } from './checkout-trust';
import { EmbeddedStripeCheckout } from './embedded-stripe-checkout';

const FONT = { fontFamily: 'var(--font-figtree), var(--font-sans)' } as const;

export interface AcademyBrand {
  name: string;
  logoUrl: string | null;
  logoDisplayMode?: 'logo_only' | 'logo_and_name';
}

export interface CheckoutItem {
  kind: 'course' | 'membership';
  title: string;
  /** Formato del curso o periodicidad del plan. */
  detail?: string | null;
  imageUrl?: string | null;
}

interface Props {
  academy: AcademyBrand;
  item: CheckoutItem;
  /** Total de la sesión (unidad mínima) y su moneda. */
  amount: number | null;
  currency: string | null;
  /** Una línea bajo el total (p. ej. «Hoy no se cobra nada: 7 días de prueba»). */
  totalNote?: string | null;
  seller: CheckoutSeller | null;
  clientSecret: string;
  publishableKey: string;
  onBack: () => void;
  /** El formulario no se pudo pintar: ir a la página de Stripe. */
  onUnavailable: () => void;
}

export function AcademyCheckoutStep({
  academy,
  item,
  amount,
  currency,
  totalNote,
  seller,
  clientSecret,
  publishableKey,
  onBack,
  onUnavailable,
}: Props) {
  const t = useTranslations('publicSite.pago');
  const locale = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const creator = seller?.creator?.name ?? null;

  // Pantalla nueva: el foco y la vista, arriba (lector de pantalla y móvil).
  useEffect(() => {
    window.scrollTo({ top: 0 });
    heading.current?.focus();
  }, []);

  // «Atrás» del navegador = «Volver a la ficha».
  const back = useCallback(() => onBack(), [onBack]);
  useEffect(() => {
    window.history.pushState({ didactaPago: true }, '');
    const onPop = () => back();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [back]);

  const total = amount !== null && currency ? formatCents(amount, currency, { locale }) : null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-bg-subtle text-text"
      style={FONT}
      data-testid="pago-en-el-aula"
      role="region"
      aria-label={t('regionLabel', { name: academy.name })}
    >
      {/* ── Cabecera con la marca del aula ── */}
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1140px] items-center gap-3 px-4 sm:px-6">
          <Brand academy={academy} />
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-50 px-3 py-1 text-[13px] font-semibold text-success-700"
            data-testid="pago-seguro"
          >
            <Icon name="lock" size={14} />
            {t('secureBadge')}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1140px] px-4 pb-16 pt-5 sm:px-6 lg:pt-8">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-semibold text-text-muted hover:text-text"
          data-testid="pago-volver"
        >
          <Icon name="arrow-left" size={16} />
          {t(item.kind === 'course' ? 'backToCourse' : 'backToMembership')}
        </button>

        <div className="mt-3 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:gap-10">
          {/* ── Resumen de la compra ── */}
          <section className="min-w-0 lg:sticky lg:top-24" aria-labelledby="pago-titulo">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-brand-700">
              {t('eyebrow')}
            </p>
            <h1
              id="pago-titulo"
              ref={heading}
              tabIndex={-1}
              className="mt-1 text-[26px] font-extrabold leading-tight tracking-[-0.01em] outline-none sm:text-[32px]"
            >
              {t('title')}
            </h1>

            <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
              <div className="flex gap-4 p-4 sm:block sm:p-0">
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-20 w-28 shrink-0 rounded-xl object-cover sm:aspect-[16/9] sm:h-auto sm:w-full sm:rounded-none"
                    data-testid="pago-portada"
                  />
                ) : null}
                <div className="min-w-0 sm:p-5">
                  <p className="text-[13px] font-semibold text-text-subtle">
                    {item.kind === 'course' ? t('kindCourse') : t('kindMembership')}
                  </p>
                  <h2
                    className="text-lg font-bold leading-snug text-text sm:text-xl"
                    data-testid="pago-producto"
                  >
                    {item.title}
                  </h2>
                  {item.detail ? (
                    <p className="mt-0.5 text-sm text-text-muted">{item.detail}</p>
                  ) : null}
                  <p className="mt-2 text-sm text-text-muted" data-testid="pago-vende">
                    {creator
                      ? t(item.kind === 'course' ? 'byCreatorCourse' : 'byCreatorMembership', {
                          creator,
                          name: academy.name,
                        })
                      : t('byAcademy', { name: academy.name })}
                  </p>
                </div>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-border bg-surface-2 px-4 py-3.5 sm:px-5">
                <span className="text-[15px] font-semibold">
                  {t('totalToday')}
                  <span className="ml-1.5 text-[13px] font-normal text-text-muted">
                    · {t('finalPrice')}
                  </span>
                </span>
                <span className="text-[22px] font-extrabold tabular-nums" data-testid="pago-total">
                  {total ?? '—'}
                </span>
              </div>
              {totalNote ? (
                <p className="border-t border-border px-4 py-2.5 text-[13px] leading-5 text-text-muted sm:px-5">
                  {totalNote}
                </p>
              ) : null}
            </div>

            <div className="mt-5 hidden rounded-2xl border border-border bg-surface p-5 lg:block">
              <CheckoutTrust kind={item.kind} seller={seller} fallbackName={academy.name} />
            </div>
          </section>

          {/* ── Formulario de Stripe ── */}
          <section
            className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-md"
            aria-label={t('formLabel')}
          >
            <EmbeddedStripeCheckout
              clientSecret={clientSecret}
              publishableKey={publishableKey}
              onUnavailable={onUnavailable}
            />
          </section>

          <div className="rounded-2xl border border-border bg-surface p-5 lg:hidden">
            <CheckoutTrust kind={item.kind} seller={seller} fallbackName={academy.name} />
          </div>
        </div>
      </main>
    </div>
  );
}

function Brand({ academy }: { academy: AcademyBrand }) {
  const wordmark = academy.logoUrl && academy.logoDisplayMode === 'logo_only';
  return (
    <span className="flex min-w-0 items-center gap-2.5" data-testid="pago-marca">
      {academy.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={academy.logoUrl}
          alt={wordmark ? academy.name : ''}
          className={
            wordmark ? 'h-9 max-w-[180px] object-contain' : 'h-9 w-9 rounded-lg object-contain'
          }
        />
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-600 text-sm font-extrabold text-white">
          {initialsOf(academy.name)}
        </span>
      )}
      {wordmark ? null : (
        <span className="truncate text-[17px] font-bold text-text">{academy.name}</span>
      )}
    </span>
  );
}
