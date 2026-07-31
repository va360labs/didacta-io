import { describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from '../src/ai/ai-gateway.service';
import { ProviderRegistry } from '../src/ai/provider-registry';
import {
  AiGatewayError,
  ProviderUnsupportedCapabilityError,
  type AiProviderAdapter,
} from '../src/ai/types/contracts';

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
}

function makeRegistry(adapter: AiProviderAdapter): ProviderRegistry {
  const r = new ProviderRegistry();
  // Override del adapter del provider que vayamos a usar
  r.register(adapter);
  return r;
}

function makeResolver(config: { provider: string; model?: string; apiKey?: string }): never {
  return {
    resolve: vi.fn(async () => ({
      provider: config.provider,
      model: config.model ?? '',
      apiKey: config.apiKey ?? 'k',
    })),
  } as never;
}

describe('AiGatewayService', () => {
  it('chat() resuelve config del tenant, llama al adapter y devuelve resultado', async () => {
    const fakeAdapter: AiProviderAdapter = {
      id: 'openai',
      capabilities: ['chat', 'embed'],
      chat: vi.fn(async () => ({
        content: 'respuesta',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'stop',
        provider: 'openai',
        model: 'gpt-4o',
      })),
      embed: vi.fn(),
    } as never;

    const gw = new AiGatewayService(
      makeRegistry(fakeAdapter),
      makeResolver({ provider: 'openai', model: 'gpt-4o' }),
      makeLogger(),
    );
    const r = await gw.chat({
      tenantId: 't1',
      input: { system: 'S', messages: [{ role: 'user', content: 'h' }] },
    });
    expect(r.content).toBe('respuesta');
    expect(fakeAdapter.chat).toHaveBeenCalled();
  });

  it('embed() funciona análogamente para embeddings', async () => {
    const fakeAdapter: AiProviderAdapter = {
      id: 'openai',
      capabilities: ['embed'],
      chat: vi.fn(),
      embed: vi.fn(async () => ({
        embeddings: [[0.1, 0.2]],
        usage: { totalTokens: 3 },
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimension: 2,
      })),
    } as never;
    const gw = new AiGatewayService(
      makeRegistry(fakeAdapter),
      makeResolver({ provider: 'openai' }),
      makeLogger(),
    );
    const r = await gw.embed({ tenantId: 't1', input: { texts: ['a'] } });
    expect(r.embeddings).toHaveLength(1);
    expect(fakeAdapter.embed).toHaveBeenCalled();
  });

  it('chat() lanza AiGatewayError si el provider resuelto no está registrado', async () => {
    const r = new ProviderRegistry();
    const gw = new AiGatewayService(r, makeResolver({ provider: 'inexistente' }), makeLogger());
    await expect(
      gw.chat({ tenantId: 't', input: { system: 's', messages: [] } }),
    ).rejects.toBeInstanceOf(AiGatewayError);
  });

  it('chat() lanza ProviderUnsupportedCapabilityError si el provider no soporta chat', async () => {
    const embedOnly: AiProviderAdapter = {
      id: 'voyage',
      capabilities: ['embed'],
      chat: vi.fn(),
      embed: vi.fn(),
    } as never;
    const gw = new AiGatewayService(
      makeRegistry(embedOnly),
      makeResolver({ provider: 'voyage' }),
      makeLogger(),
    );
    await expect(
      gw.chat({ tenantId: 't', input: { system: 's', messages: [] } }),
    ).rejects.toBeInstanceOf(ProviderUnsupportedCapabilityError);
  });

  it('embed() lanza si provider solo soporta chat', async () => {
    const chatOnly: AiProviderAdapter = {
      id: 'anthropic',
      capabilities: ['chat'],
      chat: vi.fn(),
      embed: vi.fn(),
    } as never;
    const gw = new AiGatewayService(
      makeRegistry(chatOnly),
      makeResolver({ provider: 'anthropic' }),
      makeLogger(),
    );
    await expect(gw.embed({ tenantId: 't', input: { texts: ['x'] } })).rejects.toBeInstanceOf(
      ProviderUnsupportedCapabilityError,
    );
  });

  it('chat() loga error y re-lanza si el adapter falla', async () => {
    const failingAdapter: AiProviderAdapter = {
      id: 'openai',
      capabilities: ['chat'],
      chat: vi.fn(async () => {
        throw new Error('boom');
      }),
      embed: vi.fn(),
    } as never;
    const logger = makeLogger();
    const gw = new AiGatewayService(
      makeRegistry(failingAdapter),
      makeResolver({ provider: 'openai' }),
      logger,
    );
    await expect(gw.chat({ tenantId: 't', input: { system: 's', messages: [] } })).rejects.toThrow(
      /boom/,
    );
    // Verificamos que el logger.error fue llamado con info útil
    expect(logger.error).toHaveBeenCalled();
  });
});
