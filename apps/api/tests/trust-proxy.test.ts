/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `trustProxy` desde el entorno. Fastify >= 5.12 falla cerrado con un número
 * suelto, así que se prueba contra una instancia real: el fallo que importa es
 * que `request.ip` / `request.protocol` ignoren al proxy propio.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { hopsTrustProxy, resolveTrustProxy } from '../src/common/trust-proxy';

let app: FastifyInstance | null = null;

async function build(env: NodeJS.ProcessEnv): Promise<FastifyInstance> {
  const instance = Fastify({ trustProxy: resolveTrustProxy(env) });
  instance.get('/', async (req) => ({ ip: req.ip, protocol: req.protocol }));
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

async function get(instance: FastifyInstance, headers: Record<string, string>) {
  const res = await instance.inject({
    method: 'GET',
    url: '/',
    headers,
    remoteAddress: '10.0.0.5',
  });
  return res.json() as { ip: string; protocol: string };
}

describe('resolveTrustProxy', () => {
  it('por defecto (1 salto) usa la IP y el protocolo que pone el proxy propio', async () => {
    const instance = await build({});
    const out = await get(instance, {
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
    });
    expect(out).toEqual({ ip: '203.0.113.9', protocol: 'https' });
  });

  it('con 1 salto no se cree las entradas que el cliente añade antes del proxy', async () => {
    const instance = await build({ TRUSTED_PROXY_HOPS: '1' });
    const out = await get(instance, { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(out.ip).toBe('203.0.113.9');
  });

  it('con 2 saltos descarta una entrada más', async () => {
    const instance = await build({ TRUSTED_PROXY_HOPS: '2' });
    const out = await get(instance, { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(out.ip).toBe('1.2.3.4');
  });

  it('con 0 saltos ignora todo X-Forwarded-*', async () => {
    const instance = await build({ TRUSTED_PROXY_HOPS: '0' });
    const out = await get(instance, {
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
    });
    expect(out).toEqual({ ip: '10.0.0.5', protocol: 'http' });
  });

  it('TRUSTED_PROXY_IPS manda sobre los saltos', async () => {
    const dentro = await build({ TRUSTED_PROXY_IPS: '10.0.0.0/8', TRUSTED_PROXY_HOPS: '0' });
    expect(await get(dentro, { 'x-forwarded-proto': 'https' })).toMatchObject({
      protocol: 'https',
    });
    await dentro.close();
    app = null;

    const fuera = await build({ TRUSTED_PROXY_IPS: '192.168.0.0/16' });
    expect(await get(fuera, { 'x-forwarded-proto': 'https' })).toMatchObject({ protocol: 'http' });
  });

  it('un valor inválido vuelve al default de 1 salto', () => {
    expect(typeof resolveTrustProxy({ TRUSTED_PROXY_HOPS: 'abc' })).toBe('function');
    expect(typeof resolveTrustProxy({ TRUSTED_PROXY_HOPS: '-3' })).toBe('function');
  });

  it('hopsTrustProxy(0) es false', () => {
    expect(hopsTrustProxy(0)).toBe(false);
  });
});
