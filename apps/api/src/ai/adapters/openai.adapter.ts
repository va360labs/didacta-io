/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  ProviderUnsupportedCapabilityError,
  type AiProviderAdapter,
  type Capability,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type EmbedInput,
  type EmbedResult,
  type ProviderId,
  type ResolvedProviderConfig,
} from '../types/contracts';
import { aiFetchJson } from './http-helper';

/**
 * True si el modelo pertenece a las familias que sustituyeron `max_tokens` por
 * `max_completion_tokens` en /chat/completions: gpt-5.x y los razonadores
 * o1/o3/o4. Se comprueba por prefijo porque OpenAI publica variantes nuevas
 * (`-mini`, `-nano`, fechadas) sin cambiar la raíz del nombre.
 *
 * Exportada para poder cubrirla con tests sin levantar el adapter entero.
 */
export function usesCompletionTokensParam(model: string): boolean {
  const m = model.trim().toLowerCase();
  // Los proveedores compatibles-OpenAI prefijan con el vendor
  // ("openai/gpt-5.4-mini" en OpenRouter): nos quedamos con la última parte.
  const bare = m.includes('/') ? (m.split('/').pop() ?? m) : m;
  return /^(gpt-5|o1|o3|o4)(\b|[-.])/.test(bare);
}

/**
 * Adapter para OpenAI (chat completions + embeddings).
 *
 * Su API es de facto estándar para muchos providers compatibles
 * (Groq, OpenRouter, Mistral, Together AI, etc.). Reutilizamos este adapter
 * con `baseUrl` distinto para esos casos — ver subclases simples al final.
 */
export class OpenAiAdapter implements AiProviderAdapter {
  readonly id: ProviderId = 'openai';
  readonly capabilities: ReadonlyArray<Capability> = ['chat', 'embed'];

  protected defaultBaseUrl = 'https://api.openai.com/v1';
  protected defaultChatModel = 'gpt-4o-mini';
  protected defaultEmbedModel = 'text-embedding-3-small';

  async chat(
    input: ChatCompletionInput,
    config: ResolvedProviderConfig,
  ): Promise<ChatCompletionResult> {
    const baseUrl = config.baseUrl ?? this.defaultBaseUrl;
    const model = config.model || this.defaultChatModel;

    // Los modelos gpt-5.x y la familia de razonadores (o1/o3/o4) rechazan
    // `max_tokens` con 400 `unsupported_parameter` y exigen
    // `max_completion_tokens`. Además sólo aceptan la `temperature` por
    // defecto, así que ni la mandamos.
    const nuevaApi = usesCompletionTokensParam(model);
    const limite = input.maxTokens ?? 1500;

    const body = {
      model,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...(nuevaApi
        ? { max_completion_tokens: limite }
        : { temperature: input.temperature ?? 0.3, max_tokens: limite }),
    };

    const json = await aiFetchJson<{
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    }>(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      },
      this.id,
    );

    const first = json.choices[0];
    return {
      content: first?.message.content ?? '',
      usage: {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
      },
      stopReason: first?.finish_reason ?? 'unknown',
      provider: this.id,
      model,
    };
  }

  async embed(input: EmbedInput, config: ResolvedProviderConfig): Promise<EmbedResult> {
    if (input.texts.length === 0) {
      return {
        embeddings: [],
        usage: { totalTokens: 0 },
        provider: this.id,
        model: config.model || this.defaultEmbedModel,
        dimension: this.dimensionFor(config.model || this.defaultEmbedModel),
      };
    }
    const baseUrl = config.baseUrl ?? this.defaultBaseUrl;
    const model = config.model || this.defaultEmbedModel;

    const json = await aiFetchJson<{
      data: Array<{ embedding: number[]; index: number }>;
      usage: { total_tokens: number };
    }>(
      `${baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify({ model, input: input.texts }),
      },
      this.id,
    );

    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      embeddings: sorted.map((d) => d.embedding),
      usage: { totalTokens: json.usage.total_tokens },
      provider: this.id,
      model,
      dimension: sorted[0]?.embedding.length ?? this.dimensionFor(model),
    };
  }

  protected dimensionFor(model: string): number {
    if (model === 'text-embedding-3-large') return 3072;
    if (model === 'text-embedding-3-small') return 1536;
    if (model === 'text-embedding-ada-002') return 1536;
    return 1536;
  }
}

/** Groq usa la API de OpenAI con su propio endpoint. Solo chat, no embeddings. */
export class GroqAdapter extends OpenAiAdapter {
  override readonly id: ProviderId = 'groq';
  override readonly capabilities: ReadonlyArray<Capability> = ['chat'];
  protected override defaultBaseUrl = 'https://api.groq.com/openai/v1';
  protected override defaultChatModel = 'llama-3.3-70b-versatile';

  // Los parámetros se declaran aunque no se usen: sin ellos el override
  // estrecha la firma pública del adapter a `() => …` y llamarlo como manda
  // el contrato (`embed(input, config)`) deja de compilar en el subtipo.
  override async embed(_input: EmbedInput, _config: ResolvedProviderConfig): Promise<EmbedResult> {
    throw new ProviderUnsupportedCapabilityError(this.id, 'embed');
  }
}

/** OpenRouter da acceso unificado a 100+ modelos vía API OpenAI-compatible. */
export class OpenRouterAdapter extends OpenAiAdapter {
  override readonly id: ProviderId = 'openrouter';
  override readonly capabilities: ReadonlyArray<Capability> = ['chat'];
  protected override defaultBaseUrl = 'https://openrouter.ai/api/v1';
  protected override defaultChatModel = 'openai/gpt-4o-mini';

  // Idem GroqAdapter: la firma completa mantiene el contrato del subtipo.
  override async embed(_input: EmbedInput, _config: ResolvedProviderConfig): Promise<EmbedResult> {
    throw new ProviderUnsupportedCapabilityError(this.id, 'embed');
  }
}

/** Mistral La Plateforme. API compatible OpenAI para chat + embeddings (mistral-embed dim 1024). */
export class MistralAdapter extends OpenAiAdapter {
  override readonly id: ProviderId = 'mistral';
  override readonly capabilities: ReadonlyArray<Capability> = ['chat', 'embed'];
  protected override defaultBaseUrl = 'https://api.mistral.ai/v1';
  protected override defaultChatModel = 'mistral-large-latest';
  protected override defaultEmbedModel = 'mistral-embed';

  protected override dimensionFor(model: string): number {
    if (model === 'mistral-embed') return 1024;
    return 1024;
  }
}
