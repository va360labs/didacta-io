import { describe, expect, it } from 'vitest';
import { extractClientContext } from '../src/auth/client-context';

const req = (headers: Record<string, string | string[] | undefined>, ip = '127.0.0.1') =>
  ({ headers, ip }) as never;

describe('extractClientContext', () => {
  it('usa req.ip cuando no hay x-forwarded-for', () => {
    expect(extractClientContext(req({}, '203.0.113.10'))).toEqual({
      ip: '203.0.113.10',
      userAgent: null,
    });
  });

  it('respeta el primer valor de x-forwarded-for por encima del socket ip', () => {
    expect(extractClientContext(req({ 'x-forwarded-for': '198.51.100.7' }, '127.0.0.1'))).toEqual({
      ip: '198.51.100.7',
      userAgent: null,
    });
  });

  it('cadena x-forwarded-for: usa el PRIMERO (la ip del cliente, no los proxies)', () => {
    const ctx = extractClientContext(
      req({ 'x-forwarded-for': '198.51.100.7, 203.0.113.5, 10.0.0.1' }),
    );
    expect(ctx.ip).toBe('198.51.100.7');
  });

  it('x-forwarded-for como array (Fastify lo entrega así si vienen varios headers)', () => {
    const ctx = extractClientContext(req({ 'x-forwarded-for': ['198.51.100.42, 10.0.0.1'] }));
    expect(ctx.ip).toBe('198.51.100.42');
  });

  it('extrae user-agent y lo pasa tal cual', () => {
    const ctx = extractClientContext(
      req({ 'user-agent': 'Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/120.0' }),
    );
    expect(ctx.userAgent).toBe('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/120.0');
  });

  it('trunca user-agent absurdamente largo (>500 chars)', () => {
    const ctx = extractClientContext(req({ 'user-agent': 'A'.repeat(2000) }));
    expect(ctx.userAgent?.length).toBe(500);
  });

  it('trunca ip si llega absurdamente larga (>64 chars)', () => {
    const ctx = extractClientContext(req({ 'x-forwarded-for': 'X'.repeat(200) }));
    expect(ctx.ip?.length).toBe(64);
  });

  it('headers ausentes y req.ip vacío → null en ambos campos', () => {
    expect(extractClientContext(req({}, ''))).toEqual({ ip: null, userAgent: null });
  });

  it('user-agent vacío string → null (no string vacío)', () => {
    const ctx = extractClientContext(req({ 'user-agent': '' }));
    expect(ctx.userAgent).toBeNull();
  });

  it('x-forwarded-for vacío → cae a req.ip', () => {
    const ctx = extractClientContext(req({ 'x-forwarded-for': '' }, '10.0.0.5'));
    expect(ctx.ip).toBe('10.0.0.5');
  });
});
