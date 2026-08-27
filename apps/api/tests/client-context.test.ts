import { describe, expect, it } from 'vitest';
import { extractClientContext } from '../src/auth/client-context';

/**
 * La IP que acaba en el registro de auditoría.
 *
 * Estos tests cambiaron de sentido a propósito. Tres de ellos afirmaban que
 * `x-forwarded-for` gana sobre `req.ip` — que era justo el defecto: la IP del
 * rastro la elegía quien hacía la petición, mandando el header que quisiera. Un
 * log de auditoría cuyo contenido escribe el auditado no es un log de auditoría.
 *
 * Ahora la única fuente es `req.ip`, que Fastify deriva del XFF solo hasta donde
 * `trustProxy` le autoriza (`TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_IPS`).
 */

const req = (headers: Record<string, string | string[] | undefined>, ip = '127.0.0.1') =>
  ({ headers, ip }) as never;

describe('extractClientContext', () => {
  it('usa req.ip', () => {
    expect(extractClientContext(req({}, '203.0.113.10'))).toEqual({
      ip: '203.0.113.10',
      userAgent: null,
    });
  });

  it('un x-forwarded-for inventado NO pisa la ip resuelta', () => {
    // El caso del defecto: antes esto devolvía 198.51.100.7 y el rastro quedaba
    // firmado con la dirección que el cliente había elegido.
    const ctx = extractClientContext(req({ 'x-forwarded-for': '198.51.100.7' }, '203.0.113.10'));
    expect(ctx.ip).toBe('203.0.113.10');
  });

  it('una CADENA de x-forwarded-for tampoco: el primero es el mas facil de falsear', () => {
    const ctx = extractClientContext(
      req({ 'x-forwarded-for': '198.51.100.7, 203.0.113.5, 10.0.0.1' }, '203.0.113.10'),
    );
    expect(ctx.ip).toBe('203.0.113.10');
  });

  it('x-forwarded-for como array (varios headers) tampoco cuela', () => {
    const ctx = extractClientContext(
      req({ 'x-forwarded-for': ['198.51.100.42, 10.0.0.1'] }, '203.0.113.10'),
    );
    expect(ctx.ip).toBe('203.0.113.10');
  });

  it('sin req.ip no se inventa una desde el header: null', () => {
    // Preferimos NO saber la IP a registrar una que dijo el propio auditado.
    const ctx = extractClientContext(req({ 'x-forwarded-for': '198.51.100.7' }, ''));
    expect(ctx.ip).toBeNull();
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
    // IPv6 con zona, o un proxy mal configurado. El campo en DB es acotado.
    const ctx = extractClientContext(req({}, 'X'.repeat(200)));
    expect(ctx.ip?.length).toBe(64);
  });

  it('headers ausentes y req.ip vacío → null en ambos campos', () => {
    expect(extractClientContext(req({}, ''))).toEqual({ ip: null, userAgent: null });
  });

  it('user-agent vacío string → null (no string vacío)', () => {
    const ctx = extractClientContext(req({ 'user-agent': '' }));
    expect(ctx.userAgent).toBeNull();
  });
});
