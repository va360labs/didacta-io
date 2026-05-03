import { describe, expect, it } from 'vitest';
import { computeChecksum, computeAuditHash } from '../../src/etl/checksum.js';

describe('computeChecksum', () => {
  it('es determinista para el mismo payload', () => {
    const a = computeChecksum({ foo: 1, bar: 'x' });
    const b = computeChecksum({ bar: 'x', foo: 1 });
    expect(a).toBe(b);
  });

  it('cambia si el payload cambia', () => {
    const a = computeChecksum({ foo: 1 });
    const b = computeChecksum({ foo: 2 });
    expect(a).not.toBe(b);
  });
});

describe('computeAuditHash', () => {
  it('cadena consistente: hash[N+1] = sha256(hash[N] + body[N+1])', () => {
    const h1 = computeAuditHash(null, { action: 'job.started', actor: 'system' });
    const h2 = computeAuditHash(h1, { action: 'phase.started', actor: 'system' });
    const h3 = computeAuditHash(h2, { action: 'phase.completed', actor: 'system' });
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(h2).not.toBe(computeAuditHash(null, { action: 'phase.started', actor: 'system' }));
  });
});
