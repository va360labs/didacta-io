import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyCipher } from '../src/ai/api-key-cipher';
import { AiConfigResolver } from '../src/ai/config-resolver';
import { ProviderNotConfiguredError } from '../src/ai/types/contracts';

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
}

const KEY = 'b'.repeat(64);

function makeCipher() {
  process.env.AI_CONFIG_ENCRYPTION_KEY = KEY;
  const c = new ApiKeyCipher(makeLogger());
  c.onModuleInit();
  return c;
}

describe('AiConfigResolver', () => {
  const envBackup: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [
      'AI_CONFIG_ENCRYPTION_KEY',
      'DEFAULT_AI_CHAT_PROVIDER',
      'DEFAULT_AI_CHAT_API_KEY',
      'DEFAULT_AI_CHAT_MODEL',
      'DEFAULT_AI_CHAT_BASE_URL',
      'DEFAULT_AI_EMBED_PROVIDER',
      'DEFAULT_AI_EMBED_API_KEY',
    ]) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('usa fila del tenant si existe y enabled=true', async () => {
    const cipher = makeCipher();
    const enc = cipher.encrypt('sk-tenant-key');
    const prisma = {
      tenantAiProviderConfig: {
        findFirst: vi.fn(async () => ({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          apiKeyCipher: enc.cipher,
          apiKeyIv: enc.iv,
          apiKeyTag: enc.tag,
          baseUrl: null,
          extraHeaders: {},
        })),
      },
    } as never;

    const r = new AiConfigResolver(prisma, cipher, makeLogger());
    const config = await r.resolve('tenant-1', 'chat');
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-opus-4-7');
    expect(config.apiKey).toBe('sk-tenant-key');
  });

  it('cae a default global del env si no hay fila', async () => {
    const cipher = makeCipher();
    process.env.DEFAULT_AI_CHAT_PROVIDER = 'openai';
    process.env.DEFAULT_AI_CHAT_API_KEY = 'sk-default-global';
    process.env.DEFAULT_AI_CHAT_MODEL = 'gpt-4o-mini';
    process.env.DEFAULT_AI_CHAT_BASE_URL = 'https://custom-proxy.x';

    const prisma = {
      tenantAiProviderConfig: { findFirst: vi.fn(async () => null) },
    } as never;
    const r = new AiConfigResolver(prisma, cipher, makeLogger());
    const config = await r.resolve('tenant-A', 'chat');
    expect(config.provider).toBe('openai');
    expect(config.apiKey).toBe('sk-default-global');
    expect(config.model).toBe('gpt-4o-mini');
    expect(config.baseUrl).toBe('https://custom-proxy.x');
  });

  it('lanza ProviderNotConfiguredError si no hay fila ni default', async () => {
    const cipher = makeCipher();
    const prisma = {
      tenantAiProviderConfig: { findFirst: vi.fn(async () => null) },
    } as never;
    const r = new AiConfigResolver(prisma, cipher, makeLogger());
    await expect(r.resolve('tenant-X', 'embed')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('si decrypt falla, fallback al default global (no rompe)', async () => {
    const cipher = makeCipher();
    process.env.DEFAULT_AI_CHAT_PROVIDER = 'openai';
    process.env.DEFAULT_AI_CHAT_API_KEY = 'sk-fallback';

    const prisma = {
      tenantAiProviderConfig: {
        findFirst: vi.fn(async () => ({
          provider: 'openai',
          model: '',
          apiKeyCipher: 'corrupted-cipher',
          apiKeyIv: '00'.repeat(12),
          apiKeyTag: '00'.repeat(16),
          baseUrl: null,
          extraHeaders: {},
        })),
      },
    } as never;

    const r = new AiConfigResolver(prisma, cipher, makeLogger());
    const config = await r.resolve('tenant-corrupt', 'chat');
    // Cae al default global
    expect(config.apiKey).toBe('sk-fallback');
  });

  it('purpose distintos pueden tener providers distintos', async () => {
    const cipher = makeCipher();
    process.env.DEFAULT_AI_CHAT_PROVIDER = 'anthropic';
    process.env.DEFAULT_AI_CHAT_API_KEY = 'sk-anth';
    process.env.DEFAULT_AI_EMBED_PROVIDER = 'voyage';
    process.env.DEFAULT_AI_EMBED_API_KEY = 'voy';

    const prisma = {
      tenantAiProviderConfig: { findFirst: vi.fn(async () => null) },
    } as never;
    const r = new AiConfigResolver(prisma, cipher, makeLogger());
    const chat = await r.resolve('t', 'chat');
    const embed = await r.resolve('t', 'embed');
    expect(chat.provider).toBe('anthropic');
    expect(embed.provider).toBe('voyage');
  });
});
