'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Vista de /unete — estructura del mockup de referencia del operador:
 *   - Sidebar de pago STICKY: cabecera oscura con logo del tenant, selector de
 *     planes (tachado + badge "Mejor valor"), Total hoy, ahorro, primer cargo,
 *     cupón, CTA y caja de cuenta.
 *   - Catálogo: cabecera con contador real, tiles con DATOS REALES (alumnos
 *     activos, cursos, horas), chips de filtrado por categoría real, parrilla
 *     de tarjetas con DETALLE EXPANDIBLE (módulos, profesor, precio suelto),
 *     banner de ahorro, FAQ y testimonial (solo si el admin lo configuró).
 * Cero datos inventados: todo sale de la API del tenant. El pago es Stripe
 * Checkout hosted (redirect).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { useTenantContext } from '@/lib/tenant-context';
import {
  formatCents,
  getMembershipPage,
  intervalDescription,
  intervalSuffix,
  startMembershipCheckout,
  type MembershipCourse,
  type MembershipPage,
} from '@/lib/membership';
import { getStoredReferralCode, referralsApi, storeReferralCode } from '@/lib/referrals';

/** Paleta rotativa (por hash del nombre) para los pills de categoría. */
const CATEGORY_STYLES = [
  'bg-brand-100 text-brand-700',
  'bg-success-100 text-success-700',
  'bg-warning-100 text-warning-700',
  'bg-surface-3 text-text-muted',
];
function categoryStyle(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_STYLES[h % CATEGORY_STYLES.length]!;
}

/** 150 → "2 h 30 min"; 45 → "45 min". */
function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function nextDateLabel(d: Date): string {
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** FAQ estática: afirmaciones verificables del producto (no datos inventados). */
const FAQS: Array<{ q: string; a: string }> = [
  {
    q: '¿Puedo cancelar cuando quiera?',
    a: 'Sí. Cancelas desde tu cuenta, en la pestaña Suscripción, sin permanencia.',
  },
  {
    q: '¿Qué pasa cuando termina la prueba gratis?',
    a: 'Se activa el plan que elegiste y Stripe realiza el primer cargo en la fecha indicada.',
  },
  {
    q: '¿Cómo accedo después de pagar?',
    a: 'Si aún no tienes cuenta, recibirás un email con un enlace para definir tu contraseña y entrar directamente.',
  },
  {
    q: '¿Cómo se procesa el pago?',
    a: 'El pago lo procesa Stripe de forma segura. Puedes aplicar un cupón en la pantalla de pago.',
  },
];

export function UneteView() {
  const params = useSearchParams();
  const status = params.get('status');
  const { tenant } = useTenantContext();

  const [page, setPage] = useState<MembershipPage | null>(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('Todos');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const session = useMemo(() => authStorage.getSession(), []);

  // Captura del enlace de referido (?ref=CODE): persiste el código (last-click,
  // TTL de la ventana configurada) y registra el clic. Best-effort: un código
  // inválido o el programa apagado no afectan en nada a la página de venta.
  useEffect(() => {
    const ref = params.get('ref')?.trim().toLowerCase();
    if (!ref || !/^[a-z0-9]{3,32}$/.test(ref)) return;
    storeReferralCode(ref);
    referralsApi
      .track(ref)
      .then(({ attributionWindowDays }) => storeReferralCode(ref, attributionWindowDays))
      .catch(() => {
        // Silencioso: el clic es métrica, nunca UX.
      });
  }, [params]);

  useEffect(() => {
    let cancelled = false;
    getMembershipPage()
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        const featured = p.plans.find((x) => x.isFeatured) ?? p.plans[p.plans.length - 1];
        setSelectedId(featured?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiHttpError && err.status === 404) setNotAvailable(true);
        else setLoadError('No se pudo cargar la página. Recarga para reintentar.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = page?.plans.find((p) => p.id === selectedId) ?? null;

  const checkout = useCallback(async () => {
    if (!selected) return;
    setPaying(true);
    setPayError(null);
    try {
      const { url } = await startMembershipCheckout(
        selected.id,
        session?.user.email,
        getStoredReferralCode() ?? undefined,
      );
      window.location.assign(url);
    } catch {
      setPayError('No se pudo iniciar el pago. Inténtalo de nuevo en unos segundos.');
      setPaying(false);
    }
  }, [selected, session]);

  // ── Estados de retorno del checkout ────────────────────────────────────────
  if (status === 'success') {
    return (
      <ReturnCard tone="success" title="¡Pago recibido!">
        {session ? (
          <>
            <p className="text-text-muted">
              Tu membresía se está activando. En unos segundos tendrás acceso a todos los cursos.
            </p>
            <Link href="/cursos" className="inline-block">
              <Button>Ir a mis cursos</Button>
            </Link>
          </>
        ) : (
          <>
            <p className="text-text-muted">
              Revisa tu correo: te hemos enviado un enlace para{' '}
              <strong>definir tu contraseña</strong> y entrar a la plataforma. Si no lo ves en unos
              minutos, mira en spam o usa &ldquo;¿Olvidaste tu contraseña?&rdquo; en el inicio de
              sesión.
            </p>
            <Link href="/signin" className="inline-block">
              <Button variant="ghost">Ir al inicio de sesión</Button>
            </Link>
          </>
        )}
      </ReturnCard>
    );
  }

  if (notAvailable) {
    return (
      <ReturnCard tone="muted" title="Membresía no disponible">
        <p className="text-text-muted">
          Esta comunidad no tiene la compra de membresía activada ahora mismo.
        </p>
        <Link href="/signin" className="inline-block">
          <Button variant="ghost">Iniciar sesión</Button>
        </Link>
      </ReturnCard>
    );
  }

  if (loadError) {
    return (
      <ReturnCard tone="muted" title="Algo no fue bien">
        <p className="text-text-muted">{loadError}</p>
      </ReturnCard>
    );
  }

  if (!page) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-text-muted">
        Cargando…
      </div>
    );
  }

  const trialDays = selected?.trialDays ?? 0;
  const savings =
    selected?.compareAtCents && selected.compareAtCents > selected.amountCents
      ? selected.compareAtCents - selected.amountCents
      : null;
  const firstChargeDate = new Date(Date.now() + trialDays * 86_400_000);
  const catalogSavings =
    page.standaloneTotalCents !== null &&
    selected &&
    page.standaloneTotalCents > selected.amountCents
      ? page.standaloneTotalCents - selected.amountCents
      : null;

  // Chips de filtrado: categorías REALES presentes en el catálogo.
  // Los precios de referencia de cursos no llevan moneda propia: se muestran
  // comparados contra los planes, así que heredan la del plan elegido (o la
  // del primero de la página).
  const pageCurrency = selected?.currency ?? page.plans[0]?.currency ?? 'eur';

  const categories = [
    ...new Set(page.courses.map((c) => c.category).filter((x): x is string => !!x)),
  ];
  const chips = categories.length > 0 ? ['Todos', ...categories] : [];
  const visibleCourses =
    filter === 'Todos' ? page.courses : page.courses.filter((c) => c.category === filter);

  const totalHours = Math.round(page.stats.totalMinutes / 60);

  return (
    <div className="grid items-start gap-9 lg:grid-cols-[minmax(300px,26rem)_minmax(0,1fr)]">
      {/* ══ SIDEBAR DE PAGO (sticky) ══ */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-6">
        {status === 'cancel' && (
          <div className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning-700">
            Pago cancelado. Puedes retomarlo cuando quieras — tu selección sigue aquí.
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
          {/* Cabecera oscura con brillo radial tintado al brand */}
          <div
            className="relative px-7 py-7 text-center"
            style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(120% 90% at 50% -20%, hsl(var(--brand-h) 63% 55% / 0.28), transparent 60%)',
              }}
            />
            <div className="relative">
              {tenant?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={tenant.logoUrl}
                  alt={tenant?.name ?? ''}
                  className="mx-auto h-11 w-auto rounded-lg bg-white/95 p-1"
                />
              ) : tenant?.name ? (
                <span className="inline-flex items-center rounded-lg border border-white/15 bg-black/25 px-4 py-2 text-xl font-extrabold text-white">
                  {tenant.name}
                </span>
              ) : null}
              <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">{page.headline}</h1>
              {page.subheadline ? (
                <p className="mx-4 mt-2 text-sm leading-5 text-white/70">{page.subheadline}</p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col p-6">
            {/* Selector de planes */}
            {page.plans.length === 0 ? (
              <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-muted">
                Aún no hay planes disponibles.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Planes" className="flex flex-col gap-2.5">
                {page.plans.map((plan) => {
                  const isSelected = plan.id === selectedId;
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedId(plan.id)}
                      className={
                        isSelected
                          ? 'flex items-center gap-3.5 rounded-xl border-2 border-brand-500 bg-brand-50 px-4 py-3.5 text-left transition'
                          : 'flex items-center gap-3.5 rounded-xl border border-border bg-surface px-4 py-3.5 text-left transition hover:border-border-strong'
                      }
                    >
                      <span
                        aria-hidden="true"
                        className={
                          isSelected
                            ? 'grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-brand-600'
                            : 'h-5 w-5 shrink-0 rounded-full border-2 border-border-strong'
                        }
                      >
                        {isSelected ? (
                          <span className="h-2.5 w-2.5 rounded-full bg-brand-600" />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex flex-wrap items-baseline gap-2">
                          {plan.compareAtCents && plan.compareAtCents > plan.amountCents ? (
                            <span className="text-sm text-text-subtle line-through">
                              {formatCents(plan.compareAtCents, plan.currency)}
                            </span>
                          ) : null}
                          <span className="text-xl font-bold">
                            {formatCents(plan.amountCents, plan.currency)}
                          </span>
                          <span className="text-sm text-text-muted">
                            {intervalSuffix(plan.intervalMonths)}
                          </span>
                        </span>
                        <span className="mt-0.5 text-[13px] text-text-muted">
                          {intervalDescription(plan.intervalMonths)}
                          {plan.trialDays > 0
                            ? ` · ${plan.trialDays} ${plan.trialDays === 1 ? 'día' : 'días'} de prueba gratis`
                            : ''}
                        </span>
                      </span>
                      {plan.isFeatured ? (
                        <span className="shrink-0 rounded-full bg-success-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                          Mejor valor
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}

            {selected ? (
              <>
                <div className="my-5 h-px bg-border-soft" />
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">Total hoy</span>
                  <span className="text-[22px] font-extrabold">
                    {trialDays > 0
                      ? formatCents(0, selected.currency)
                      : formatCents(selected.amountCents, selected.currency)}
                  </span>
                </div>
                {savings ? (
                  <div className="mt-2 flex justify-between text-sm">
                    <span className="text-text-muted">Ahorro sobre el precio original</span>
                    <span className="font-bold text-success-700">
                      −{formatCents(savings, selected.currency)}
                    </span>
                  </div>
                ) : null}
                <p className="mt-3.5 text-[13px] leading-5 text-text-muted">
                  {trialDays > 0
                    ? `${trialDays} ${trialDays === 1 ? 'día' : 'días'} de prueba gratis. Primer cargo de ${formatCents(
                        selected.amountCents,
                        selected.currency,
                      )} el ${nextDateLabel(firstChargeDate)}.`
                    : `Impuestos incluidos. Primer cargo hoy.`}
                </p>
                {trialDays > 0 && page.trialLessonLimit > 0 ? (
                  <p className="mt-1.5 text-[13px] leading-5 text-text-muted">
                    Durante la prueba ves las primeras {page.trialLessonLimit} clases de cada curso;
                    al pagar se desbloquea todo.
                  </p>
                ) : null}
                <p className="mt-1.5 text-[13px] text-text-muted">
                  ¿Tienes un cupón? Podrás aplicarlo en la pantalla de pago.
                </p>
              </>
            ) : null}

            {payError && (
              <p className="mt-3 rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700">
                {payError}
              </p>
            )}

            <Button
              size="lg"
              className="mt-4 w-full"
              disabled={!selected || paying}
              onClick={() => void checkout()}
            >
              <Icon name="lock" className="mr-2 h-4 w-4" />
              {paying ? 'Abriendo pago seguro…' : 'Continuar al pago seguro'}
            </Button>
            <p className="mt-3 text-center text-xs text-text-subtle">
              Pago procesado por Stripe · Cancela cuando quieras
            </p>
          </div>
        </section>

        {/* Caja de cuenta */}
        {session ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3.5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-100 font-bold text-brand-700">
              {(session.user.name ?? session.user.email).slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              {session.user.name ? (
                <p className="truncate text-sm font-semibold">{session.user.name}</p>
              ) : null}
              <p className="truncate text-[13px] text-text-muted">{session.user.email}</p>
            </div>
            <span className="text-right text-xs leading-4 text-text-subtle">
              Comprarás con
              <br />
              esta cuenta
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3.5">
            <p className="text-sm text-text-muted">Tu cuenta se crea automáticamente al pagar.</p>
            <Link href="/signin" className="text-sm font-semibold text-brand-700 hover:underline">
              ¿Ya tienes cuenta?
            </Link>
          </div>
        )}
      </div>

      {/* ══ CATÁLOGO ══ */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-[28px] font-bold tracking-tight">
              Todo lo que incluye tu membresía
            </h2>
            <p className="mt-2 text-[15px] text-text-muted">
              Filtra por tema y abre el curso que te interese para ver el detalle completo.
            </p>
          </div>
          <span className="whitespace-nowrap text-sm text-text-muted">
            {page.courses.length} {page.courses.length === 1 ? 'curso' : 'cursos'} · acceso completo
          </span>
        </div>

        {/* Tiles con datos REALES del tenant */}
        <div className="my-5 flex flex-wrap gap-3">
          {page.stats.activeMembers > 0 && (
            <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-surface p-4">
              <div className="text-[26px] font-bold">{page.stats.activeMembers}</div>
              <div className="mt-0.5 text-[13px] text-text-muted">
                {page.stats.activeMembers === 1 ? 'alumno activo' : 'alumnos activos'}
              </div>
            </div>
          )}
          <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-surface p-4">
            <div className="text-[26px] font-bold">{page.courses.length}</div>
            <div className="mt-0.5 text-[13px] text-text-muted">
              {page.courses.length === 1 ? 'curso incluido' : 'cursos incluidos'}
            </div>
          </div>
          {totalHours > 0 && (
            <div className="min-w-[150px] flex-1 rounded-xl border border-border bg-surface p-4">
              <div className="text-[26px] font-bold">+{totalHours} h</div>
              <div className="mt-0.5 text-[13px] text-text-muted">de formación práctica</div>
            </div>
          )}
        </div>

        {/* Chips de filtrado por categoría real */}
        {chips.length > 1 && (
          <div className="mb-5 flex flex-wrap gap-2">
            {chips.map((chip) => {
              const on = filter === chip;
              return (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setFilter(chip)}
                  className={
                    on
                      ? 'rounded-full border border-brand-600 bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white transition'
                      : 'rounded-full border border-border bg-surface px-4 py-2 text-[13px] font-semibold text-text-muted transition hover:border-border-strong'
                  }
                >
                  {chip}
                </button>
              );
            })}
          </div>
        )}

        {/* Parrilla con detalle expandible */}
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleCourses.map((course) => {
            const open = openCourseId === course.id;
            return (
              <CourseCardWithDetail
                key={course.id}
                course={course}
                currency={pageCurrency}
                open={open}
                onToggle={() => setOpenCourseId(open ? null : course.id)}
              />
            );
          })}
        </div>

        {/* Banner de ahorro */}
        {page.standaloneTotalCents !== null && selected ? (
          <div className="mt-6 flex flex-wrap items-center gap-6 rounded-2xl border border-border bg-surface px-6 py-5">
            <div>
              <div className="text-[13px] text-text-muted">Comprados por separado</div>
              <div className="text-[22px] font-bold text-text-subtle line-through">
                {formatCents(page.standaloneTotalCents, selected.currency)}
              </div>
            </div>
            <Icon name="arrow-right" className="h-6 w-6 text-success-600" />
            <div>
              <div className="text-[13px] text-text-muted">Con la membresía</div>
              <div className="text-[22px] font-bold">
                {formatCents(selected.amountCents, selected.currency)}
                {intervalSuffix(selected.intervalMonths)}
              </div>
            </div>
            {catalogSavings ? (
              <span className="ml-auto rounded-full bg-success-100 px-4 py-2.5 text-sm font-bold text-success-700">
                Ahorras {formatCents(catalogSavings, selected.currency)}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* FAQ */}
        <div className="mt-8">
          <h3 className="mb-4 text-xl font-bold">Preguntas frecuentes</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {FAQS.map((faq) => (
              <div key={faq.q} className="rounded-xl border border-border bg-surface px-5 py-4">
                <div className="mb-1.5 text-[15px] font-semibold">{faq.q}</div>
                <div className="text-sm leading-[21px] text-text-muted">{faq.a}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Testimonial oscuro (solo si el admin lo configuró) */}
        {page.testimonial && (
          <figure
            className="relative mt-6 overflow-hidden rounded-2xl px-8 py-7"
            style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(90% 120% at 100% 0%, hsl(var(--brand-h) 63% 55% / 0.22), transparent 55%)',
              }}
            />
            <div className="relative">
              <div
                aria-hidden="true"
                className="text-[40px] font-extrabold leading-none"
                style={{ color: 'hsl(var(--brand-h) 63% 55%)' }}
              >
                &ldquo;
              </div>
              <blockquote className="mb-4 mt-2 max-w-3xl text-[17px] leading-7 text-white/90">
                {page.testimonial.quote}
              </blockquote>
              <figcaption>
                <div className="text-[15px] font-semibold text-white">
                  {page.testimonial.author}
                </div>
                {page.testimonial.role ? (
                  <div className="text-[13px] text-white/55">{page.testimonial.role}</div>
                ) : null}
              </figcaption>
            </div>
          </figure>
        )}
      </div>
    </div>
  );
}

/**
 * Tarjeta de curso + fila de detalle expandible (a ancho completo de la
 * parrilla, como en el mockup). Todo el contenido del detalle es real:
 * descripción sin HTML, módulos, profesor y precio suelto configurado.
 */
function CourseCardWithDetail({
  course,
  currency,
  open,
  onToggle,
}: {
  course: MembershipCourse;
  /** Moneda de los planes de la página: los precios sueltos se comparan contra ellos. */
  currency: string;
  open: boolean;
  onToggle: () => void;
}) {
  const meta = [
    course.estimatedMinutes ? durationLabel(course.estimatedMinutes) : null,
    course.moduleCount > 0
      ? `${course.moduleCount} ${course.moduleCount === 1 ? 'módulo' : 'módulos'}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={
          open
            ? 'group overflow-hidden rounded-2xl border-2 border-brand-500 bg-surface text-left shadow-sm transition'
            : 'group overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md'
        }
      >
        <div
          className="relative h-[130px] w-full overflow-hidden"
          style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
        >
          {course.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={course.thumbnailUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <Icon name="play" className="h-8 w-8 text-white/70" />
            </div>
          )}
          {course.amountCents !== null ? (
            <span className="absolute right-2.5 top-2.5 rounded-lg bg-black/75 px-2.5 py-1 text-xs font-bold text-white">
              {formatCents(course.amountCents, currency)}
            </span>
          ) : null}
        </div>
        <div className="p-4">
          {course.category ? (
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${categoryStyle(course.category)}`}
            >
              {course.category}
            </span>
          ) : null}
          <div className="mb-1.5 mt-2.5 text-base font-semibold leading-[22px]">{course.title}</div>
          {meta ? <div className="text-[13px] text-text-muted">{meta}</div> : null}
          <div className="mt-3.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[13px] font-bold text-success-700">
              <Icon name="check" className="h-3.5 w-3.5" />
              Incluido
            </span>
            <span className="flex items-center gap-1 text-[13px] font-semibold text-brand-700">
              {open ? 'Ocultar' : 'Ver detalle'}
              <Icon
                name="chevron-down"
                className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              />
            </span>
          </div>
        </div>
      </button>

      {open && (
        <div className="col-span-full flex flex-wrap gap-6 rounded-2xl border border-brand-200 bg-surface-2 p-6">
          <div
            className="h-[158px] w-[280px] shrink-0 overflow-hidden rounded-xl"
            style={{ backgroundColor: 'hsl(var(--brand-h) 52% 11%)' }}
          >
            {course.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <Icon name="play" className="h-9 w-9 text-white/70" />
              </div>
            )}
          </div>
          <div className="min-w-[280px] flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              {course.category ? (
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${categoryStyle(course.category)}`}
                >
                  {course.category}
                </span>
              ) : null}
              {meta ? <span className="text-[13px] text-text-muted">{meta}</span> : null}
            </div>
            <h4 className="mb-2 mt-3 text-xl font-bold">{course.title}</h4>
            {course.description ? (
              <p className="mb-3.5 max-w-2xl text-sm leading-[22px]">{course.description}</p>
            ) : null}
            {course.moduleTitles.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {course.moduleTitles.map((title) => (
                  <span
                    key={title}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-brand-700"
                  >
                    <Icon name="check" className="h-3 w-3 text-success-600" />
                    {title}
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
              {course.teacherName ? (
                <span className="text-[13px] text-text-muted">
                  Impartido por{' '}
                  <span className="font-semibold text-text">{course.teacherName}</span>
                </span>
              ) : null}
              {course.amountCents !== null ? (
                <span className="text-[13px] text-text-subtle line-through">
                  Suelto {formatCents(course.amountCents, currency)}
                </span>
              ) : null}
              <span className="flex items-center gap-1.5 text-[13px] font-bold text-success-700">
                <Icon name="check" className="h-3.5 w-3.5" />
                Incluido en tu membresía
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ReturnCard({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'muted';
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
      <span
        className={
          tone === 'success'
            ? 'grid h-12 w-12 place-items-center rounded-full bg-success-100 text-success-700'
            : 'grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-muted'
        }
      >
        <Icon name={tone === 'success' ? 'check' : 'alert'} className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
    </div>
  );
}
