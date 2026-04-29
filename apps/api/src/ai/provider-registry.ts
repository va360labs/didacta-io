import { Injectable } from '@nestjs/common';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { OllamaAdapter } from './adapters/ollama.adapter';
import {
  GroqAdapter,
  MistralAdapter,
  OpenAiAdapter,
  OpenRouterAdapter,
} from './adapters/openai.adapter';
import { VoyageAdapter } from './adapters/voyage.adapter';
import { type AiProviderAdapter, type ProviderId } from './types/contracts';

/**
 * Registro central de adapters. Singleton inyectado por Nest.
 *
 * Todos los providers built-in se registran al inicio. Para añadir un provider
 * nuevo: crear adapter en `adapters/`, registrarlo aquí en el constructor.
 */
@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, AiProviderAdapter>();

  constructor() {
    this.register(new OpenAiAdapter());
    this.register(new AnthropicAdapter());
    this.register(new GeminiAdapter());
    this.register(new OpenRouterAdapter());
    this.register(new MistralAdapter());
    this.register(new GroqAdapter());
    this.register(new OllamaAdapter());
    this.register(new VoyageAdapter());
  }

  register(adapter: AiProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): AiProviderAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  /** Lista de providers registrados con sus capabilities. Útil para UI admin. */
  list(): Array<{ id: ProviderId; capabilities: ReadonlyArray<'chat' | 'embed'> }> {
    return Array.from(this.adapters.values()).map((a) => ({
      id: a.id,
      capabilities: a.capabilities,
    }));
  }

  /** Adapters que soportan una capability concreta. Útil para UI de selección. */
  withCapability(capability: 'chat' | 'embed'): AiProviderAdapter[] {
    return Array.from(this.adapters.values()).filter((a) => a.capabilities.includes(capability));
  }
}
