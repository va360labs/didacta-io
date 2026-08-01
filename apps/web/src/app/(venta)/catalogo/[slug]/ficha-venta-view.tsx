'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Ficha pública de venta: portada, descripción y las opciones de compra
 * reales del curso (precio único o multi-formato con destacada). El CTA
 * lanza el checkout ANÓNIMO de Stripe — la cuenta del comprador se crea
 * tras el pago con el email confirmado en la pasarela.
 *
 * El curso se resuelve por slug contra el catálogo público (un solo
 * endpoint); si no está a la venta o no existe, se ofrece volver al catálogo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { authStorage } from '@/lib/auth-storage';
import { useTenantContext } from '@/lib/tenant-context';
import { formatCents } from '@/lib/membership';
import {
  featuredOption,
  getPublicCatalog,
  startPublicCheckout,
  type CatalogCourse,
} from '@/lib/catalog';

function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function FichaVentaView() {
  const params = useParams<{ slug: string }>();
  const { tenant } = useTenantContext();

  const [course, setCourse] = useState<CatalogCourse | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  // Si hay sesión (alguien logueado llegó a la página pública), su email
  // precarga el checkout; el provisioning lo reconocerá y no duplicará cuenta.
  const session = useMemo(() => authStorage.getSession(), []);

  useEffect(() => {
    let cancelled = false;
    getPublicCatalog()
      .then((r) => {
        if (cancelled) return;
        const found = r.courses.find((c) => c.slug === params.slug) ?? null;
        setCourse(found);
        setSelectedId(found ? (featuredOption(found.options)?.id ?? null) : null);
      })
      .catch(() => {
        if (!cancelled) setCourse(null);
      });
    return () => {
      cancelled = true;
    };
  }, [params.slug]);

  const selected = course?.options.find((o) => o.id === selectedId) ?? null;

  const comprar = useCallback(async () => {
    if (!course || !selected) return;
    setPaying(true);
    setPayError(null);
    try {
      const { url } = await startPublicCheckout(course.id, {
        optionId: selected.id,
        email: session?.user.email,
      });
      window.location.assign(url);
    } catch {
      setPayError('No se pudo iniciar el pago. Inténtalo de nuevo en unos segundos.');
      setPaying(false);
    }
  }, [course, selected, session]);

  if (course === undefined) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-text-muted">
        Cargando…
      </div>
    );
  }

  if (course === null) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted">
          <Icon name="alert" className="h-6 w-6" />
        </span>
        <h1 className="text-xl font-bold">Curso no disponible</h1>
        <p className="text-text-muted">
          Este curso no está a la venta ahora mismo. Echa un vistazo al resto del catálogo.
        </p>
        <Button asChild variant="ghost">
          <Link href="/catalogo">Volver al catálogo</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-5xl items-start gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(300px,24rem)]">
      {/* ══ FICHA ══ */}
      <div className="space-y-6">
        <nav className="text-sm text-text-subtle">
          <Link href="/catalogo" className="hover:underline">
            Cursos
          </Link>{' '}
          / <span className="text-text-muted">{course.title}</span>
        </nav>

        {course.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={course.thumbnailUrl}
            alt=""
            className="aspect-video w-full rounded-2xl border border-border object-cover"
          />
        ) : null}

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-text-subtle">
            {course.category ? (
              <span className="rounded-full bg-surface-3 px-2.5 py-0.5 text-text-muted">
                {course.category}
              </span>
            ) : null}
            {course.estimatedMinutes ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="clock" size={14} />
                {durationLabel(course.estimatedMinutes)}
              </span>
            ) : null}
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-text">
            {course.title}
          </h1>
          {course.description ? (
            <p className="whitespace-pre-line leading-relaxed text-text-muted">
              {course.description}
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-muted">
          Tras el pago recibirás un email para <strong>definir tu contraseña</strong> y entrar
          directamente al curso. Si ya tienes cuenta, el curso se añade a la tuya.
        </div>
      </div>

      {/* ══ CAJA DE COMPRA (sticky) ══ */}
      <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
          <div
            className="relative px-6 py-5 text-center"
            style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
          >
            {tenant?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tenant.logoUrl}
                alt={tenant?.name ?? ''}
                className="mx-auto h-9 w-auto rounded-lg bg-white/95 p-1"
              />
            ) : (
              <span className="text-lg font-extrabold text-white">{tenant?.name ?? ''}</span>
            )}
            <p className="mt-2 text-sm text-white/70">Pago único · Acceso inmediato</p>
          </div>

          <div className="flex flex-col gap-4 p-6">
            {course.options.length > 1 ? (
              <div role="radiogroup" aria-label="Formatos" className="flex flex-col gap-2.5">
                {course.options.map((option) => {
                  const isSelected = option.id === selectedId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedId(option.id)}
                      className={
                        isSelected
                          ? 'rounded-xl border-2 border-brand-600 bg-brand-50 px-4 py-3 text-left'
                          : 'rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-surface-2'
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-text">
                          {option.name || 'Curso'}
                          {option.isFeatured ? (
                            <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                              Recomendado
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-baseline gap-1.5">
                          {option.compareAtAmount ? (
                            <span className="text-xs text-text-subtle line-through">
                              {formatCents(option.compareAtAmount, option.currency)}
                            </span>
                          ) : null}
                          <span className="font-bold text-text">
                            {formatCents(option.unitAmount, option.currency)}
                          </span>
                        </span>
                      </div>
                      {option.perks.length > 0 ? (
                        <ul className="mt-2 space-y-1">
                          {option.perks.map((perk) => (
                            <li
                              key={perk}
                              className="flex items-start gap-1.5 text-xs text-text-muted"
                            >
                              <Icon name="check" size={13} className="mt-0.5 shrink-0" />
                              {perk}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : selected ? (
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-3xl font-bold text-text" data-testid="precio-curso">
                  {formatCents(selected.unitAmount, selected.currency)}
                </span>
                {selected.compareAtAmount ? (
                  <span className="text-text-subtle line-through">
                    {formatCents(selected.compareAtAmount, selected.currency)}
                  </span>
                ) : null}
                {selected.discountPercent ? (
                  <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-semibold text-success-700">
                    −{selected.discountPercent}%
                  </span>
                ) : null}
              </div>
            ) : null}

            {payError ? (
              <p className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
                {payError}
              </p>
            ) : null}

            <Button size="lg" onClick={comprar} disabled={!selected || paying}>
              {paying ? 'Abriendo pago seguro…' : 'Comprar ahora'}
            </Button>
            <p className="text-center text-xs text-text-subtle">
              Pago seguro con Stripe. IVA incluido.
            </p>
          </div>
        </section>

        <p className="text-center text-sm text-text-subtle">
          ¿Ya tienes cuenta?{' '}
          <Link href="/signin" className="font-medium text-brand-700 hover:underline">
            Inicia sesión
          </Link>{' '}
          para comprar desde tu ficha del curso.
        </p>
      </aside>
    </div>
  );
}
