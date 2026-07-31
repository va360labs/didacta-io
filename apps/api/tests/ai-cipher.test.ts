import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyCipher } from '../src/ai/api-key-cipher';

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
}

const VALID_KEY_HEX = 'a'.repeat(64); // 64 chars hex = 32 bytes

describe('ApiKeyCipher', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.AI_CONFIG_ENCRYPTION_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    else process.env.AI_CONFIG_ENCRYPTION_KEY = original;
  });

  it('isReady() false sin clave', () => {
    delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    const c = new ApiKeyCipher(makeLogger());
    c.onModuleInit();
    expect(c.isReady()).toBe(false);
  });

  it('isReady() true con clave válida', () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = VALID_KEY_HEX;
    const c = new ApiKeyCipher(makeLogger());
    c.onModuleInit();
    expect(c.isReady()).toBe(true);
  });

  it('lanza si la clave no es 64 hex chars', () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = 'too-short';
    const c = new ApiKeyCipher(makeLogger());
    expect(() => c.onModuleInit()).toThrow(/64 chars/);
  });

  it('encrypt + decrypt roundtrip preserva la string original', () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = VALID_KEY_HEX;
    const c = new ApiKeyCipher(makeLogger());
    c.onModuleInit();

    const plaintext = 'sk-anthropic-super-secret-key-1234567890';
    const enc = c.encrypt(plaintext);
    expect(enc.cipher).toBeTruthy();
    expect(enc.iv).toHaveLength(24); // 12 bytes hex = 24 chars
    expect(enc.tag).toHaveLength(32); // 16 bytes hex = 32 chars

    const dec = c.decrypt(enc);
    expect(dec).toBe(plaintext);
  });

  it('cada encrypt produce IV distinto (no determinismo)', () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = VALID_KEY_HEX;
    const c = new ApiKeyCipher(makeLogger());
    c.onModuleInit();
    const a = c.encrypt('mismo');
    const b = c.encrypt('mismo');
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toBe(b.cipher);
    // Ambos descifran al mismo plaintext
    expect(c.decrypt(a)).toBe('mismo');
    expect(c.decrypt(b)).toBe('mismo');
  });

  it('decrypt falla si manipulan el ciphertext (auth tag GCM)', () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = VALID_KEY_HEX;
    const c = new ApiKeyCipher(makeLogger());
    c.onModuleInit();
    const enc = c.encrypt('original');
    // Cambia un byte del cipher
    const tampered = {
      ...enc,
      cipher: enc.cipher.slice(0, -2) + (enc.cipher.endsWith('00') ? '01' : '00'),
    };
    expect(() => c.decrypt(tampered)).toThrow();
  });

  it('encrypt() sin clave configurada lanza', () => {
    delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    const c = new ApiKeyCipher(makeLogger());
    c.onModuleInit();
    expect(() => c.encrypt('x')).toThrow(/AI_CONFIG_ENCRYPTION_KEY/);
  });
});
