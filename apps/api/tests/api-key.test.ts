import { describe, expect, it } from 'vitest';
import { ApiKeyService } from '../src/auth/api-key.service';

describe('ApiKeyService.generateToken', () => {
  it('genera un token con prefijo lmsk_ y hash SHA-256', () => {
    const service = new ApiKeyService(null as never);
    const result = service.generateToken();
    expect(result.plain).toMatch(/^lmsk_[A-Za-z0-9_-]+$/);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview).toContain('…');
    expect(result.preview).toContain(result.plain.slice(-4));
  });

  it('hashToken es determinístico', () => {
    const service = new ApiKeyService(null as never);
    const t1 = service.hashToken('lmsk_abc');
    const t2 = service.hashToken('lmsk_abc');
    expect(t1).toBe(t2);
    expect(t1).not.toBe(service.hashToken('lmsk_xyz'));
  });

  it('tokens diferentes generan hashes diferentes', () => {
    const service = new ApiKeyService(null as never);
    const a = service.generateToken();
    const b = service.generateToken();
    expect(a.plain).not.toBe(b.plain);
    expect(a.hash).not.toBe(b.hash);
  });
});
