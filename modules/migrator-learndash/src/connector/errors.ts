/**
 * Errores tipados del connector.
 * El controller mappea estos a HTTP status del cliente final.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** DNS, TCP refused, timeout absoluto, fetch network error. */
export class SourceUnreachableError extends ConnectorError {}

/** 401 / 403 — credenciales inválidas o sin permisos. */
export class AuthFailedError extends ConnectorError {}

/** 429 tras agotar reintentos. */
export class RateLimitExceededError extends ConnectorError {}

/** Body no JSON, schema fail, content-type inesperado. */
export class MalformedResponseError extends ConnectorError {}

/** 404 sobre un recurso requerido. */
export class NotFoundError extends ConnectorError {}

/** 5xx tras agotar reintentos. */
export class ServerError extends ConnectorError {}

/** Caller pasó AbortSignal y se canceló. */
export class AbortedError extends ConnectorError {
  constructor(message = 'request abortada') {
    super(message);
  }
}
