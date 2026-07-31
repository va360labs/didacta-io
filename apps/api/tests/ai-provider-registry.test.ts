import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/ai/provider-registry';

describe('ProviderRegistry', () => {
  it('registra todos los built-in providers al instanciar', () => {
    const r = new ProviderRegistry();
    const list = r.list();
    const ids = list.map((p) => p.id).sort();
    expect(ids).toEqual([
      'anthropic',
      'gemini',
      'groq',
      'mistral',
      'ollama',
      'openai',
      'openrouter',
      'voyage',
    ]);
  });

  it('get(id) devuelve adapter o null', () => {
    const r = new ProviderRegistry();
    expect(r.get('openai')).not.toBeNull();
    expect(r.get('anthropic')).not.toBeNull();
    // Cast ya que TS solo acepta union, pero el método debe ser tolerante
    expect(r.get('inexistente' as never)).toBeNull();
  });

  it('withCapability("chat") incluye providers de chat y excluye Voyage', () => {
    const r = new ProviderRegistry();
    const chatProviders = r.withCapability('chat').map((a) => a.id);
    expect(chatProviders).toContain('openai');
    expect(chatProviders).toContain('anthropic');
    expect(chatProviders).toContain('gemini');
    expect(chatProviders).toContain('groq');
    expect(chatProviders).toContain('openrouter');
    expect(chatProviders).toContain('mistral');
    expect(chatProviders).toContain('ollama');
    expect(chatProviders).not.toContain('voyage');
  });

  it('withCapability("embed") incluye los que soportan embed y excluye chat-only', () => {
    const r = new ProviderRegistry();
    const embedProviders = r.withCapability('embed').map((a) => a.id);
    expect(embedProviders).toContain('openai');
    expect(embedProviders).toContain('voyage');
    expect(embedProviders).toContain('mistral');
    expect(embedProviders).toContain('gemini');
    expect(embedProviders).toContain('ollama');
    expect(embedProviders).not.toContain('anthropic');
    expect(embedProviders).not.toContain('groq');
    expect(embedProviders).not.toContain('openrouter');
  });

  it('cada adapter declara capabilities consistentes', () => {
    const r = new ProviderRegistry();
    for (const adapter of r.list()) {
      expect(adapter.capabilities.length).toBeGreaterThan(0);
      for (const c of adapter.capabilities) {
        expect(['chat', 'embed']).toContain(c);
      }
    }
  });
});
