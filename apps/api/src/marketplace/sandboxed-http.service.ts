import { Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  HttpError,
  type HttpRequestOptions,
  type HttpResponse,
  type SandboxedHttp,
} from './sandboxed-http.types';
import type { ModuleHttpConfig } from './module-manifest.schema';

/**
 * Implementación real del cliente HTTP saliente que el host expone a los
 * módulos third-party del marketplace (alpha.49 — task 3 del plan ctx.http).
 *
 * Esta clase NO es un servicio inyectable singleton: cada module + request
 * recibe una instancia scoped via `httpFactory()` del dispatcher, que pasa
 * el `manifest.http` del módulo y opcionalmente un `AbortSignal` del reply
 * de Fastify para cortar in-flight si el cliente cierra la conexión.
 *
 * Capas defensivas (en este orden, fail-fast):
 *  1. URL parse → HTTP_INVALID_URL
 *  2. Match contra `manifestHttp.allowedHosts` (wildcard / prefijo / exacto) → HTTP_BLOCKED_HOST
 *  3. DNS lookup + bloqueo de IPs privadas/loopback/link-local/IPv6 ULA → HTTP_BLOCKED_HOST
 *  4. fetch con AbortController para timeout → HTTP_TIMEOUT
 *  5. Stream del body con cap → HTTP_BODY_TOO_LARGE
 *
 * El rate limiter NO vive aquí — se compone via wrapper en `RateLimitedHttp`
 * (task 4). Esto deja `SandboxedHttpService` testeable sin tocar tiempo
 * fake y mantiene una responsabilidad por clase.
 */

/// Defaults expuestos para tests + telemetría. Caps DUROS viven en
/// `module-manifest.schema.ts` (`HTTP_CAPS.*`) — el manifest ya rechaza
/// cualquier valor que los supere.
export const HTTP_DEFAULTS = {
  TIMEOUT_MS: 15_000,
  MAX_TIMEOUT_MS: 60_000,
  BODY_BYTES: 10 * 1024 * 1024, // 10 MB
} as const;

@Injectable()
export class SandboxedHttpService {
  private readonly logger = new Logger(SandboxedHttpService.name);

  /// Construye un cliente HTTP scoped a un módulo. Cada request entrante
  /// pide su propio cliente porque el `signal` ata a la lifetime del reply
  /// de Fastify — si el usuario cierra la pestaña, abortamos in-flight.
  /// `signal` es opcional para soportar uso desde `onInstall` lifecycle.
  build(
    moduleName: string,
    manifestHttp: ModuleHttpConfig,
    requestSignal?: AbortSignal,
  ): SandboxedHttp {
    return new ScopedSandboxedHttp(this.logger, moduleName, manifestHttp, requestSignal);
  }
}

class ScopedSandboxedHttp implements SandboxedHttp {
  constructor(
    private readonly logger: Logger,
    private readonly moduleName: string,
    private readonly manifestHttp: ModuleHttpConfig,
    private readonly parentSignal?: AbortSignal,
  ) {}

  get(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    return this.send('GET', url, opts);
  }

  post(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    return this.send('POST', url, opts);
  }

  private async send(
    method: 'GET' | 'POST',
    rawUrl: string,
    opts: HttpRequestOptions,
  ): Promise<HttpResponse> {
    const url = parseUrl(rawUrl);
    assertHostAllowed(url.hostname, this.manifestHttp);
    await assertNotPrivateIp(url.hostname);

    const timeoutMs = clampTimeout(opts.timeoutMs);
    const maxBodyBytes = clampBodyBytes(opts.maxBodyBytes, this.manifestHttp.maxBodyBytes);

    // Combinamos el signal del caller (cancel del job, etc.), el parent
    // signal del dispatcher (cliente cerró la conexión) y el timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new HttpError('HTTP_TIMEOUT', `Request a ${url.host} excedió ${timeoutMs}ms.`)), timeoutMs);
    timer.unref();
    const onParentAbort = () => ctrl.abort(this.parentSignal?.reason ?? new HttpError('HTTP_ABORTED', 'Parent signal abortó la request (cliente cerró la conexión).'));
    const onCallerAbort = () => ctrl.abort(opts.signal?.reason ?? new HttpError('HTTP_ABORTED', 'Caller signal abortó la request.'));
    if (this.parentSignal) {
      if (this.parentSignal.aborted) onParentAbort();
      else this.parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    if (opts.signal) {
      if (opts.signal.aborted) onCallerAbort();
      else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const headers = buildHeaders(opts.headers, this.moduleName);

    const startedAt = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body,
        signal: ctrl.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      throw normalizeFetchError(err, url.host, timeoutMs);
    }

    let bytesRead = 0;
    let bodyText: string;
    try {
      bodyText = await readBodyCapped(resp, maxBodyBytes, (b) => {
        bytesRead = b;
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      throw normalizeFetchError(err, url.host, timeoutMs);
    } finally {
      clearTimeout(timer);
      this.parentSignal?.removeEventListener('abort', onParentAbort);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }

    const ms = Date.now() - startedAt;
    this.logger.log(
      `[mod:${this.moduleName}] ${method} ${url.host}${url.pathname} → ${resp.status} (${ms}ms, ${bytesRead}B)`,
    );

    return {
      status: resp.status,
      headers: headersToRecord(resp.headers),
      body: bodyText,
      bytesRead,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (puros, exportados para tests)
// ─────────────────────────────────────────────────────────────────────────────

function parseUrl(raw: string): URL {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new HttpError('HTTP_INVALID_URL', `Protocolo no soportado: ${u.protocol} (solo http/https).`);
    }
    return u;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError('HTTP_INVALID_URL', `URL inválida: ${raw}`, err);
  }
}

/// Match de host contra `manifestHttp.allowedHosts`. Soporta:
///  - `*` → cualquier host (sujeto al SSRF guard que viene después)
///  - `*.dominio.tld` → cualquier subdominio de `dominio.tld` (NO matchea el dominio raíz)
///  - `dominio.tld` → exacto, case-insensitive
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const pattern of allowedHosts) {
    const p = pattern.toLowerCase();
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(2); // 'cliente.com'
      if (h.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (h === p) return true;
  }
  return false;
}

function assertHostAllowed(host: string, manifestHttp: ModuleHttpConfig): void {
  if (!isHostAllowed(host, manifestHttp.allowedHosts)) {
    throw new HttpError(
      'HTTP_BLOCKED_HOST',
      `Host "${host}" no está en la allowlist del manifest (allowedHosts: ${JSON.stringify(manifestHttp.allowedHosts)}).`,
    );
  }
}

/// SSRF guard. Bloquea privadas/loopback/link-local/IPv6 ULA. Si el host
/// es ya una IP literal, la chequea directo; si es DNS name, hace lookup.
/// Resolver IP también bloquea attacker-controlled DNS rebinding parcialmente
/// — para defensa total habría que reusar la IP en el connect, pero `fetch`
/// nativo no expone ese hook. El gap se mitiga con allowlist por host.
async function assertNotPrivateIp(hostname: string): Promise<void> {
  const literal = isIP(hostname);
  if (literal === 4 || literal === 6) {
    if (isPrivateIp(hostname)) {
      throw new HttpError(
        'HTTP_BLOCKED_HOST',
        `IP privada/reservada bloqueada por SSRF guard: ${hostname}`,
      );
    }
    return;
  }
  let resolved: { address: string; family: number };
  try {
    resolved = await dnsLookup(hostname);
  } catch (err) {
    throw new HttpError('HTTP_NETWORK', `DNS lookup falló para ${hostname}: ${(err as Error).message}`, err);
  }
  if (isPrivateIp(resolved.address)) {
    throw new HttpError(
      'HTTP_BLOCKED_HOST',
      `Host "${hostname}" resuelve a IP privada/reservada (${resolved.address}) — bloqueado por SSRF guard.`,
    );
  }
}

/// True si la IP cae en cualquier rango privado, loopback, link-local,
/// reservado, IPv6 ULA o IPv6 link-local. Cobertura conservadora
/// — preferimos un falso positivo (rechazar) que dejar pasar un escape.
export function isPrivateIp(ip: string): boolean {
  // IPv4 mapped en IPv6 (::ffff:127.0.0.1) → reaplica reglas IPv4
  const v4Mapped = ip.match(/^::ffff:([\d.]+)$/i);
  if (v4Mapped) return isPrivateIp(v4Mapped[1]!);

  if (isIP(ip) === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
    if (a === 224) return true;                          // 224.0.0.0/4 multicast
    if (a >= 240) return true;                           // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
    return false;
  }

  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;          // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
    if (lower.startsWith('ff')) return true;                     // multicast ff00::/8
    return false;
  }

  // Si no es IP válida, conservador: bloquear.
  return true;
}

function clampTimeout(requested: number | undefined): number {
  const v = requested ?? HTTP_DEFAULTS.TIMEOUT_MS;
  if (v <= 0) return HTTP_DEFAULTS.TIMEOUT_MS;
  if (v > HTTP_DEFAULTS.MAX_TIMEOUT_MS) return HTTP_DEFAULTS.MAX_TIMEOUT_MS;
  return v;
}

function clampBodyBytes(requested: number | undefined, manifestCap: number): number {
  const v = requested ?? HTTP_DEFAULTS.BODY_BYTES;
  if (v <= 0) return HTTP_DEFAULTS.BODY_BYTES;
  if (v > manifestCap) return manifestCap;
  return v;
}

function buildHeaders(
  caller: Record<string, string> | undefined,
  moduleName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (caller) {
    for (const [k, v] of Object.entries(caller)) {
      const lower = k.toLowerCase();
      // Bloqueamos headers que el módulo NO debe poder controlar — el host
      // los reescribe siempre.
      if (lower === 'host' || lower === 'user-agent') continue;
      out[k] = v;
    }
  }
  out['User-Agent'] = `Didacta-Module/${moduleName}`;
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/// Lee el body con cap. Si el upstream devuelve `Content-Length` mayor que
/// el cap, abortamos antes de leer. Si no hay header, vamos leyendo chunks
/// y abortamos en cuanto superamos. Reporta los bytes efectivamente leídos
/// vía callback (telemetría).
async function readBodyCapped(
  resp: Response,
  maxBytes: number,
  onBytes: (n: number) => void,
): Promise<string> {
  const declaredLen = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new HttpError(
      'HTTP_BODY_TOO_LARGE',
      `Content-Length declarado (${declaredLen}B) supera el cap (${maxBytes}B).`,
    );
  }

  if (!resp.body) {
    onBytes(0);
    return '';
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignored — el upstream ya cortó.
      }
      throw new HttpError(
        'HTTP_BODY_TOO_LARGE',
        `Body excedió el cap durante el stream (>${maxBytes}B leídos antes de abortar).`,
      );
    }
    chunks.push(value);
  }
  onBytes(total);
  return new TextDecoder('utf-8').decode(concatChunks(chunks, total));
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function normalizeFetchError(err: unknown, host: string, timeoutMs: number): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as Error & { code?: string; cause?: { code?: string } };
  const causeCode = e?.cause?.code;
  const code = e?.code ?? causeCode;
  // AbortError con razón HttpError ya formateado
  if (e?.name === 'AbortError') {
    const reason = (e as unknown as { reason?: unknown }).reason;
    if (reason instanceof HttpError) return reason;
    return new HttpError('HTTP_ABORTED', `Request a ${host} abortada.`, err);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpError('HTTP_NETWORK', `DNS no resolvió host ${host}.`, err);
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new HttpError('HTTP_NETWORK', `Conexión a ${host} rechazada (${code}).`, err);
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new HttpError('HTTP_TIMEOUT', `Timeout (${timeoutMs}ms) en respuesta de ${host}.`, err);
  }
  return new HttpError('HTTP_NETWORK', `Error de red contra ${host}: ${e?.message ?? String(err)}`, err);
}
