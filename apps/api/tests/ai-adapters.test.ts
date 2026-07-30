import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../src/ai/adapters/anthropic.adapter';
import { GeminiAdapter } from '../src/ai/adapters/gemini.adapter';
import { OllamaAdapter } from '../src/ai/adapters/ollama.adapter';
import {
  GroqAdapter,
  MistralAdapter,
  OpenAiAdapter,
  OpenRouterAdapter,
  usesCompletionTokensParam,
} from '../src/ai/adapters/openai.adapter';
import { VoyageAdapter } from '../src/ai/adapters/voyage.adapter';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderUnsupportedCapabilityError,
} from '../src/ai/types/contracts';

const baseConfig = (apiKey: string) => ({ provider: 'openai' as const, model: '', apiKey });

describe('OpenAiAdapter', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat() POST a /chat/completions, parsea response y devuelve usage', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toBe('S');
      expect(body.messages[1].content).toBe('Hola');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-x');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'Hola alumno' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      } as Response;
    }) as never;

    const r = await new OpenAiAdapter().chat(
      { system: 'S', messages: [{ role: 'user', content: 'Hola' }] },
      { ...baseConfig('sk-x'), provider: 'openai' },
    );
    expect(r.content).toBe('Hola alumno');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4o-mini');
  });

  it('chat() con gpt-4o-mini manda max_tokens y temperature', async () => {
    let enviado: Record<string, unknown> = {};
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      enviado = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as Response;
    }) as never;

    await new OpenAiAdapter().chat(
      { system: 'S', messages: [{ role: 'user', content: 'Hola' }], maxTokens: 900 },
      { ...baseConfig('sk-x'), provider: 'openai', model: 'gpt-4o-mini' },
    );
    expect(enviado.max_tokens).toBe(900);
    expect(enviado.temperature).toBe(0.3);
    expect(enviado).not.toHaveProperty('max_completion_tokens');
  });

  // Regresión: gpt-5.4-mini devolvía 400 "Unsupported parameter: 'max_tokens'"
  // y el tutor IA respondía 502 a todos los alumnos (2026-07-30).
  it('chat() con gpt-5.x manda max_completion_tokens y omite temperature', async () => {
    let enviado: Record<string, unknown> = {};
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      enviado = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as Response;
    }) as never;

    await new OpenAiAdapter().chat(
      { system: 'S', messages: [{ role: 'user', content: 'Hola' }], maxTokens: 900 },
      { ...baseConfig('sk-x'), provider: 'openai', model: 'gpt-5.4-mini' },
    );
    expect(enviado.max_completion_tokens).toBe(900);
    expect(enviado).not.toHaveProperty('max_tokens');
    expect(enviado).not.toHaveProperty('temperature');
  });

  it('usesCompletionTokensParam distingue las familias nuevas de las viejas', () => {
    for (const m of [
      'gpt-5.4-mini',
      'gpt-5',
      'GPT-5.4-NANO',
      'o1-preview',
      'o3-mini',
      'o4-mini',
      'openai/gpt-5.4-mini',
    ]) {
      expect(usesCompletionTokensParam(m), m).toBe(true);
    }
    for (const m of [
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4-turbo',
      'mistral-large-latest',
      'llama-3.3-70b-versatile',
      'gpt-51-imaginario',
    ]) {
      expect(usesCompletionTokensParam(m), m).toBe(false);
    }
  });

  it('embed() respeta orden por index y devuelve dim', async () => {
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            data: [
              { embedding: [1, 2], index: 1 },
              { embedding: [3, 4], index: 0 },
            ],
            usage: { total_tokens: 4 },
          }),
        }) as Response,
    ) as never;
    const r = await new OpenAiAdapter().embed(
      { texts: ['a', 'b'] },
      { ...baseConfig('sk'), provider: 'openai' },
    );
    expect(r.embeddings).toEqual([
      [3, 4],
      [1, 2],
    ]);
    expect(r.dimension).toBe(2);
    expect(r.usage.totalTokens).toBe(4);
  });

  it('embed() texts vacío no llama HTTP', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as never;
    const r = await new OpenAiAdapter().embed(
      { texts: [] },
      { ...baseConfig('sk'), provider: 'openai' },
    );
    expect(r.embeddings).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('errores HTTP se mapean a tipos: 401 → auth, 429 → rate, 500 → unavailable', async () => {
    const adapter = new OpenAiAdapter();
    global.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          headers: new Headers(),
          text: async () => 'bad key',
        }) as Response,
    ) as never;
    await expect(
      adapter.chat({ system: 's', messages: [] }, { ...baseConfig('x'), provider: 'openai' }),
    ).rejects.toBeInstanceOf(ProviderAuthError);

    global.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '30' }),
          text: async () => 'slow down',
        }) as Response,
    ) as never;
    await expect(
      adapter.chat({ system: 's', messages: [] }, { ...baseConfig('x'), provider: 'openai' }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);

    global.fetch = vi.fn(
      async () =>
        ({ ok: false, status: 500, headers: new Headers(), text: async () => 'oops' }) as Response,
    ) as never;
    await expect(
      adapter.chat({ system: 's', messages: [] }, { ...baseConfig('x'), provider: 'openai' }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('Subclases OpenAI-compat', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('GroqAdapter no soporta embed', async () => {
    const a = new GroqAdapter();
    expect(a.id).toBe('groq');
    expect(a.capabilities).toEqual(['chat']);
    await expect(
      a.embed({ texts: ['x'] }, { provider: 'groq', model: '', apiKey: 'k' }),
    ).rejects.toBeInstanceOf(ProviderUnsupportedCapabilityError);
  });

  it('OpenRouterAdapter usa endpoint openrouter.ai', async () => {
    global.fetch = vi.fn(async (url) => {
      expect(String(url)).toContain('openrouter.ai/api/v1');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as Response;
    }) as never;
    await new OpenRouterAdapter().chat(
      { system: 's', messages: [{ role: 'user', content: 'h' }] },
      { provider: 'openrouter', model: '', apiKey: 'or-x' },
    );
  });

  it('MistralAdapter dim de mistral-embed = 1024', async () => {
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            data: [{ embedding: new Array(1024).fill(0), index: 0 }],
            usage: { total_tokens: 2 },
          }),
        }) as Response,
    ) as never;
    const r = await new MistralAdapter().embed(
      { texts: ['a'] },
      { provider: 'mistral', model: '', apiKey: 'm-x' },
    );
    expect(r.dimension).toBe(1024);
    expect(r.provider).toBe('mistral');
  });
});

describe('AnthropicAdapter', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat() usa /v1/messages, header x-api-key, system aparte', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/v1/messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant');
      expect(headers['anthropic-version']).toBeTruthy();
      const body = JSON.parse(String(init?.body));
      expect(body.system).toBe('S');
      expect(body.messages[0].role).toBe('user');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          content: [
            { type: 'text', text: 'hola ' },
            { type: 'text', text: 'mundo' },
          ],
          usage: { input_tokens: 4, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      } as Response;
    }) as never;

    const r = await new AnthropicAdapter().chat(
      { system: 'S', messages: [{ role: 'user', content: 'hi' }] },
      { provider: 'anthropic', model: '', apiKey: 'sk-ant' },
    );
    expect(r.content).toBe('hola mundo');
    expect(r.provider).toBe('anthropic');
    expect(r.usage.inputTokens).toBe(4);
  });

  it('embed() siempre lanza ProviderUnsupportedCapabilityError', async () => {
    await expect(new AnthropicAdapter().embed()).rejects.toBeInstanceOf(
      ProviderUnsupportedCapabilityError,
    );
  });
});

describe('GeminiAdapter', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat() mapea role assistant → model y usa systemInstruction', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('generativelanguage.googleapis.com');
      expect(String(url)).toContain(':generateContent?key=g-key');
      const body = JSON.parse(String(init?.body));
      expect(body.systemInstruction.parts[0].text).toBe('S');
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[1].role).toBe('model');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          candidates: [
            {
              content: { parts: [{ text: 'respuesta' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      } as Response;
    }) as never;

    const r = await new GeminiAdapter().chat(
      {
        system: 'S',
        messages: [
          { role: 'user', content: 'pregunta' },
          { role: 'assistant', content: 'previa' },
        ],
      },
      { provider: 'gemini', model: '', apiKey: 'g-key' },
    );
    expect(r.content).toBe('respuesta');
    expect(r.usage.inputTokens).toBe(10);
    expect(r.stopReason).toBe('STOP');
  });
});

describe('OllamaAdapter', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat() llama a /api/chat con stream=false', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/api/chat');
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          message: { content: 'on-prem ok' },
          done_reason: 'stop',
          prompt_eval_count: 7,
          eval_count: 4,
        }),
      } as Response;
    }) as never;
    const r = await new OllamaAdapter().chat(
      { system: 'S', messages: [{ role: 'user', content: 'h' }] },
      { provider: 'ollama', model: '', apiKey: '' },
    );
    expect(r.content).toBe('on-prem ok');
    expect(r.usage.inputTokens).toBe(7);
    expect(r.usage.outputTokens).toBe(4);
  });

  it('embed() llama a /api/embed con array de inputs', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/api/embed');
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual(['a', 'b']);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          embeddings: [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
        }),
      } as Response;
    }) as never;
    const r = await new OllamaAdapter().embed(
      { texts: ['a', 'b'] },
      { provider: 'ollama', model: '', apiKey: '' },
    );
    expect(r.embeddings).toHaveLength(2);
    expect(r.dimension).toBe(2);
  });
});

describe('VoyageAdapter', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat() lanza UnsupportedCapability', async () => {
    await expect(new VoyageAdapter().chat()).rejects.toBeInstanceOf(
      ProviderUnsupportedCapabilityError,
    );
  });

  it('embed() incluye input_type=document por default', async () => {
    global.fetch = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input_type).toBe('document');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: new Array(1024).fill(0.1), index: 0 }],
          usage: { total_tokens: 5 },
        }),
      } as Response;
    }) as never;
    const r = await new VoyageAdapter().embed(
      { texts: ['x'] },
      { provider: 'voyage', model: '', apiKey: 'v-x' },
    );
    expect(r.dimension).toBe(1024);
    expect(r.provider).toBe('voyage');
  });

  it('embed() respeta embedInputType=query si lo pasamos', async () => {
    global.fetch = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input_type).toBe('query');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: [{ embedding: new Array(1024).fill(0), index: 0 }],
          usage: { total_tokens: 1 },
        }),
      } as Response;
    }) as never;
    await new VoyageAdapter().embed(
      { texts: ['x'] },
      { provider: 'voyage', model: '', apiKey: 'v', embedInputType: 'query' },
    );
  });
});
