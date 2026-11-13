'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { meApi } from './me';
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
}

/**
 * ¿Se puede comprar ya? Un curso publicado con los cobros sin conectar NO se
 * puede comprar: el enlace existe pero nadie podría pagar.
 */
export type SaleState = 'on-sale' | 'not-purchasable' | 'unpublished';

export function saleState(view: Pick<StartHereView, 'salePath' | 'steps'>): SaleState {
  if (!view.salePath) return 'unpublished';
  return view.steps.find((s) => s.id === 'payments')?.done ? 'on-sale' : 'not-purchasable';
}

/**
 * Titular de «Empieza aquí»: tras la primera venta, la celebración; con la
 * oferta ya a la venta (publicada y con cobros), «ya está a la venta» aunque
 * quede invitar a los primeros alumnos; si no, «casi lista para vender».
 */
export type StartHereHeadline = 'celebra' | 'listo' | 'casi';

export function startHereHeadline(
  view: Pick<StartHereView, 'salePath' | 'steps' | 'sales'>,
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
  locale: 'es' | 'en';
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
  currencies(): Promise<{ currencies: string[]; settlementCurrency: string | null }> {
    return apiFetch(`${BASE}/currencies`, { method: 'GET' }, bearer());
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
