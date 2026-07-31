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
 * Adapter para Google Generative AI (Gemini).
 *
 * Diferencias clave con OpenAI/Anthropic:
 *   - Endpoint y body completamente distintos.
 *   - "Roles" se llaman 'user' y 'model' (no 'assistant').
 *   - System prompt va en `systemInstruction` aparte.
 *   - Embeddings: dim depende del modelo (text-embedding-004 = 768).
 */
export class GeminiAdapter implements AiProviderAdapter {
  readonly id: ProviderId = 'gemini';
  readonly capabilities: ReadonlyArray<Capability> = ['chat', 'embed'];

  private defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private defaultChatModel = 'gemini-2.0-flash-exp';
  private defaultEmbedModel = 'text-embedding-004';

  async chat(
    input: ChatCompletionInput,
    config: ResolvedProviderConfig,
  ): Promise<ChatCompletionResult> {
    const baseUrl = config.baseUrl ?? this.defaultBaseUrl;
    const model = config.model || this.defaultChatModel;

    const body = {
      systemInstruction: { role: 'user', parts: [{ text: input.system }] },
      contents: input.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: input.temperature ?? 0.3,
        maxOutputTokens: input.maxTokens ?? 1500,
      },
    };

    const json = await aiFetchJson<{
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
        finishReason: string;
      }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    }>(
      `${baseUrl}/models/${model}:generateContent?key=${config.apiKey}`,
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

    const first = json.candidates[0];
    const content = first?.content.parts.map((p) => p.text).join('') ?? '';

    return {
      content,
      usage: {
        inputTokens: json.usageMetadata.promptTokenCount,
        outputTokens: json.usageMetadata.candidatesTokenCount,
      },
      stopReason: first?.finishReason ?? 'unknown',
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

    // Gemini batch embedContent no soporta batch real en v1beta de forma uniforme;
    // hacemos requests paralelos. Para volumen alto, refactor con batchEmbedContents.
    const requests = input.texts.map((text) =>
      aiFetchJson<{
        embedding: { values: number[] };
      }>(
        `${baseUrl}/models/${model}:embedContent?key=${config.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text }] },
          }),
        },
        this.id,
      ),
    );

    const results = await Promise.all(requests);
    const embeddings = results.map((r) => r.embedding.values);

    return {
      embeddings,
      usage: {
        // Gemini no devuelve token count en embed; aproximamos chars/4
        totalTokens: input.texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
      },
      provider: this.id,
      model,
      dimension: embeddings[0]?.length ?? 768,
    };
  }
}
