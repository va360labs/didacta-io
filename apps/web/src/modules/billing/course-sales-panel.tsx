'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BuyCourseButton } from '@/components/buy-course-button';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { getCourseOffer, type CourseOffer, type CourseOfferOption } from '@/modules/billing/client';
import { getMembershipPage, formatCents, type MembershipPage } from '@/lib/membership';

/**
 * Panel de venta de un curso que el alumno todavía no tiene.
 *
 * Tres caminos, de menos a más compromiso: comprar el curso (en el formato que
 * elija, si se vende en varios), o hacerse miembro y desbloquearlos todos.
 *
 * Todos los importes salen de la BD — el del curso de mod.billing, los planes
 * de mod.subscriptions. Si un dato no existe, su sección no se pinta: nunca se
 * inventa un precio.
 */
export function CourseSalesPanel({ courseId }: { courseId: string }) {
  const { offer, membership } = useOfertaYMembresia(courseId);
  const opciones = offer?.options ?? [];
  const plan = destacado(membership);
  const variasOpciones = opciones.length > 1;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardContent className="space-y-5 p-6">
            <div>
              <h2 className="font-display text-xl font-semibold text-text">Empieza este curso</h2>
              <p className="mt-1 text-sm text-text-muted">
                {opciones.length > 0
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
          {/* Precio único: la caja de siempre. Cuando hay varios formatos, el
              protagonismo pasa a la rejilla de abajo y esta caja no se pinta. */}
          {opciones.length === 1 ? <CajaPrecio courseId={courseId} opcion={opciones[0]!} /> : null}

          {plan ? <CajaAccesoTotal plan={plan} /> : null}

          {offer !== null && opciones.length === 0 && !plan ? (
            <Card>
              <CardContent className="p-6 text-sm text-text-muted">
                Este curso todavía no está disponible para la compra. Si tienes un código de
                invitación, puedes canjearlo abajo.
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Varios formatos: una tarjeta por opción, como los planes de la
          membresía. La destacada se resalta. */}
      {variasOpciones ? (
        <section className="space-y-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-text">Elige tu formato</h2>
            <p className="mt-1 text-sm text-text-muted">
              El mismo curso con distinto nivel de acompañamiento.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {opciones.map((o) => (
              <TarjetaOpcion key={o.id} courseId={courseId} opcion={o} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Oferta de la membresía dentro de la ficha de un curso.
 *
 * Enseña el precio de ENTRADA (el plan más barato de todos, que es el mensual),
 * no el del plan destacado: el objetivo aquí no es vender el plan óptimo sino
 * que el alumno vea que acceder a todo cuesta menos que este curso suelto. El
 * detalle de los tres planes ya lo da /unete.
 *
 * Va en dorado de marca, no en el coral de "warning": es una oferta premium y
 * el coral la hacía parecer una advertencia.
 */
function CajaAccesoTotal({
  plan,
}: {
  plan: { amountCents: number; intervalMonths: number; currency: string };
}) {
  return (
    <Card className="acceso-total-card">
      <CardContent className="space-y-3 p-6">
        <div className="acceso-total-eyebrow flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
          <Icon name="sparkles" size={14} />
          Acceso total
        </div>
        <p className="text-sm text-text">
          Accede a <strong>todos los cursos</strong> desde{' '}
          <strong>{formatCents(plan.amountCents, plan.currency)}</strong>{' '}
          {periodo(plan.intervalMonths)}.
        </p>
        <Link
          href="/unete"
          className="acceso-total-cta inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          Ver membresías
        </Link>
        <p className="text-center text-xs text-text-muted">
          Cancela cuando quieras, sin permanencia
        </p>
      </CardContent>
    </Card>
  );
}

function CajaPrecio({ courseId, opcion }: { courseId: string; opcion: CourseOfferOption }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <Precio opcion={opcion} grande />
        <p className="text-xs text-text-muted">Pago único · IVA incluido</p>
        <BuyCourseButton courseId={courseId} optionId={opcion.id} size="lg" className="w-full" />
      </CardContent>
    </Card>
  );
}

function TarjetaOpcion({ courseId, opcion }: { courseId: string; opcion: CourseOfferOption }) {
  return (
    <Card
      className={opcion.isFeatured ? 'relative border-2 border-brand-500 shadow-md' : 'relative'}
    >
      {opcion.isFeatured ? (
        <span className="absolute -top-3 left-6 rounded-full bg-brand-600 px-3 py-0.5 text-xs font-semibold text-white">
          El más elegido
        </span>
      ) : null}
      <CardContent className="flex h-full flex-col gap-4 p-6">
        <h3 className="font-display text-base font-semibold text-text">
          {opcion.name || 'Curso completo'}
        </h3>
        <Precio opcion={opcion} />
        <p className="text-xs text-text-muted">Pago único · IVA incluido</p>
        {opcion.perks.length > 0 ? (
          <ul className="flex-1 space-y-2">
            {opcion.perks.map((p) => (
              <Beneficio key={p} texto={p} />
            ))}
          </ul>
        ) : (
          <div className="flex-1" />
        )}
        <BuyCourseButton
          courseId={courseId}
          optionId={opcion.id}
          label="Comprar"
          className="w-full"
        />
      </CardContent>
    </Card>
  );
}

function Precio({ opcion, grande = false }: { opcion: CourseOfferOption; grande?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span
        className={`font-display font-bold tracking-tight text-text ${grande ? 'text-3xl' : 'text-2xl'}`}
      >
        {formatCents(opcion.unitAmount, opcion.currency)}
      </span>
      {opcion.compareAtAmount ? (
        <span className="text-sm text-text-muted line-through">
          {formatCents(opcion.compareAtAmount, opcion.currency)}
        </span>
      ) : null}
      {opcion.discountPercent ? (
        <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-semibold text-success-700">
          −{opcion.discountPercent}%
        </span>
      ) : null}
    </div>
  );
}

/**
 * CTAs del bloque de contenido bloqueado. Repite las vías de acceso justo donde
 * el alumno se topa con el muro, sin obligarle a volver arriba. Con varios
 * formatos ofrece el más barato ("desde X €") para no repetir la rejilla.
 */
export function LockedContentActions({ courseId }: { courseId: string }) {
  const { offer, membership } = useOfertaYMembresia(courseId);
  const plan = destacado(membership);
  const opciones = offer?.options ?? [];
  const barata = [...opciones].sort((a, b) => a.unitAmount - b.unitAmount)[0];
  if (!barata && !plan) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      {barata ? (
        <BuyCourseButton
          courseId={courseId}
          optionId={barata.id}
          label={
            opciones.length > 1
              ? `Comprar desde ${formatCents(barata.unitAmount, barata.currency)}`
              : `Comprar por ${formatCents(barata.unitAmount, barata.currency)}`
          }
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

/** Carga la oferta del curso y la página de membresía, tolerando que falte cualquiera. */
function useOfertaYMembresia(courseId: string) {
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

  return { offer, membership };
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

/**
 * Plan que se muestra como precio de entrada: el de importe MÁS BAJO de todos
 * (normalmente el mensual). Es el "desde X" que hace la oferta comparable con
 * el precio del curso suelto; elegir el destacado enseñaría el anual y la
 * membresía parecería más cara que comprar el curso.
 */
function destacado(page: MembershipPage | null) {
  const planes = page?.plans ?? [];
  if (planes.length === 0) return null;
  return [...planes].sort((a, b) => a.amountCents - b.amountCents)[0]!;
}

function periodo(meses: number): string {
  if (meses === 1) return 'al mes';
  if (meses === 12) return 'al año';
  return `cada ${meses} meses`;
}
