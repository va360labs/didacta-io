/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Contrato del cliente HTTP saliente que el host expone a los módulos
 * third-party del marketplace. Definido en alpha.49.
 *
 * Antes de alpha.49 los módulos NO podían hacer requests HTTP: el sandbox
 * no expone `fetch` global ni permite `require('node:https')`. Esto bloqueó
 * a `mod.migrator-learndash` para conectarse al WordPress origen del
 * cliente — el preflight devolvía conteos hardcoded a 0 con un warning
 * `STUB_PREFLIGHT`.
 *
 * El contrato vive en este archivo separado para que tres consumidores lo
 * compartan sin ciclos de import:
 *  1. `module-router.service.ts` — `ModuleRouteRequestContext.http`
 *  2. `module-sandbox.service.ts` — `ModuleInstallContext.http`
 *  3. `sandboxed-http.service.ts` (alpha.49 task 3) — la implementación real
 *
 * Reglas estructurales del contrato (todas impuestas por el host, NO por
 * el módulo):
 *  - **Allowlist por host**: el manifest del módulo declara qué hosts puede
 *    contactar. Cualquier URL fuera de la allowlist → `HTTP_BLOCKED_HOST`.
 *  - **SSRF guard**: DNS lookup previo a conectar. Si la IP resuelta es
 *    privada (RFC 1918), loopback, link-local, o ULA IPv6 → `HTTP_BLOCKED_HOST`.
 *    Crítico: el cliente puede declarar como base URL un `http://localhost:5432`
 *    o `http://169.254.169.254/` (AWS metadata).
 *  - **Rate limit**: token bucket por `(módulo, host)`. El módulo NO puede
 *    saltarse esto — `await ctx.http.get(...)` queda bloqueado en
 *    `acquire()` cuando el bucket está vacío.
 *  - **Timeout duro**: max 60 segundos. Default 15 segundos. Más alto que
 *    eso significa I/O bloqueante mal diseñado.
 *  - **Body cap**: max 100 MB. Default 10 MB. Aborta el stream cuando se
 *    supera (no carga 5 GB en memoria si el upstream tira un dump).
 */

/// Códigos de error tipados que `ctx.http` puede lanzar. El módulo decide
/// qué hacer con cada uno (devolver 4xx/5xx al usuario, reintentar, etc.).
export type HttpErrorCode =
  | 'HTTP_TIMEOUT' // Pasó `timeoutMs` sin respuesta.
  | 'HTTP_BLOCKED_HOST' // Host fuera de allowlist o IP privada/loopback.
  | 'HTTP_BODY_TOO_LARGE' // Respuesta superó `maxBodyBytes`; stream abortado.
  | 'HTTP_RATE_LIMITED' // Upstream devolvió 429 y se agotaron los retries.
  | 'HTTP_NETWORK' // ECONNREFUSED, ENOTFOUND, EHOSTUNREACH, etc.
  | 'HTTP_ABORTED' // El AbortSignal del caller se disparó (cancelación).
  | 'HTTP_INVALID_URL'; // URL malformada.

/// Error tipado que lanza `ctx.http` ante condiciones controladas. El
/// módulo puede `catch (e)` y discriminar por `e.code`. Para errores no
/// catalogados (bug del host, panic de undici, etc.) se lanza un `Error`
/// genérico — esos NO van con `HttpError` para que el módulo los propague.
export class HttpError extends Error {
  constructor(
    public readonly code: HttpErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequestOptions {
  /// Headers adicionales. El host añade `User-Agent: Didacta-Module/<name>@<version>`
  /// y reescribe `Host` si hace falta — esos no se pueden sobreescribir.
  headers?: Record<string, string>;
  /// Body de la request. String se envía tal cual; `Uint8Array` se envía
  /// como bytes. Si querés JSON, hacelo `JSON.stringify(...)` y mandá
  /// `Content-Type: application/json` en headers.
  body?: string | Uint8Array;
  /// Timeout duro de la request entera (DNS + connect + read). Cap del
  /// host: 60_000 ms. Default: 15_000.
  timeoutMs?: number;
  /// Tamaño máximo del body de respuesta. Cap del host: 100 * 1024 * 1024
  /// (100 MB). Default: 10 * 1024 * 1024 (10 MB). Superado → `HTTP_BODY_TOO_LARGE`.
  maxBodyBytes?: number;
  /// Señal de cancelación. Si se aborta a mitad de la request (ej. el
  /// usuario cancela el job de migración), se lanza `HTTP_ABORTED`.
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /// Headers de la respuesta, normalizados a lowercase. Multi-value se
  /// concatena con `, ` (mismo comportamiento que `Headers.get()`).
  headers: Record<string, string>;
  /// Body como string. Si el upstream devolvió bytes, se decodifica como
  /// UTF-8 (módulo decide hacer `JSON.parse` o lo que necesite). Para
  /// bytes crudos en futuro: añadir `bodyBytes` al contrato.
  body: string;
  /// Bytes leídos del wire — útil para telemetría dentro del módulo si
  /// necesita acumular tráfico consumido.
  bytesRead: number;
}

export interface SandboxedHttp {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  post(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

/// Cliente que rechaza TODA URL con `HTTP_BLOCKED_HOST`. Se inyecta a los
/// módulos que NO declaran el bloque `http` en su manifest. La idea es
/// fail-fast con mensaje claro: si un módulo intenta usar `ctx.http` sin
/// haberlo declarado, el dev sabe inmediatamente qué falta.
export class BlockedSandboxedHttp implements SandboxedHttp {
  constructor(private readonly moduleName: string) {}
  async get(url: string): Promise<HttpResponse> {
    return this.reject(url);
  }
  async post(url: string): Promise<HttpResponse> {
    return this.reject(url);
  }
  private reject(url: string): never {
    throw new HttpError(
      'HTTP_BLOCKED_HOST',
      `Módulo "${this.moduleName}" intentó hacer una request HTTP a "${url}" pero no declara el bloque \`http\` en su manifest. Añadí http: { allowedHosts, rateLimitPerHost, maxBodyBytes } al manifest del módulo para habilitar salida HTTP.`,
    );
  }
}

/// Placeholder histórico de la task 1 (transición). Se mantiene SOLO
/// para los tests del dispatcher que fijan el contrato cuando no hay
/// implementación cableada. En runtime el dispatcher usa `BlockedSandboxedHttp`
/// (módulo sin manifest.http) o `RateLimitedHttp` (módulo con manifest.http).
export class NoopSandboxedHttp implements SandboxedHttp {
  async get(): Promise<HttpResponse> {
    throw new HttpError(
      'HTTP_NETWORK',
      'NoopSandboxedHttp invocado — esto solo debería ocurrir en tests. En runtime el dispatcher inyecta BlockedSandboxedHttp o RateLimitedHttp.',
    );
  }
  async post(): Promise<HttpResponse> {
    throw new HttpError(
      'HTTP_NETWORK',
      'NoopSandboxedHttp invocado — esto solo debería ocurrir en tests. En runtime el dispatcher inyecta BlockedSandboxedHttp o RateLimitedHttp.',
    );
  }
}
