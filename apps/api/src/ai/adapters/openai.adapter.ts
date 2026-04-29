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

    const body = {
      model,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: input.temperature ?? 0.3,
      max_tokens: input.maxTokens ?? 1500,
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

  override async embed(): Promise<EmbedResult> {
    throw new ProviderUnsupportedCapabilityError(this.id, 'embed');
  }
}

/** OpenRouter da acceso unificado a 100+ modelos vía API OpenAI-compatible. */
export class OpenRouterAdapter extends OpenAiAdapter {
  override readonly id: ProviderId = 'openrouter';
  override readonly capabilities: ReadonlyArray<Capability> = ['chat'];
  protected override defaultBaseUrl = 'https://openrouter.ai/api/v1';
  protected override defaultChatModel = 'openai/gpt-4o-mini';

  override async embed(): Promise<EmbedResult> {
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
