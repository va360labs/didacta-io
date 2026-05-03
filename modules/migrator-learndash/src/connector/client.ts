import type { AuthStrategy } from './auth.js';
import type { RetryPolicy } from './retry.js';
import { defaultRetry } from './retry.js';
import { TokenBucket } from './rate-limit.js';
import {
  AbortedError,
  AuthFailedError,
  ConnectorError,
  MalformedResponseError,
  NotFoundError,
  RateLimitExceededError,
  ServerError,
  SourceUnreachableError,
} from './errors.js';

export interface MinimalLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface RestConnectorOptions {
  baseUrl: string;
  auth: AuthStrategy;
  rateLimit?: { rps: number };
  timeoutMs?: number;
  userAgent?: string;
  logger: MinimalLogger;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Si true, devuelve la Response cruda en vez del JSON parseado (para acceder a headers). */
  raw?: boolean;
}

export interface RawResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export class RestConnector {
  private readonly bucket?: TokenBucket;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RestConnectorOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl requerido');
    if (!opts.baseUrl.startsWith('https://') && !opts.baseUrl.startsWith('http://')) {
      throw new Error('baseUrl debe comenzar con https:// o http://');
    }
    this.bucket = opts.rateLimit ? new TokenBucket(opts.rateLimit.rps) : undefined;
    this.retry = opts.retry ?? defaultRetry;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Construye URL completa con query params. */
  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = this.opts.baseUrl.endsWith('/')
      ? this.opts.baseUrl.slice(0, -1)
      : this.opts.baseUrl;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(base + cleanPath);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** Mappea response 4xx/5xx a errores tipados. */
  private mapError(status: number, body: unknown, url: string): ConnectorError {
    const message = `${status} on ${url}`;
    if (status === 401 || status === 403) return new AuthFailedError(message, status, body);
    if (status === 404) return new NotFoundError(message, status, body);
    if (status === 429) return new RateLimitExceededError(message, status, body);
    if (status >= 500 && status < 600) return new ServerError(message, status, body);
    return new ConnectorError(message, status, body);
  }

  private async parseBody(response: Response): Promise<unknown> {
    const ct = response.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      const text = await response.text();
      if (text.length === 0) return null;
      // Intento JSON aunque content-type no lo declare (WP a veces miente)
      try {
        return JSON.parse(text);
      } catch {
        throw new MalformedResponseError('respuesta no es JSON', response.status, text.slice(0, 256));
      }
    }
    try {
      return await response.json();
    } catch (err) {
      throw new MalformedResponseError('JSON malformado', response.status, err);
    }
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: RequestOptions = {},
  ): Promise<T | RawResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.opts.userAgent ?? 'Didacta/migrator-learndash 1.0',
      ...this.opts.auth.headers(),
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const t0 = Date.now();
    let attempt = 0;
    let lastError: unknown;
    let lastResponse: Response | undefined;

    while (attempt < 10) {
      if (options.signal?.aborted) throw new AbortedError();
      if (this.bucket) await this.bucket.acquire(options.signal);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const composedSignal = options.signal
        ? this.composeSignals(ctrl.signal, options.signal)
        : ctrl.signal;

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: composedSignal,
        });
        clearTimeout(timer);
        lastResponse = response;

        if (response.ok) {
          const body = await this.parseBody(response);
          this.opts.logger.debug?.('connector.request.ok', {
            method,
            url,
            status: response.status,
            durationMs: Date.now() - t0,
          });
          if (options.raw) {
            return { status: response.status, headers: response.headers, body: body as T };
          }
          return body as T;
        }

        // Status no-OK: ¿reintentar?
        const body = await this.parseBody(response).catch(() => null);
        const error = this.mapError(response.status, body, url);
        if (this.retry.shouldRetry(attempt, error, response)) {
          const delay = this.retry.delayMs(attempt, response);
          this.opts.logger.warn('connector.request.retry', {
            method,
            url,
            status: response.status,
            attempt,
            delayMs: delay,
          });
          await this.sleep(delay, options.signal);
          attempt += 1;
          lastError = error;
          continue;
        }
        throw error;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (options.signal?.aborted) throw new AbortedError();
          // Timeout interno: tratable como source unreachable si no quedan retries
          if (this.retry.shouldRetry(attempt, err, lastResponse)) {
            const delay = this.retry.delayMs(attempt, lastResponse);
            await this.sleep(delay, options.signal);
            attempt += 1;
            lastError = err;
            continue;
          }
          throw new SourceUnreachableError(`timeout ${this.timeoutMs}ms en ${url}`, undefined, err);
        }
        if (err instanceof ConnectorError) throw err;
        // TypeError típico: fetch network error
        if (err instanceof TypeError) {
          if (this.retry.shouldRetry(attempt, err, lastResponse)) {
            const delay = this.retry.delayMs(attempt, lastResponse);
            await this.sleep(delay, options.signal);
            attempt += 1;
            lastError = err;
            continue;
          }
          throw new SourceUnreachableError(`network error en ${url}`, undefined, err);
        }
        throw err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ConnectorError('reintentos agotados sin error tipado');
  }

  /** Variante tipada que siempre devuelve la Response cruda (incluye headers). */
  async requestRaw<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: Omit<RequestOptions, 'raw'> = {},
  ): Promise<RawResponse<T>> {
    return this.request<T>(method, path, { ...options, raw: true }) as Promise<RawResponse<T>>;
  }

  async healthcheck(): Promise<{ ok: boolean; latencyMs: number; serverInfo?: unknown; error?: string }> {
    const t0 = Date.now();
    try {
      const body = await this.request<unknown>('GET', '/wp-json/');
      return { ok: true, latencyMs: Date.now() - t0, serverInfo: body };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, latencyMs: Date.now() - t0, error: msg };
    }
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new AbortedError());
        },
        { once: true },
      );
    });
  }

  private composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (a.aborted) return a;
    if (b.aborted) return b;
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return ctrl.signal;
  }
}
