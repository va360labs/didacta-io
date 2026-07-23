'use client';

/**
 * Vista de /unete — réplica del diseño de referencia (checkout 9x):
 * tarjeta de compra sticky con selector de planes (precio tachado, trial),
 * "Qué incluye" como PARRILLA visual de tarjetas de curso (portada, chip de
 * precio, duración), banner de ahorro, testimonial opcional y resumen.
 * El pago ocurre en Stripe Checkout (redirect). Cero datos inventados: todo
 * sale de la API real del tenant.
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
  nextPaymentDate,
  startMembershipCheckout,
  type MembershipCourse,
  type MembershipPage,
} from '@/lib/membership';

export function UneteView() {
  const params = useSearchParams();
  const status = params.get('status');
  const { tenant } = useTenantContext();

  const [page, setPage] = useState<MembershipPage | null>(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const session = useMemo(() => authStorage.getSession(), []);

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
      const { url } = await startMembershipCheckout(selected.id, session?.user.email);
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
  const nextDate = selected ? nextPaymentDate(selected.intervalMonths, trialDays) : null;
  const savings =
    selected?.compareAtCents && selected.compareAtCents > selected.amountCents
      ? selected.compareAtCents - selected.amountCents
      : null;
  const catalogSavings =
    page.standaloneTotalCents !== null &&
    selected &&
    page.standaloneTotalCents > selected.amountCents
      ? page.standaloneTotalCents - selected.amountCents
      : null;

  return (
    <div className="flex flex-col gap-12">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,29rem)_minmax(0,1fr)]">
        {/* ── Columna izquierda: tarjeta de compra (sticky en desktop) ── */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          {status === 'cancel' && (
            <div className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning-700">
              Pago cancelado. Puedes retomarlo cuando quieras — tu selección sigue aquí.
            </div>
          )}

          <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
            {/* Cabecera oscura tintada al brand con decoración sutil */}
            <div
              className="relative px-6 py-10 text-center"
              style={{
                background:
                  'linear-gradient(160deg, hsl(var(--brand-h) 45% 14%), hsl(var(--brand-h) 55% 22%))',
              }}
            >
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-20">
                <div className="absolute left-6 top-4 h-10 w-10 rounded-full border border-white/40" />
                <div className="absolute right-10 top-8 h-8 w-8 rounded-full border border-white/40" />
                <div className="absolute bottom-4 left-1/4 h-6 w-6 rounded-full border border-white/40" />
                <div className="absolute bottom-8 right-1/4 h-12 w-12 rounded-full border border-white/40" />
              </div>
              {tenant?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={tenant.logoUrl}
                  alt={tenant?.name ?? ''}
                  className="mx-auto mb-4 h-10 w-auto rounded-lg bg-white/90 p-1"
                />
              ) : null}
              <h1 className="relative text-2xl font-bold text-white">{page.headline}</h1>
            </div>

            <div className="flex flex-col gap-5 p-6">
              {page.subheadline ? (
                <p className="text-sm text-text-muted">{page.subheadline}</p>
              ) : null}

              {/* Selector de planes */}
              {page.plans.length === 0 ? (
                <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-muted">
                  Aún no hay planes disponibles.
                </p>
              ) : (
                <div role="radiogroup" aria-label="Planes" className="flex flex-col gap-2">
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
                            ? 'flex items-center gap-3 rounded-xl border-2 border-brand-500 bg-brand-50 px-4 py-3 text-left transition'
                            : 'flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition hover:border-border-strong'
                        }
                      >
                        <span
                          aria-hidden="true"
                          className={
                            isSelected
                              ? 'grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-brand-600 bg-brand-600'
                              : 'h-5 w-5 shrink-0 rounded-full border-2 border-border-strong'
                          }
                        >
                          {isSelected ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
                        </span>
                        <span className="flex flex-col">
                          <span className="text-base">
                            {plan.compareAtCents && plan.compareAtCents > plan.amountCents ? (
                              <span className="mr-2 text-sm text-text-subtle line-through">
                                {formatCents(plan.compareAtCents, plan.currency)}
                              </span>
                            ) : null}
                            <strong>{formatCents(plan.amountCents, plan.currency)}</strong>
                            <span className="ml-1 text-sm text-text-muted">
                              {intervalSuffix(plan.intervalMonths)}
                            </span>
                          </span>
                          <span className="text-xs text-text-muted">
                            {intervalDescription(plan.intervalMonths)}
                            {plan.trialDays > 0 ? ` · ${plan.trialDays} días de prueba gratis` : ''}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Total de hoy */}
              {selected ? (
                <div className="flex flex-col gap-1 border-t border-border pt-4">
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">Total hoy</span>
                    <span className="text-lg font-bold">
                      {trialDays > 0
                        ? formatCents(0, selected.currency)
                        : formatCents(selected.amountCents, selected.currency)}
                    </span>
                  </div>
                  {savings ? (
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-text-muted">Ahorro sobre el precio original</span>
                      <span className="font-semibold text-success-700">
                        −{formatCents(savings, selected.currency)}
                      </span>
                    </div>
                  ) : null}
                  <p className="text-xs text-text-muted">
                    {trialDays > 0
                      ? `${trialDays} días de prueba gratis. Primer cargo de ${formatCents(
                          selected.amountCents,
                          selected.currency,
                        )} el ${nextDateLabel(new Date(Date.now() + trialDays * 86_400_000))}.`
                      : `Impuestos incluidos. Próximo pago: ${nextDate ? nextDateLabel(nextDate) : '—'}.`}
                  </p>
                  <p className="text-xs text-text-subtle">
                    ¿Tienes un cupón? Podrás aplicarlo en la pantalla de pago.
                  </p>
                </div>
              ) : null}

              {payError && (
                <p className="rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700">
                  {payError}
                </p>
              )}

              <Button
                size="lg"
                className="w-full"
                disabled={!selected || paying}
                onClick={() => void checkout()}
              >
                <Icon name="lock" className="mr-2 h-4 w-4" />
                {paying ? 'Abriendo pago seguro…' : 'Continuar al pago seguro'}
              </Button>
              <p className="text-center text-xs text-text-subtle">
                Pago procesado por Stripe · Cancela cuando quieras desde tu cuenta
              </p>
            </div>
          </section>

          {/* Cuenta actual (si hay sesión) */}
          {session ? (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-100 font-semibold text-brand-700">
                {(session.user.name ?? session.user.email).slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                {session.user.name ? (
                  <p className="truncate font-semibold">{session.user.name}</p>
                ) : null}
                <p className="truncate text-sm text-text-muted">{session.user.email}</p>
              </div>
              <span className="text-xs text-text-subtle">Comprarás con esta cuenta</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface px-4 py-3">
              <p className="text-sm text-text-muted">Tu cuenta se crea automáticamente al pagar.</p>
              <Link href="/signin" className="text-sm font-semibold text-brand-700 hover:underline">
                ¿Ya tienes cuenta? Inicia sesión
              </Link>
            </div>
          )}
        </div>

        {/* ── Columna derecha: qué incluye (parrilla visual) ── */}
        <div className="flex flex-col gap-5">
          {page.courses.length > 0 && (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-xl font-bold">Qué incluye</h2>
                <span className="text-sm text-text-muted">
                  {page.courses.length} cursos · acceso completo
                </span>
              </div>

              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {page.courses.map((course) => (
                  <CourseCard key={course.id} course={course} />
                ))}
              </ul>

              {page.standaloneTotalCents !== null && selected ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-success/30 bg-success/5 px-5 py-4">
                  <div>
                    <p className="text-sm text-text-muted">Comprados por separado</p>
                    <p className="text-lg font-bold text-text-subtle line-through">
                      {formatCents(page.standaloneTotalCents)}
                    </p>
                  </div>
                  <Icon name="arrow-right" className="h-5 w-5 text-success-600" />
                  <div>
                    <p className="text-sm text-text-muted">Con la membresía</p>
                    <p className="text-lg font-bold text-success-700">
                      {formatCents(selected.amountCents, selected.currency)}
                      {intervalSuffix(selected.intervalMonths)}
                    </p>
                  </div>
                  {catalogSavings ? (
                    <span className="rounded-full bg-success-100 px-3 py-1 text-sm font-semibold text-success-700">
                      Ahorras {formatCents(catalogSavings)}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}

          {/* Testimonial (solo si el admin lo configuró) */}
          {page.testimonial && (
            <figure className="rounded-2xl border border-border bg-surface p-6">
              <p aria-hidden="true" className="text-4xl leading-none text-brand-300">
                &ldquo;
              </p>
              <blockquote className="text-[0.9375rem] leading-relaxed text-text">
                {page.testimonial.quote}
              </blockquote>
              <figcaption className="mt-4">
                <p className="text-sm font-semibold">{page.testimonial.author}</p>
                {page.testimonial.role ? (
                  <p className="text-xs text-text-muted">{page.testimonial.role}</p>
                ) : null}
              </figcaption>
            </figure>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Tarjeta visual de curso: portada 16:9 (con zoom sutil al hover), chip de
 * precio individual sobre la imagen, título y extracto (el API ya sirve texto
 * plano), y pie con duración + "Incluido".
 */
function CourseCard({ course }: { course: MembershipCourse }) {
  return (
    <li className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="relative aspect-video w-full overflow-hidden bg-brand-100">
        {course.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={course.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div
            className="grid h-full w-full place-items-center"
            style={{
              background:
                'linear-gradient(150deg, hsl(var(--brand-h) 60% 30%), hsl(var(--brand-h) 50% 18%))',
            }}
          >
            <Icon name="play" className="h-9 w-9 text-white/80" />
          </div>
        )}
        {course.amountCents !== null ? (
          <span className="absolute right-2 top-2 rounded-full bg-white/95 px-2.5 py-1 text-xs font-bold text-text shadow-sm">
            {formatCents(course.amountCents)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h3 className="line-clamp-2 font-semibold leading-snug">{course.title}</h3>
        {course.description ? (
          <p className="line-clamp-2 text-sm text-text-muted">{course.description}</p>
        ) : null}
        <div className="mt-auto flex items-center justify-between pt-2 text-xs text-text-muted">
          {course.estimatedMinutes ? (
            <span className="flex items-center gap-1">
              <Icon name="clock" className="h-3.5 w-3.5" />
              {durationLabel(course.estimatedMinutes)}
            </span>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1 font-semibold text-success-700">
            <Icon name="check" className="h-3.5 w-3.5" />
            Incluido
          </span>
        </div>
      </div>
    </li>
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

function nextDateLabel(d: Date): string {
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** 150 → "2 h 30 min"; 45 → "45 min". */
function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
