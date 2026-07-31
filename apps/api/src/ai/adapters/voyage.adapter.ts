/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  ProviderUnsupportedCapabilityError,
  type AiProviderAdapter,
  type Capability,
  type ChatCompletionResult,
  type EmbedInput,
  type EmbedResult,
  type ProviderId,
  type ResolvedProviderConfig,
} from '../types/contracts';
import { aiFetchJson } from './http-helper';

/**
 * Adapter para Voyage AI. Solo embeddings (no chat). Modelos como
 * voyage-3 (dim 1024) y voyage-3-large (dim 1024) son SOTA en retrieval.
 */
export class VoyageAdapter implements AiProviderAdapter {
  readonly id: ProviderId = 'voyage';
  readonly capabilities: ReadonlyArray<Capability> = ['embed'];

  private defaultBaseUrl = 'https://api.voyageai.com/v1';
  private defaultModel = 'voyage-3';

  async chat(): Promise<ChatCompletionResult> {
    throw new ProviderUnsupportedCapabilityError(this.id, 'chat');
  }

  async embed(input: EmbedInput, config: ResolvedProviderConfig): Promise<EmbedResult> {
    if (input.texts.length === 0) {
      return {
        embeddings: [],
        usage: { totalTokens: 0 },
        provider: this.id,
        model: config.model || this.defaultModel,
        dimension: 1024,
      };
    }
    const baseUrl = config.baseUrl ?? this.defaultBaseUrl;
    const model = config.model || this.defaultModel;

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
        body: JSON.stringify({
          model,
          input: input.texts,
          input_type: config.embedInputType ?? 'document',
        }),
      },
      this.id,
    );

    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      embeddings: sorted.map((d) => d.embedding),
      usage: { totalTokens: json.usage.total_tokens },
      provider: this.id,
      model,
      dimension: sorted[0]?.embedding.length ?? 1024,
    };
  }
}
