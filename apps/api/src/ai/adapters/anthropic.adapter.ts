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
 * Adapter para Anthropic Messages API (Claude). No expone embeddings —
 * para vectorizar usar otro provider (OpenAI, Voyage, Mistral).
 */
export class AnthropicAdapter implements AiProviderAdapter {
  readonly id: ProviderId = 'anthropic';
  readonly capabilities: ReadonlyArray<Capability> = ['chat'];

  private defaultBaseUrl = 'https://api.anthropic.com/v1';
  private defaultModel = 'claude-sonnet-4-6';

  async chat(
    input: ChatCompletionInput,
    config: ResolvedProviderConfig,
  ): Promise<ChatCompletionResult> {
    const baseUrl = config.baseUrl ?? this.defaultBaseUrl;
    const model = config.model || this.defaultModel;

    const body = {
      model,
      max_tokens: input.maxTokens ?? 1500,
      temperature: input.temperature ?? 0.3,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const json = await aiFetchJson<{
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    }>(
      `${baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      },
      this.id,
    );

    const text = json.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');

    return {
      content: text,
      usage: {
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
      },
      stopReason: json.stop_reason,
      provider: this.id,
      model,
    };
  }

  async embed(): Promise<EmbedResult> {
    throw new ProviderUnsupportedCapabilityError(this.id, 'embed');
  }
}
