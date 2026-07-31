/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
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
 * Adapter para Ollama autoalojado (on-premise / aire-gapped).
 *
 * No requiere API key (apiKey puede ser cualquier string vacío). El campo
 * `baseUrl` apunta al servidor Ollama del cliente (ej. http://ollama.local:11434).
 *
 * Útil para tenants con compliance estricto que NO pueden enviar contenido
 * a APIs externas (sanidad, sector público, defensa).
 *
 * Modelos disponibles dependen de los que el admin tenga descargados con
 * `ollama pull <model>`. Embeddings con dim variable según modelo
 * (nomic-embed-text=768, mxbai-embed-large=1024, etc.).
 */
export class OllamaAdapter implements AiProviderAdapter {
  readonly id: ProviderId = 'ollama';
  readonly capabilities: ReadonlyArray<Capability> = ['chat', 'embed'];

  private defaultBaseUrl = 'http://localhost:11434';
  private defaultChatModel = 'llama3.3';
  private defaultEmbedModel = 'nomic-embed-text';

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
      options: {
        temperature: input.temperature ?? 0.3,
        num_predict: input.maxTokens ?? 1500,
      },
      stream: false,
    };

    const json = await aiFetchJson<{
      message: { content: string };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    }>(
      `${baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      },
      this.id,
    );

    return {
      content: json.message.content,
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
      },
      stopReason: json.done_reason ?? 'stop',
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
        dimension: 768,
      };
    }
    const baseUrl = config.baseUrl ?? this.defaultBaseUrl;
    const model = config.model || this.defaultEmbedModel;

    const json = await aiFetchJson<{
      embeddings: number[][];
    }>(
      `${baseUrl}/api/embed`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify({ model, input: input.texts }),
      },
      this.id,
    );

    const embeddings = json.embeddings ?? [];
    return {
      embeddings,
      usage: {
        // Ollama no devuelve count en /api/embed; aproximamos
        totalTokens: input.texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
      },
      provider: this.id,
      model,
      dimension: embeddings[0]?.length ?? 768,
    };
  }
}
