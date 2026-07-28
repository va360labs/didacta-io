'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BuyCourseButton } from '@/components/buy-course-button';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { getCourseOffer, type CourseOffer } from '@/modules/billing/client';
import { getMembershipPage, formatCents, type MembershipPage } from '@/lib/membership';

/**
 * Panel de venta de un curso que el alumno todavía no tiene.
 *
 * Dos caminos de compra, como pidió el producto: pagar ese curso suelto, o
 * hacerse miembro y desbloquear todos. Ambos importes salen de la BD (producto
 * de mod.billing y planes de mod.subscriptions): si un dato no existe, la
 * sección correspondiente NO se pinta — nunca se inventa un precio.
 */
export function CourseSalesPanel({
  courseId,
  courseTitle,
}: {
  courseId: string;
  courseTitle: string;
}) {
  const [offer, setOffer] = useState<CourseOffer | null>(null);
  const [membership, setMembership] = useState<MembershipPage | null>(null);

  useEffect(() => {
    let aborted = false;
    void getCourseOffer(courseId).then((o) => {
      if (!aborted) setOffer(o);
    });
    // La membresía puede estar desactivada por el admin: en ese caso el
    // endpoint responde 404 y simplemente no ofrecemos esa vía.
    void getMembershipPage()
      .then((m) => {
        if (!aborted) setMembership(m);
      })
      .catch(() => {
        if (!aborted) setMembership(null);
      });
    return () => {
      aborted = true;
    };
  }, [courseId]);

  const plan = destacado(membership);
  const hayCompra = offer?.forSale === true && offer.unitAmount !== null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="font-display text-xl font-semibold text-text">Empieza este curso</h2>
            <p className="mt-1 text-sm text-text-muted">
              {hayCompra
                ? 'Acceso inmediato a todas las lecciones, con las actualizaciones incluidas.'
                : 'Este curso está incluido en la membresía. Si tu organización te dio un código de invitación, puedes canjearlo abajo.'}
            </p>
          </div>

          <ul className="grid gap-2.5 sm:grid-cols-2">
            <Beneficio texto="Acceso de por vida y actualizaciones" />
            <Beneficio texto="Certificado verificable al terminar" />
            <Beneficio texto="Aprendes a tu ritmo, desde cualquier dispositivo" />
            <Beneficio texto="Comunidad de alumnos y soporte" />
          </ul>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {hayCompra ? (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-display text-3xl font-bold tracking-tight text-text">
                  {formatCents(offer!.unitAmount!, offer!.currency ?? 'eur')}
                </span>
                {offer!.compareAtAmount ? (
                  <span className="text-base text-text-muted line-through">
                    {formatCents(offer!.compareAtAmount, offer!.currency ?? 'eur')}
                  </span>
                ) : null}
                {offer!.discountPercent ? (
                  <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-semibold text-success-700">
                    −{offer!.discountPercent}%
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-text-muted">Pago único · IVA incluido</p>
              <BuyCourseButton courseId={courseId} size="lg" className="w-full" />
            </CardContent>
          </Card>
        ) : null}

        {plan ? (
          <Card className="border-warning-200 bg-warning-50/60">
            <CardContent className="space-y-3 p-6">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-warning-800">
                <Icon name="sparkles" size={14} />
                Acceso total
              </div>
              <p className="text-sm text-text">
                Desbloquea <strong>todos los cursos</strong> por{' '}
                <strong>{formatCents(plan.amountCents, 'eur')}</strong>{' '}
                {periodo(plan.intervalMonths)}.
              </p>
              <Link
                href="/unete"
                className="inline-flex w-full items-center justify-center rounded-lg bg-warning-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-warning-700"
              >
                Ver membresías
              </Link>
            </CardContent>
          </Card>
        ) : null}

        {offer !== null && !hayCompra && !plan ? (
          <Card>
            <CardContent className="p-6 text-sm text-text-muted">
              Este curso todavía no está disponible para la compra. Si tienes un código de
              invitación, puedes canjearlo abajo.
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/**
 * CTAs del bloque de contenido bloqueado. Repite las dos vías de acceso justo
 * donde el alumno se topa con el muro, sin obligarle a volver arriba.
 */
export function LockedContentActions({ courseId }: { courseId: string }) {
  const [offer, setOffer] = useState<CourseOffer | null>(null);
  const [membership, setMembership] = useState<MembershipPage | null>(null);

  useEffect(() => {
    let aborted = false;
    void getCourseOffer(courseId).then((o) => {
      if (!aborted) setOffer(o);
    });
    void getMembershipPage()
      .then((m) => {
        if (!aborted) setMembership(m);
      })
      .catch(() => {
        if (!aborted) setMembership(null);
      });
    return () => {
      aborted = true;
    };
  }, [courseId]);

  const plan = destacado(membership);
  const hayCompra = offer?.forSale === true && offer.unitAmount !== null;
  if (!hayCompra && !plan) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      {hayCompra ? (
        <BuyCourseButton
          courseId={courseId}
          label={`Comprar por ${formatCents(offer!.unitAmount!, offer!.currency ?? 'eur')}`}
        />
      ) : null}
      {plan ? (
        <Link
          href="/unete"
          className="inline-flex items-center justify-center rounded-lg bg-warning-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-warning-700"
        >
          Desbloquea todo · Ver membresías
        </Link>
      ) : null}
    </div>
  );
}

function Beneficio({ texto }: { texto: string }) {
  return (
    <li className="flex items-start gap-2 text-sm text-text">
      <span className="mt-0.5 text-success-600">
        <Icon name="check" size={16} />
      </span>
      {texto}
    </li>
  );
}

/** Plan a destacar en la caja de acceso total: el marcado por el admin, o el más barato al mes. */
function destacado(page: MembershipPage | null) {
  const planes = page?.plans ?? [];
  if (planes.length === 0) return null;
  return (
    planes.find((p) => p.isFeatured) ??
    [...planes].sort(
      (a, b) => a.amountCents / (a.intervalMonths || 1) - b.amountCents / (b.intervalMonths || 1),
    )[0]
  );
}

function periodo(meses: number): string {
  if (meses === 1) return 'al mes';
  if (meses === 12) return 'al año';
  return `cada ${meses} meses`;
}
