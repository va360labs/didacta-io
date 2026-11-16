'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Un plan ya LISTO para pintar: el servidor (`AcademyHomeView`) pone los textos
 * traducidos y los importes formateados, así que este componente no necesita
 * ni i18n ni lógica de precios.
 */
export interface PlanOption {
  id: string;
  name: string;
  /** «Mensual», «Anual»… */
  intervalLabel: string;
  price: string;
  /** «/mes», «/año»… */
  suffix: string;
  /** Precio original tachado, si el plan lo tiene. */
  compare: string | null;
  /** «sale a 35,75 €/mes», solo en planes de más de un mes. */
  perMonth: string | null;
  /** «7 días de prueba gratis». */
  trial: string | null;
  featured: boolean;
  /** `/join?plan=<id>` con el `?ref=` del visitante. */
  href: string;
}

interface Props {
  plans: PlanOption[];
  /** A dónde va el botón si hay un solo plan (o ninguno): la compra, como siempre. */
  href: string;
  label: string;
  className: string;
  testId: string;
  title: string;
  closeLabel: string;
  bestValueLabel: string;
  planCtaLabel: string;
}

/**
 * El botón de acceso de la membresía. Con VARIOS planes abre el modal
 * «Selecciona tu plan» (cada plan lleva a la compra con ese plan elegido); con
 * uno solo es un enlace directo, igual que antes.
 *
 * Usa `<dialog>` nativo: Esc, foco atrapado y fondo inerte sin dependencias, y
 * sin los textos fijos en español del `Dialog` de la app (aquí hay es/en/pt).
 */
export function JoinPlansButton({
  plans,
  href,
  label,
  className,
  testId,
  title,
  closeLabel,
  bestValueLabel,
  planCtaLabel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // La portada pinta este botón dos veces (cabecera y tarjeta): ids propios.
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (plans.length < 2) {
    return (
      <a href={href} data-testid={testId} className={className}>
        {label}
      </a>
    );
  }

  const cols =
    plans.length === 2
      ? 'sm:grid-cols-2'
      : plans.length === 3
        ? 'sm:grid-cols-2 lg:grid-cols-3'
        : 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        className={className}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {/* El teclado ya lo cubre `<dialog>` (Esc): el clic en el fondo es solo un atajo de ratón. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <dialog
        ref={ref}
        data-testid="portada-planes"
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        // Clic en el fondo (el propio <dialog>, no su contenido): cierra.
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-4xl rounded-2xl border border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/50"
      >
        <div className="relative max-h-[85dvh] overflow-y-auto p-6 sm:p-8">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={closeLabel}
            className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-lg text-xl leading-none text-text-muted transition-colors hover:bg-bg-subtle hover:text-text"
          >
            ×
          </button>
          <h2
            id={titleId}
            className="mb-6 text-center text-[24px] font-extrabold tracking-[-0.01em]"
          >
            {title}
          </h2>
          <div className={`grid grid-cols-1 gap-5 pt-2 ${cols}`}>
            {plans.map((plan) => (
              <article
                key={plan.id}
                data-testid="portada-plan"
                className={
                  plan.featured
                    ? 'relative flex flex-col rounded-2xl border-2 border-brand-600 bg-surface p-5 shadow-md'
                    : 'relative flex flex-col rounded-2xl border border-border bg-surface p-5 shadow-sm'
                }
              >
                {plan.featured ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brand-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                    {bestValueLabel}
                  </span>
                ) : null}
                <p className="text-center text-xs font-bold uppercase tracking-[0.12em] text-text-muted">
                  {plan.intervalLabel}
                </p>
                <h3 className="mt-1 text-center text-base font-semibold">{plan.name}</h3>
                <div className="mt-4 text-center">
                  {plan.compare ? (
                    <div className="text-sm text-text-subtle line-through">{plan.compare}</div>
                  ) : null}
                  <div>
                    <span className="text-3xl font-extrabold">{plan.price}</span>
                    <span className="text-sm text-text-muted">{plan.suffix}</span>
                  </div>
                  {plan.perMonth ? (
                    <div className="mt-1 text-[13px] font-semibold">{plan.perMonth}</div>
                  ) : null}
                </div>
                <p className="my-5 flex-1 text-center text-sm text-text-muted">{plan.trial}</p>
                <a
                  href={plan.href}
                  data-testid="portada-plan-cta"
                  className="flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-3 text-center text-[16px] font-bold text-white shadow-sm transition-colors hover:bg-brand-700"
                >
                  {planCtaLabel}
                </a>
              </article>
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
