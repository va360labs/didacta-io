/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getPublicCatalog } from '@/lib/catalog';
import { referralsApi, storeReferralCode } from '@/lib/referrals';
import { fetchTenantContext } from '@/lib/tenant-context';

/**
 * Enlaces de «Invita y gana» para TODO lo que vende el aula: la membresía
 * (`/unete`) y cada curso suelto a la venta (`/catalogo/<slug>`), todos con el
 * `?ref=` del alumno. Cualquiera de ellos genera comisión al comprar.
 */

export interface ReferralProductLink {
  kind: 'membership' | 'course';
  /** Título del curso; null en la membresía (la UI pone su propio texto). */
  title: string | null;
  url: string;
}

export interface ReferralLinks {
  /** El enlace que se copia por defecto; null si no hay nada a la venta. */
  general: string | null;
  /** Uno por producto, solo cuando hay MÁS de uno a la venta. */
  products: ReferralProductLink[];
  /** Qué hay a la venta (para hablar de compras, de cuotas o de las dos). */
  onSale: { membership: boolean; courses: number };
}

/** Formato del código (mismo que valida la API). */
const CODE_RE = /^[a-z0-9]{3,32}$/;

/**
 * Arma los enlaces a partir del enlace personal que devuelve la API (de él
 * solo se toma el origen: el dominio real del aula, resuelto en el servidor).
 *
 * El general es la membresía si está a la venta; si no, el único curso, o el
 * catálogo si hay varios.
 */
export function buildReferralLinks(input: {
  personalUrl: string;
  code: string;
  membershipOnSale: boolean;
  courses: ReadonlyArray<{ slug: string; title: string }>;
}): ReferralLinks {
  let origin: string;
  try {
    origin = new URL(input.personalUrl).origin;
  } catch {
    origin = '';
  }
  const withRef = (path: string) => `${origin}${path}?ref=${encodeURIComponent(input.code)}`;

  const products: ReferralProductLink[] = [
    ...(input.membershipOnSale
      ? [{ kind: 'membership' as const, title: null, url: withRef('/unete') }]
      : []),
    ...input.courses.map((c) => ({
      kind: 'course' as const,
      title: c.title,
      url: withRef(`/catalogo/${encodeURIComponent(c.slug)}`),
    })),
  ];
  const onSale = { membership: input.membershipOnSale, courses: input.courses.length };
  if (products.length === 0) return { general: null, products: [], onSale };

  const general = input.membershipOnSale
    ? withRef('/unete')
    : products.length === 1
      ? products[0]!.url
      : withRef('/catalogo');
  return { general, products: products.length > 1 ? products : [], onSale };
}

/**
 * Lo que necesita «Invita y gana»: programa activo y algo a la venta. Devuelve
 * null si el programa está apagado, el alumno no puede tener enlace o el aula
 * no vende nada (un enlace a una página vacía no daría nada).
 */
export async function loadMyReferralLinks(): Promise<{
  commissionBps: number;
  code: string;
  links: ReferralLinks;
} | null> {
  const stats = await referralsApi.myStats();
  if (!stats.programActive) return null;
  const me = await referralsApi.me();
  const links = await loadReferralLinks(me);
  if (!links.general) return null;
  return { commissionBps: stats.commissionBps, code: me.code, links };
}

/** Los enlaces del alumno según lo que el aula tenga HOY a la venta. */
export async function loadReferralLinks(me: { code: string; url: string }): Promise<ReferralLinks> {
  const [ctx, catalog] = await Promise.all([
    fetchTenantContext().catch(() => null),
    getPublicCatalog().catch(() => ({ courses: [] })),
  ]);
  return buildReferralLinks({
    personalUrl: me.url,
    code: me.code,
    membershipOnSale: ctx?.tenant?.membershipPageActive === true,
    courses: catalog.courses,
  });
}

/** El `ref` válido de una query string (`?ref=AbC123` → `abc123`), o null. */
export function readReferralParam(search: string): string | null {
  const ref = new URLSearchParams(search).get('ref')?.trim().toLowerCase();
  return ref && CODE_RE.test(ref) ? ref : null;
}

/**
 * Captura el `?ref=` de la página de venta actual: guarda el código (último
 * clic gana, con la ventana de atribución del aula) y registra el clic.
 * Best-effort: un código inválido o el programa apagado no cambian nada.
 */
export function captureReferralFromLocation(search: string): void {
  const ref = readReferralParam(search);
  if (!ref) return;
  storeReferralCode(ref);
  referralsApi
    .track(ref)
    .then(({ attributionWindowDays }) => storeReferralCode(ref, attributionWindowDays))
    .catch(() => {
      // Silencioso: el clic es métrica, nunca UX.
    });
}
