/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PlatformStripeApiError, PlatformStripeConfigError } from '../errors.js';

/**
 * Cliente de Stripe de la cuenta de PLATAFORMA, sobre `fetch`.
 *
 * Por qué no el SDK: la versión que usa el repo (17.x) no tipa Accounts v2 ni
 * `balance_settings`, y este módulo necesita las dos API a la vez:
 *
 *  - **v1** — cuerpo `application/x-www-form-urlencoded` con la notación de
 *    corchetes de Stripe (`a[b][0]=…`). Cabecera `Stripe-Account` para actuar
 *    sobre una cuenta conectada.
 *  - **v2** — cuerpo JSON. Cabecera `Stripe-Context` para la cuenta conectada.
 *    Accounts v2 sigue en vista previa y exige su propia `Stripe-Version`.
 *
 * Las dos llevan SIEMPRE la versión fijada: sin ella Stripe usa la que tenga
 * la cuenta por defecto, y una subida de versión en el panel cambiaría la
 * forma de las respuestas sin tocar una línea de código.
 *
 * La clave no se guarda en ningún campo enumerable ni aparece en ningún
 * mensaje de error.
 */

/**
 * Versión de la API v1 con la que se construyó y probó el módulo. Leída de la
 * cabecera `Stripe-Version` de una respuesta real del sandbox de la plataforma
 * (`GET /v1/balance`, 2026-11-12) y comprobada después enviándola fijada.
 */
export const PLATFORM_STRIPE_API_VERSION = '2026-10-28.endive';

/**
 * Versión de vista previa que exige Accounts v2 (`/v2/core/accounts`). Las
 * respuestas v2 no devuelven la cabecera `Stripe-Version`: es la que usaron
 * las pruebas del sandbox (`tools/payments-sandbox/lib2.mjs`).
 */
export const PLATFORM_STRIPE_V2_API_VERSION = '2026-10-28.preview';

export const STRIPE_API_BASE_URL = 'https://api.stripe.com';

const DEFAULT_TIMEOUT_MS = 30_000;

export type StripeHttpMethod = 'GET' | 'POST' | 'DELETE';

/** Parámetros de una llamada: objeto plano, anidable, con arrays. */
export type StripeParams = Record<string, unknown>;

/** Un objeto cualquiera de la API de Stripe. */
export type StripeObject = Record<string, unknown>;

export interface StripeRequestOptions {
  /**
   * Cuenta conectada sobre la que se actúa (`acct_…`). En v1 viaja como
   * `Stripe-Account`; en v2, como `Stripe-Context`.
   */
  readonly account?: string;
  /**
   * Clave de idempotencia. Es la misma cadena que la `idempotency_key` del
   * asiento del libro (`payouts:transfer:<saleId>`…). Stripe la olvida a las
   * 24 h.
   */
  readonly idempotencyKey?: string;
  /** Sustituye la versión fijada en esta llamada concreta. */
  readonly apiVersion?: string;
}

/**
 * Contrato que consume el dominio. Dos métodos, uno por API: el resto del
 * módulo construye sobre ellos (`accounts-api.ts`, `settlement.service.ts`…)
 * y los tests los sustituyen por `InMemoryPlatformStripeClient`.
 */
export interface PlatformStripeClient {
  /** `true` si la clave es de producción (`sk_live_…` / `rk_live_…`). */
  readonly livemode: boolean;

  /** Llamada a la API v1 (`/v1/...`). */
  v1<T = StripeObject>(
    method: StripeHttpMethod,
    path: string,
    params?: StripeParams,
    options?: StripeRequestOptions,
  ): Promise<T>;

  /** Llamada a la API v2 (`/v2/...`). */
  v2<T = StripeObject>(
    method: StripeHttpMethod,
    path: string,
    body?: StripeParams,
    options?: StripeRequestOptions,
  ): Promise<T>;
}

/**
 * Codifica un objeto con la notación de corchetes de la API v1 de Stripe:
 *
 *     { a: { b: 1 }, c: ['x', { d: true }] }
 *       → a[b]=1, c[0]=x, c[1][d]=true
 *
 * `undefined` y `null` se omiten (no es lo mismo que mandar vacío: en Stripe
 * la cadena vacía BORRA el campo, y eso tiene que ser una decisión explícita).
 */
export function encodeStripeForm(params: StripeParams | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (value: unknown, name: string): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${name}[${index}]`));
      return;
    }
    if (value instanceof Date) {
      out.push([name, String(Math.floor(value.getTime() / 1000))]);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(inner, `${name}[${key}]`);
      }
      return;
    }
    out.push([name, String(value)]);
  };
  for (const [key, value] of Object.entries(params ?? {})) walk(value, key);
  return out;
}

/**
 * Parámetros de consulta de la API v2: las listas van como clave repetida
 * (`include=a&include=b`), no con corchetes.
 */
export function encodeStripeV2Query(params: StripeParams | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.push([key, String(item)]);
    } else {
      out.push([key, String(value)]);
    }
  }
  return out;
}

/** `true` si la clave es de producción. Lanza si no es una clave secreta de Stripe. */
export function stripeKeyLivemode(secretKey: string): boolean {
  const match = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(secretKey);
  if (!match) {
    // Sin eco del valor: aunque esté mal formada, puede ser una clave real.
    throw new PlatformStripeConfigError(
      'la clave debe ser una clave secreta o restringida de Stripe (sk_… o rk_…)',
    );
  }
  return match[2] === 'live';
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface FetchPlatformStripeClientOptions {
  readonly secretKey: string;
  /** `fetch` inyectable (tests). Por defecto, el global de Node 22. */
  readonly fetch?: FetchLike;
  readonly apiVersion?: string;
  readonly v2ApiVersion?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function withQuery(url: string, pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return url;
  const query = new URLSearchParams(pairs).toString();
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** Ruta sin la cadena de consulta: es lo único de la llamada que va a un error. */
function operationOf(method: string, path: string): string {
  const q = path.indexOf('?');
  return `${method} ${q === -1 ? path : path.slice(0, q)}`;
}

export class FetchPlatformStripeClient implements PlatformStripeClient {
  readonly livemode: boolean;
  readonly #secretKey: string;
  readonly #fetch: FetchLike;
  readonly #apiVersion: string;
  readonly #v2ApiVersion: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: FetchPlatformStripeClientOptions) {
    this.livemode = stripeKeyLivemode(options.secretKey);
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#apiVersion = options.apiVersion ?? PLATFORM_STRIPE_API_VERSION;
    this.#v2ApiVersion = options.v2ApiVersion ?? PLATFORM_STRIPE_V2_API_VERSION;
    this.#baseUrl = (options.baseUrl ?? STRIPE_API_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async v1<T = StripeObject>(
    method: StripeHttpMethod,
    path: string,
    params?: StripeParams,
    options: StripeRequestOptions = {},
  ): Promise<T> {
    if (!path.startsWith('/v1/')) {
      throw new PlatformStripeConfigError(`ruta v1 no válida: ${operationOf(method, path)}`);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      'Stripe-Version': options.apiVersion ?? this.#apiVersion,
    };
    if (options.account) headers['Stripe-Account'] = options.account;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const pairs = encodeStripeForm(params);
    let url = `${this.#baseUrl}${path}`;
    let body: string | undefined;
    if (method === 'GET' || method === 'DELETE') {
      url = withQuery(url, pairs);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(pairs).toString();
    }
    return this.#send<T>(method, path, url, headers, body);
  }

  async v2<T = StripeObject>(
    method: StripeHttpMethod,
    path: string,
    body?: StripeParams,
    options: StripeRequestOptions = {},
  ): Promise<T> {
    if (!path.startsWith('/v2/')) {
      throw new PlatformStripeConfigError(`ruta v2 no válida: ${operationOf(method, path)}`);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      'Stripe-Version': options.apiVersion ?? this.#v2ApiVersion,
    };
    if (options.account) headers['Stripe-Context'] = options.account;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let url = `${this.#baseUrl}${path}`;
    let payload: string | undefined;
    if (method === 'GET' || method === 'DELETE') {
      url = withQuery(url, encodeStripeV2Query(body));
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }
    return this.#send<T>(method, path, url, headers, payload);
  }

  async #send<T>(
    method: StripeHttpMethod,
    path: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<T> {
    const operation = operationOf(method, path);
    let response: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      // Sin respuesta: NO se sabe si Stripe ejecutó la operación. Quien llama
      // reintenta con la MISMA clave de idempotencia.
      const reason = err instanceof Error ? err.name : 'Error';
      throw new PlatformStripeApiError(`sin respuesta de Stripe (${reason})`, {
        status: 0,
        operation,
      });
    }

    const requestId = response.headers.get('request-id') ?? undefined;
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new PlatformStripeApiError('respuesta de Stripe que no es JSON', {
        status: response.status,
        requestId,
        operation,
      });
    }

    if (!response.ok) {
      const error = ((json as { error?: unknown }).error ?? json) as {
        message?: unknown;
        type?: unknown;
        code?: unknown;
        param?: unknown;
      };
      throw new PlatformStripeApiError(
        typeof error.message === 'string' ? error.message : `HTTP ${response.status}`,
        {
          status: response.status,
          type: typeof error.type === 'string' ? error.type : undefined,
          stripeCode: typeof error.code === 'string' ? error.code : undefined,
          requestId,
          operation,
          param: typeof error.param === 'string' ? error.param : undefined,
        },
      );
    }
    return json as T;
  }
}
