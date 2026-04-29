/**
 * Contratos del AI Gateway (LMS-90.B). Cualquier provider que se quiera
 * añadir implementa estas interfaces y se registra en `ProviderRegistry`.
 *
 * Diseño:
 *   - Dos capabilities ortogonales: `chat` y `embed`. Un provider puede
 *     soportar una o ambas.
 *   - Configuración aislada por (tenant, purpose). El gateway resuelve qué
 *     adapter usar para cada llamada según la config persistida.
 *   - Errores tipados para que el caller distinga rate limits, auth fallida,
 *     timeouts, etc., y aplique retry/backoff/fallback adecuado.
 */

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'mistral'
  | 'groq'
  | 'ollama'
  | 'voyage';

export type Purpose = 'chat' | 'embed';

export type Capability = 'chat' | 'embed';

// ─── Chat ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionInput {
  /** System prompt (instrucciones generales del modelo). */
  system: string;
  /** Histórico de mensajes alternando user/assistant. */
  messages: ChatMessage[];
  /** Temperature (0-2 según provider). */
  temperature?: number;
  /** Tokens máximos en la respuesta. */
  maxTokens?: number;
}

export interface ChatCompletionResult {
  /** Texto completo de la respuesta. */
  content: string;
  /** Tokens consumidos para enforce de cuota / cost tracking. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Razón por la que el modelo terminó (provider-specific string normalizado). */
  stopReason: string;
  /** Provider real que atendió (informativo / telemetría). */
  provider: ProviderId;
  /** Modelo real usado (puede diferir si el adapter hace mapping). */
  model: string;
}

// ─── Embeddings ──────────────────────────────────────────────────────

export interface EmbedInput {
  /** Texto(s) a embebber. Pasar array si batch (más eficiente). */
  texts: string[];
}

export interface EmbedResult {
  /** Embedding por cada texto de input, mismo orden. */
  embeddings: number[][];
  /** Tokens consumidos para cost tracking. */
  usage: {
    totalTokens: number;
  };
  provider: ProviderId;
  model: string;
  /** Dimensión de los vectores devueltos. Crítico para validar contra el schema pgvector. */
  dimension: number;
}

// ─── Adapter contract ────────────────────────────────────────────────

export interface AiProviderAdapter {
  /** Identificador estable del provider. */
  readonly id: ProviderId;
  /** Capabilities soportadas. Algunos providers solo chat (Groq), otros solo embed (Voyage). */
  readonly capabilities: ReadonlyArray<Capability>;

  /** Llamada chat. Lanza si el adapter no soporta `chat`. */
  chat(input: ChatCompletionInput, config: ResolvedProviderConfig): Promise<ChatCompletionResult>;

  /** Llamada embed. Lanza si el adapter no soporta `embed`. */
  embed(input: EmbedInput, config: ResolvedProviderConfig): Promise<EmbedResult>;
}

/**
 * Configuración resuelta para una llamada concreta. La produce el gateway a
 * partir de la config del tenant + defaults globales del env.
 */
export interface ResolvedProviderConfig {
  provider: ProviderId;
  /** Modelo a usar. Default por adapter si null. */
  model: string;
  /** API key real. Cifrada en DB, descifrada en runtime. */
  apiKey: string;
  /** Override de la URL base (autoalojado, proxy, etc.). */
  baseUrl?: string;
  /** Para Voyage: input_type 'document' o 'query'. */
  embedInputType?: 'document' | 'query';
  /** Headers extra (algunos providers exigen `HTTP-Referer`, etc.). */
  extraHeaders?: Record<string, string>;
}

// ─── Errores tipados ─────────────────────────────────────────────────

export class AiGatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly provider?: ProviderId,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

export class ProviderNotConfiguredError extends AiGatewayError {
  constructor(tenantId: string, purpose: Purpose) {
    super(
      'AI_PROVIDER_NOT_CONFIGURED',
      `No hay provider configurado para tenant=${tenantId} purpose=${purpose}.`,
    );
  }
}

export class ProviderUnavailableError extends AiGatewayError {
  constructor(provider: ProviderId, statusCode: number, body: string) {
    super(
      'AI_PROVIDER_UNAVAILABLE',
      `${provider} respondió ${statusCode}: ${body}`,
      provider,
      statusCode,
    );
  }
}

export class ProviderRateLimitError extends AiGatewayError {
  constructor(provider: ProviderId, retryAfterSeconds?: number) {
    super(
      'AI_PROVIDER_RATE_LIMIT',
      `${provider} rate limit. Retry-After: ${retryAfterSeconds ?? 'unknown'}s`,
      provider,
      429,
    );
  }
}

export class ProviderAuthError extends AiGatewayError {
  constructor(provider: ProviderId) {
    super('AI_PROVIDER_AUTH', `${provider}: credenciales inválidas o sin permisos.`, provider, 401);
  }
}

export class ProviderUnsupportedCapabilityError extends AiGatewayError {
  constructor(provider: ProviderId, capability: Capability) {
    super(
      'AI_PROVIDER_UNSUPPORTED_CAPABILITY',
      `${provider} no soporta capability=${capability}.`,
      provider,
    );
  }
}
