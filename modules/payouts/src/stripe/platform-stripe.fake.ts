/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PlatformStripeApiError } from '../errors.js';
import type {
  PlatformStripeClient,
  StripeHttpMethod,
  StripeObject,
  StripeParams,
  StripeRequestOptions,
} from './platform-stripe.client.js';

/**
 * Doble en memoria de `PlatformStripeClient`, para tests. No habla con nadie.
 *
 * No intenta ser Stripe: es un almacén de objetos con cuatro comportamientos
 * que el dominio necesita para probarse y que conviene no reimplementar en
 * cada test:
 *
 *  1. **Almacén** — `seed(objeto)` guarda un objeto por su `id`; un
 *     `GET /v1/<recurso>/<id>` (o `/v2/...`) lo devuelve, con `expand[]`
 *     resuelto contra el propio almacén.
 *  2. **Rutas a medida** — `on('POST', '/v1/transfers', handler)` define qué
 *     hace una llamada. Los segmentos `:nombre` capturan.
 *  3. **Idempotencia** — un `POST` repetido con la misma clave y los mismos
 *     parámetros devuelve la MISMA respuesta sin volver a ejecutar el handler;
 *     con parámetros distintos falla como Stripe (`idempotency_error`).
 *  4. **Fallos inyectados** — `failNext(...)` hace fallar la siguiente llamada
 *     que case (saldo insuficiente, 500, sin respuesta).
 *
 * Una ruta que nadie definió y un id que no está en el almacén dan 404
 * (`resource_missing`), no un `undefined` silencioso: un test que llama a algo
 * que no esperaba tiene que enterarse.
 */

export interface FakeStripeCall {
  readonly api: 'v1' | 'v2';
  readonly method: StripeHttpMethod;
  readonly path: string;
  readonly params: StripeParams;
  readonly options: StripeRequestOptions;
}

export interface FakeStripeRequest extends FakeStripeCall {
  /** Segmentos `:nombre` capturados de la ruta. */
  readonly pathParams: Record<string, string>;
}

export type FakeStripeHandler = (
  request: FakeStripeRequest,
  fake: InMemoryPlatformStripeClient,
) => StripeObject | Promise<StripeObject>;

interface Route {
  readonly method: StripeHttpMethod;
  readonly segments: readonly string[];
  readonly handler: FakeStripeHandler;
}

interface PendingFailure {
  readonly method?: StripeHttpMethod;
  readonly path: string | RegExp;
  readonly error: PlatformStripeApiError;
}

function splitPath(path: string): string[] {
  const q = path.indexOf('?');
  return (q === -1 ? path : path.slice(0, q)).split('/').filter(Boolean);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryPlatformStripeClient implements PlatformStripeClient {
  readonly livemode: boolean;
  /** Todas las llamadas recibidas, en orden (incluidas las que fallaron). */
  readonly calls: FakeStripeCall[] = [];

  private readonly store = new Map<string, StripeObject>();
  private readonly routes: Route[] = [];
  private readonly idempotent = new Map<string, { fingerprint: string; response: StripeObject }>();
  private readonly failures: PendingFailure[] = [];
  private sequence = 0;

  constructor(options: { livemode?: boolean } = {}) {
    this.livemode = options.livemode ?? false;
  }

  // ── Preparación ──────────────────────────────────────────────────────────

  /** Guarda (o sustituye) objetos por su `id`. */
  seed(...objects: StripeObject[]): this {
    for (const object of objects) {
      const id = object['id'];
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('InMemoryPlatformStripeClient.seed: el objeto no tiene `id`');
      }
      this.store.set(id, clone(object));
    }
    return this;
  }

  /** Lee un objeto del almacén (copia). */
  get<T extends StripeObject = StripeObject>(id: string): T | undefined {
    const found = this.store.get(id);
    return found ? (clone(found) as T) : undefined;
  }

  /** Modifica un objeto del almacén (p. ej. ponerle `balance_transaction`). */
  patch(id: string, changes: StripeObject): this {
    const found = this.store.get(id);
    if (!found) throw new Error(`InMemoryPlatformStripeClient.patch: no existe ${id}`);
    this.store.set(id, { ...found, ...clone(changes) });
    return this;
  }

  /** Id nuevo con el prefijo dado: `tr_fake_1`, `re_fake_2`… */
  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake_${this.sequence}`;
  }

  /** Define qué hace una llamada. La última definición de una ruta gana. */
  on(method: StripeHttpMethod, path: string, handler: FakeStripeHandler): this {
    this.routes.unshift({ method, segments: splitPath(path), handler });
    return this;
  }

  /** Hace fallar la PRÓXIMA llamada que case con `path` (una sola vez). */
  failNext(
    path: string | RegExp,
    error: {
      message: string;
      status?: number;
      stripeCode?: string;
      type?: string;
      method?: StripeHttpMethod;
      param?: string;
    },
  ): this {
    const operation = `${error.method ?? '*'} ${typeof path === 'string' ? path : path.source}`;
    this.failures.push({
      method: error.method,
      path,
      error: new PlatformStripeApiError(error.message, {
        status: error.status ?? 400,
        type: error.type ?? 'invalid_request_error',
        stripeCode: error.stripeCode,
        operation,
        param: error.param,
      }),
    });
    return this;
  }

  /** Llamadas recibidas a una ruta concreta. */
  callsTo(method: StripeHttpMethod, path: string | RegExp): FakeStripeCall[] {
    return this.calls.filter(
      (call) =>
        call.method === method &&
        (typeof path === 'string' ? call.path === path : path.test(call.path)),
    );
  }

  // ── PlatformStripeClient ─────────────────────────────────────────────────

  v1<T = StripeObject>(
    method: StripeHttpMethod,
    path: string,
    params: StripeParams = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    return this.dispatch<T>('v1', method, path, params, options);
  }

  v2<T = StripeObject>(
    method: StripeHttpMethod,
    path: string,
    body: StripeParams = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    return this.dispatch<T>('v2', method, path, body, options);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private async dispatch<T>(
    api: 'v1' | 'v2',
    method: StripeHttpMethod,
    path: string,
    params: StripeParams,
    options: StripeRequestOptions,
  ): Promise<T> {
    if (!path.startsWith(`/${api}/`)) {
      throw new Error(`InMemoryPlatformStripeClient: ruta ${path} no es de la API ${api}`);
    }
    const call: FakeStripeCall = { api, method, path, params: clone(params), options };
    this.calls.push(call);
    const operation = `${method} ${path}`;

    const failureIndex = this.failures.findIndex(
      (failure) =>
        (failure.method === undefined || failure.method === method) &&
        (typeof failure.path === 'string' ? failure.path === path : failure.path.test(path)),
    );
    if (failureIndex !== -1) {
      const [failure] = this.failures.splice(failureIndex, 1);
      throw failure!.error;
    }

    const key = method === 'POST' ? options.idempotencyKey : undefined;
    const fingerprint = JSON.stringify([path, options.account ?? null, params]);
    if (key) {
      const previous = this.idempotent.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new PlatformStripeApiError(
            'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            { status: 400, type: 'idempotency_error', operation },
          );
        }
        return clone(previous.response) as T;
      }
    }

    const response = await this.respond(call, operation);
    // Como Stripe: solo se recuerda la respuesta de una operación que terminó.
    if (key) this.idempotent.set(key, { fingerprint, response: clone(response) });
    return clone(response) as T;
  }

  private async respond(call: FakeStripeCall, operation: string): Promise<StripeObject> {
    const segments = splitPath(call.path);
    for (const route of this.routes) {
      if (route.method !== call.method || route.segments.length !== segments.length) continue;
      const pathParams: Record<string, string> = {};
      const matched = route.segments.every((segment, index) => {
        const actual = segments[index]!;
        if (segment.startsWith(':')) {
          pathParams[segment.slice(1)] = actual;
          return true;
        }
        return segment === actual;
      });
      if (matched) return route.handler({ ...call, pathParams }, this);
    }

    // Sin ruta a medida: un GET cuyo último segmento es un id del almacén.
    if (call.method === 'GET') {
      const id = segments[segments.length - 1];
      const found = id ? this.store.get(id) : undefined;
      if (found) return this.expand(clone(found), call.params['expand']);
    }

    throw new PlatformStripeApiError(`No such resource: ${operation}`, {
      status: 404,
      type: 'invalid_request_error',
      stripeCode: 'resource_missing',
      operation,
    });
  }

  /**
   * Resuelve `expand[]` contra el almacén: `latest_charge.balance_transaction`
   * sustituye el id de `latest_charge` por su objeto y, dentro de él, el de
   * `balance_transaction`. Un id que no está en el almacén se deja como está.
   */
  private expand(object: StripeObject, expand: unknown): StripeObject {
    if (!Array.isArray(expand)) return object;
    for (const path of expand) {
      if (typeof path !== 'string') continue;
      let cursor: StripeObject = object;
      for (const field of path.split('.')) {
        const value = cursor[field];
        if (typeof value === 'string') {
          const referenced = this.store.get(value);
          if (!referenced) break;
          cursor[field] = clone(referenced);
        }
        const next = cursor[field];
        if (next === null || typeof next !== 'object' || Array.isArray(next)) break;
        cursor = next as StripeObject;
      }
    }
    return object;
  }
}
