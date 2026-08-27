/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Cabeceras de seguridad de la API. Hallazgo 2b del reporte de Bruno
 * (ingenierosindustriales.com): la aplicación no fijaba CSP, HSTS,
 * X-Frame-Options ni X-Content-Type-Options globalmente, y se daban por
 * delegadas al reverse proxy. Ver SECURITY-CREDITS.md.
 *
 * Se prueba contra una instancia real de Fastify —no comprobando que la
 * constante existe— porque el fallo que importa es "la cabecera está
 * configurada pero no llega a la respuesta".
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSecurityHeaders } from '../src/common/security-headers';

let app: FastifyInstance | null = null;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ trustProxy: 1 });
  registerSecurityHeaders(instance);
  instance.get('/api/v1/cursos', async () => ({ ok: true }));
  instance.get('/api/docs', async (_req, reply) => reply.type('text/html').send('<html></html>'));
  instance.get('/api/v1/storage/file/x', async (_req, reply) => {
    // Simula lo que hace `storage-file.controller.ts`: su propia CSP, más
    // restrictiva que la global.
    reply.header('Content-Security-Policy', 'sandbox');
    return reply.send('contenido');
  });
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('registerSecurityHeaders', () => {
  it('una respuesta JSON normal sale con CSP, nosniff y X-Frame-Options', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ method: 'GET', url: '/api/v1/cursos' });

    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('las respuestas que Fastify genera sin llegar al handler también las llevan', async () => {
    // Este es el motivo de usar un hook `onSend` y no un interceptor de Nest:
    // un 404 del router nunca pasa por el pipeline de Nest.
    const instance = await buildApp();
    const res = await instance.inject({ method: 'GET', url: '/no-existe' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('no le pisa la CSP al Swagger UI, que sí necesita cargar scripts', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ method: 'GET', url: '/api/docs' });

    expect(res.headers['content-security-policy']).toBeUndefined();
    // El nosniff sí se aplica en todas partes: no estorba y evita que el
    // navegador adivine el tipo.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('respeta la CSP más restrictiva que fija el controller de ficheros', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ method: 'GET', url: '/api/v1/storage/file/x' });

    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('HSTS sólo se emite si la petición llegó por HTTPS', async () => {
    const instance = await buildApp();

    const plano = await instance.inject({ method: 'GET', url: '/api/v1/cursos' });
    expect(plano.headers['strict-transport-security']).toBeUndefined();

    // Con `trustProxy` activo, Fastify resuelve el protocolo del
    // `X-Forwarded-Proto` que pone nuestro propio proxy de terminación TLS.
    const cifrado = await instance.inject({
      method: 'GET',
      url: '/api/v1/cursos',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(cifrado.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});
