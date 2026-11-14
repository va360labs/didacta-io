'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import {
  PriceEditor,
  TakeHomeEstimate,
  usePriceOptions,
} from '@/components/simple-price/price-editor';
import { START_HERE_CHANGED_EVENT } from '@/components/simple-shell/simple-shell';
import { formatStripeMinor } from '@/lib/i18n/format';
import { simpleModeApi, type CourseSaleView } from '@/lib/simple-mode';
import { cn } from '@/lib/utils';

/**
 * «Precio y venta» dentro del editor del curso (modo sencillo): el precio, lo
 * que le llega al creador, si está a la venta y el enlace para copiar.
 *
 * Es la MISMA oferta que «Empieza aquí»: si el curso es lo que vende el aula
 * (o va dentro de su membresía), cambiar el precio aquí es exactamente el paso
 * «Precio» (`PUT /admin/simple-mode/courses/:id/price` → `updatePrice`). Un
 * curso vendido aparte cambia su propia opción de compra.
 */
export function CourseSaleBlock({ courseId }: { courseId: string }) {
  const t = useTranslations('modoSencillo.curso.precioVenta');
  const locale = useLocale();
  const [view, setView] = useState<CourseSaleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    try {
      setView(await simpleModeApi.courseSale(courseId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [courseId]);
  useEffect(() => {
    void load();
  }, [load]);

  const { fees } = usePriceOptions(view?.price?.currency ?? 'eur');

  // Sin permiso o sin red: el editor sigue funcionando sin el bloque.
  if (failed || !view) return null;

  const price = view.price;
  const url = view.salePath && origin ? `${origin}${view.salePath}` : '';
  const onSale = view.state === 'on-sale';
  const period = price?.intervalMonths ? t('periodo', { n: price.intervalMonths }) : t('pagoUnico');

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el enlace sigue a la vista */
    }
  }

  const note =
    view.role === 'offer'
      ? t('notaOferta')
      : view.role === 'membership'
        ? t('notaMembresia', { plan: view.offerTitle ?? '' })
        : view.editable
          ? t('notaAparte')
          : view.offerTitle
            ? t('notaNoAparte', { oferta: view.offerTitle })
            : null;

  return (
    <section
      className="mt-5 rounded-2xl border border-border bg-surface p-4"
      aria-label={t('titulo')}
      data-testid="precio-venta-curso"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-text">{t('titulo')}</h2>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap',
            onSale
              ? 'bg-success-50 text-success-700'
              : view.state === 'not-purchasable'
                ? 'bg-warning-50 text-warning-700'
                : 'bg-bg-subtle text-text-subtle',
          )}
          data-testid="precio-venta-estado"
        >
          <Icon name={onSale ? 'globe' : 'lock'} size={12} />
          {onSale
            ? t('aLaVenta')
            : view.state === 'not-purchasable'
              ? t('noComprable')
              : t('sinPublicar')}
        </span>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          {editing && price !== undefined ? (
            <PriceEditor
              amountCents={price?.amountCents ?? 0}
              currency={price?.currency ?? 'eur'}
              amountLabel={t('precio')}
              currencyLabel={t('moneda')}
              saveLabel={t('guardar')}
              cancelLabel={t('cancelar')}
              invalidText={t('invalido')}
              errorText={t('error')}
              testId="precio-venta-editor"
              onCancel={() => setEditing(false)}
              onSave={async (next) => {
                setView(await simpleModeApi.updateCoursePrice(courseId, next));
                setEditing(false);
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
                // «Empieza aquí» y la barra cuentan el paso «Precio».
                window.dispatchEvent(new Event(START_HERE_CHANGED_EVENT));
              }}
            />
          ) : (
            <>
              <div className="text-sm text-text-muted">{t('precio')}</div>
              <div
                className="text-[22px] font-extrabold tracking-tight text-text tabular-nums"
                data-testid="precio-venta-importe"
              >
                {price
                  ? formatStripeMinor(price.amountCents, price.currency, { locale })
                  : t('sinPrecio')}
                {price ? (
                  <span className="ml-1.5 text-sm font-normal text-text-muted">{period}</span>
                ) : null}
              </div>
              {price ? (
                <TakeHomeEstimate
                  amount={price.amountCents}
                  currency={price.currency}
                  fees={fees}
                  className="mt-1"
                />
              ) : null}
              {view.editable ? (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-text hover:border-border-strong"
                  data-testid="precio-venta-cambiar"
                >
                  <Icon name="edit" size={15} />
                  {t('cambiar')}
                </button>
              ) : null}
              {saved ? (
                <p role="status" className="mt-2 text-sm font-semibold text-success-700">
                  {t('guardado')}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="min-w-0">
          {url ? (
            <>
              <div className="flex h-11 min-w-0 items-center gap-2 rounded-xl border border-border bg-bg-subtle px-3 text-[15px] text-text">
                <Icon name="link" size={16} />
                <span className="truncate" data-testid="precio-venta-enlace">
                  {url.replace(/^https?:\/\//, '')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copy()}
                  disabled={!onSale}
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-bg-subtle disabled:text-text-disabled"
                  data-testid="precio-venta-copiar"
                >
                  <Icon name="copy" size={15} />
                  {copied ? t('copiado') : t('copiar')}
                </button>
                <a
                  href={view.salePath ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-text hover:border-border-strong"
                >
                  <Icon name="eye" size={15} />
                  {t('verPagina')}
                </a>
              </div>
              {view.state === 'not-purchasable' ? (
                <p className="mt-2 text-[13px] text-warning-700">{t('notaNoComprable')}</p>
              ) : null}
            </>
          ) : view.role !== 'separate' ? (
            <p className="text-sm text-text-muted">
              {t('notaNoPublicado')}{' '}
              <Link href="/start" className="font-semibold text-brand-600 hover:underline">
                {t('irEmpieza')}
              </Link>
            </p>
          ) : null}
        </div>
      </div>
      {note ? <p className="mt-3 text-[13px] text-text-subtle">{note}</p> : null}
    </section>
  );
}
