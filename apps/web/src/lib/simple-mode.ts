'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import type { AcademyLocale } from '@/i18n/config';
import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { meApi } from './me';
import type { PriceFees } from './price-estimate';
import { majorToMinor } from './stripe-currencies';

/**
 * Modo sencillo del aula (Didacta Cloud): menú corto, «Empieza aquí» y alta en
 * 3 preguntas. El estado vive en el servidor (`tenant.simple_mode`); aquí se
 * cachea por pestaña y por aula para que el primer pintado ya sepa qué
 * armazón usar y no aparezca un instante el menú completo.
 */

const CACHE_PREFIX = 'didacta:modo-sencillo:';

function cacheKey(): string | null {
  const tenantId = authStorage.getSession()?.user.tenantId;
  return tenantId ? `${CACHE_PREFIX}${tenantId}` : null;
}

export function readSimpleModeCache(): boolean | null {
  if (typeof window === 'undefined') return null;
  const key = cacheKey();
  if (!key) return null;
  try {
    const v = window.sessionStorage.getItem(key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

export function writeSimpleModeCache(value: boolean): void {
  if (typeof window === 'undefined') return;
  const key = cacheKey();
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Sin sessionStorage solo se pierde la caché: se vuelve a preguntar.
  }
}

/**
 * El modo del aula para una decisión puntual (el gate del primer acceso): la
 * caché de la pestaña o, sin ella, `/me/modules`. Un fallo cuenta como modo
 * completo, el de siempre.
 */
export async function simpleModeNow(): Promise<boolean> {
  const cached = readSimpleModeCache();
  if (cached !== null) return cached;
  const token = authStorage.getAccessToken();
  if (!token) return false;
  try {
    const v = (await meApi.getMyModules(token)).simpleMode === true;
    writeSimpleModeCache(v);
    return v;
  } catch {
    return false;
  }
}

/** Avisa a toda la app (shell incluido) de que el modo cambió. */
export const SIMPLE_MODE_CHANGED_EVENT = 'didacta:modo-sencillo';

/**
 * ¿Está el aula en modo sencillo? `null` mientras no se sabe (sin caché y sin
 * respuesta todavía). Pregunta a `/me/modules`, que el shell ya consulta.
 */
export function useSimpleMode(): boolean | null {
  const [value, setValue] = useState<boolean | null>(() => readSimpleModeCache());
  useEffect(() => {
    let cancelled = false;
    const token = authStorage.getAccessToken();
    if (token) {
      meApi
        .getMyModules(token)
        .then((res) => {
          if (cancelled) return;
          const v = res.simpleMode === true;
          writeSimpleModeCache(v);
          setValue(v);
        })
        .catch(() => {
          if (!cancelled) setValue((prev) => prev ?? false);
        });
    }
    function onChange(e: Event) {
      const v = (e as CustomEvent<boolean>).detail === true;
      writeSimpleModeCache(v);
      setValue(v);
    }
    window.addEventListener(SIMPLE_MODE_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(SIMPLE_MODE_CHANGED_EVENT, onChange);
    };
  }, []);
  return value;
}

// ── API ────────────────────────────────────────────────────────────────────

export type StepId = 'academy' | 'course' | 'price' | 'payments' | 'publish' | 'invite';

export interface OfferView {
  kind: 'course' | 'membership';
  courseId: string | null;
  planId: string | null;
  amountCents: number;
  currency: string;
  courseTitle: string | null;
  courseSlug: string | null;
  /** Portada del curso de la oferta; `null` sin portada o con membresía. */
  courseCoverUrl: string | null;
}

export interface StartHereView {
  academyName: string;
  quickStartDone: boolean;
  offer: OfferView | null;
  firstCourseId: string | null;
  steps: Array<{ id: StepId; done: boolean }>;
  salePath: string | null;
  sales: { count: number; firstSaleAt: string | null };
  students: number;
  nextLive: { id: string; topic: string; startTime: string } | null;
  paymentsSetupPath: string;
  /**
   * La cuenta de cobros ya puede vender pero faltan los datos fiscales: el
   * dinero de las ventas se quedaría retenido. El paso de cobros sigue
   * pendiente y lleva a completarlos. Ausente en una API anterior: `false`.
   */
  taxProfilePending?: boolean;
  /** Dónde se completan los datos fiscales. */
  taxProfilePath?: string;
  /**
   * El creador confirmó el precio. El del alta en 3 preguntas es de partida:
   * sin confirmar, el paso «Precio» sigue pendiente (no bloquea: publicar lo
   * enseña y lo confirma). Ausente en una API anterior: confirmado.
   */
  priceConfirmed?: boolean;
}

/** Precio y venta de un curso (`GET /admin/simple-mode/courses/:id/sale`). */
export interface CourseSaleView {
  courseId: string;
  role: 'offer' | 'membership' | 'separate';
  price: { amountCents: number; currency: string; intervalMonths: number | null } | null;
  state: SaleState;
  salePath: string | null;
  editable: boolean;
  offerTitle: string | null;
}

/**
 * ¿Se puede comprar ya? Un curso publicado con los cobros sin conectar NO se
 * puede comprar: el enlace existe pero nadie podría pagar. Con la cuenta
 * conectada y los datos fiscales pendientes SÍ se puede comprar (el dinero se
 * retiene hasta completarlos, y eso lo avisa el paso de cobros).
 */
export type SaleState = 'on-sale' | 'not-purchasable' | 'unpublished';

type StepsView = Pick<StartHereView, 'steps' | 'taxProfilePending'> &
  Partial<Pick<StartHereView, 'offer' | 'priceConfirmed'>>;

/**
 * Precio puesto pero sin confirmar (el del alta en 3 preguntas): el paso
 * «Precio» sigue pendiente, pero no bloquea el camino: publicar enseña el
 * precio y lo confirma.
 */
export function priceToConfirm(view: StepsView): boolean {
  return (
    view.priceConfirmed === false &&
    (view.offer?.amountCents ?? 0) > 0 &&
    view.steps.find((s) => s.id === 'price')?.done !== true
  );
}

/**
 * ¿Puede cobrar ya la cuenta? Con el paso de cobros hecho, o con la cuenta
 * lista y solo los datos fiscales pendientes: se vende igual y el dinero se
 * retiene hasta completarlos (decisión de producto, web #39).
 */
export function paymentsCanSell(view: StepsView): boolean {
  return (
    view.steps.find((s) => s.id === 'payments')?.done === true || view.taxProfilePending === true
  );
}

/**
 * Primer paso pendiente: el único que se abre. `null` = todos hechos. Con solo
 * los datos fiscales pendientes, «Conecta tus cobros» no bloquea el camino:
 * se salta (queda marcado aparte con su botón) y se abre el siguiente.
 */
export function currentStep(view: StepsView): StepId | null {
  const skipPayments = view.taxProfilePending === true;
  const skipPrice = priceToConfirm(view);
  return (
    view.steps.find(
      (s) => !s.done && !(skipPayments && s.id === 'payments') && !(skipPrice && s.id === 'price'),
    )?.id ?? null
  );
}

/** ¿Se puede publicar ya? Curso con lección, precio y una cuenta que pueda cobrar. */
export function canPublish(view: StepsView): boolean {
  const done = new Set(view.steps.filter((s) => s.done).map((s) => s.id));
  return done.has('course') && (done.has('price') || priceToConfirm(view)) && paymentsCanSell(view);
}

export function saleState(
  view: Pick<StartHereView, 'salePath' | 'steps' | 'taxProfilePending'>,
): SaleState {
  if (!view.salePath) return 'unpublished';
  return paymentsCanSell(view) ? 'on-sale' : 'not-purchasable';
}

/**
 * Titular de «Empieza aquí»: tras la primera venta, la celebración; con la
 * oferta ya a la venta (publicada y con cobros), «ya está a la venta» aunque
 * quede invitar a los primeros alumnos; si no, «casi lista para vender».
 */
export type StartHereHeadline = 'celebra' | 'listo' | 'casi';

export function startHereHeadline(
  view: Pick<StartHereView, 'salePath' | 'steps' | 'sales' | 'taxProfilePending'>,
): StartHereHeadline {
  if (view.sales.count > 0) return 'celebra';
  if (view.steps.every((s) => s.done) || saleState(view) === 'on-sale') return 'listo';
  return 'casi';
}

/** «49», «49,90» o «49.90» → unidad mínima de la moneda; `null` si no vale. */
export function parseAmount(raw: string, currency: string): number | null {
  const n = Number(raw.trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return majorToMinor(n, currency);
}

/**
 * Moneda propuesta en el alta según el idioma y país del navegador
 * (es-ES → EUR, en-US → USD, en-GB → GBP…), si el aula puede cobrar en ella;
 * si no, la primera de la lista.
 */
export function suggestCurrency(locale: string, allowed: readonly string[]): string {
  const region = (locale.split('-')[1] ?? '').toUpperCase();
  const byRegion: Record<string, string> = {
    US: 'usd',
    GB: 'gbp',
    CA: 'cad',
    CH: 'chf',
    SE: 'sek',
    DK: 'dkk',
    NO: 'nok',
    PL: 'pln',
    CZ: 'czk',
    HU: 'huf',
    RO: 'ron',
    MX: 'mxn',
    BR: 'brl',
  };
  const guess = byRegion[region] ?? 'eur';
  return allowed.includes(guess) ? guess : (allowed[0] ?? 'eur');
}

export interface QuickStartInput {
  academyName: string;
  offer: 'course' | 'membership';
  title?: string;
  amountCents: number;
  currency: string;
  locale: AcademyLocale;
  /** Portada del curso, opcional (URL que devuelve la subida de imágenes). */
  coverUrl?: string;
}

function bearer(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

const BASE = '/api/v1/admin/simple-mode';

export const simpleModeApi = {
  async setEnabled(enabled: boolean): Promise<boolean> {
    const r = await apiFetch<{ enabled: boolean }>(
      BASE,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
      bearer(),
    );
    window.dispatchEvent(new CustomEvent(SIMPLE_MODE_CHANGED_EVENT, { detail: r.enabled }));
    return r.enabled;
  },
  /** Monedas y comisiones para estimar lo que le llega (`fees` falta en una API anterior). */
  currencies(): Promise<{
    currencies: string[];
    settlementCurrency: string | null;
    fees?: PriceFees;
  }> {
    return apiFetch(`${BASE}/currencies`, { method: 'GET' }, bearer());
  },
  courseSale(courseId: string): Promise<CourseSaleView> {
    return apiFetch(
      `${BASE}/courses/${encodeURIComponent(courseId)}/sale`,
      { method: 'GET' },
      bearer(),
    );
  },
  /** El mismo cambio que el paso «Precio» (o su opción de compra si se vende aparte). */
  updateCoursePrice(
    courseId: string,
    price: { amountCents: number; currency: string },
  ): Promise<CourseSaleView> {
    return apiFetch(
      `${BASE}/courses/${encodeURIComponent(courseId)}/price`,
      { method: 'PUT', body: JSON.stringify(price) },
      bearer(),
    );
  },
  quickStart(input: QuickStartInput): Promise<{ offer: OfferView }> {
    return apiFetch(
      `${BASE}/quick-start`,
      { method: 'POST', body: JSON.stringify(input) },
      bearer(),
    );
  },
  startHere(): Promise<StartHereView> {
    return apiFetch(`${BASE}/start-here`, { method: 'GET' }, bearer());
  },
  updatePrice(price: { amountCents: number; currency: string }): Promise<OfferView> {
    return apiFetch(`${BASE}/price`, { method: 'PUT', body: JSON.stringify(price) }, bearer());
  },
  /** Aula que ya tenía cursos, alumnos o ventas: se adopta sin alta de cero. */
  adopt(): Promise<{ adopted: boolean }> {
    return apiFetch(`${BASE}/adopt`, { method: 'POST', body: '{}' }, bearer());
  },
  confirmAcademy(): Promise<{ ok: true }> {
    return apiFetch(`${BASE}/academy/confirm`, { method: 'POST', body: '{}' }, bearer());
  },
  publish(): Promise<{ salePath: string }> {
    return apiFetch(`${BASE}/publish`, { method: 'POST', body: '{}' }, bearer());
  },
};
