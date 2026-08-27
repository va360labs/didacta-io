/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Contrato HTTP de /scim/v2 — arranca una app Fastify REAL con la misma
 * plomería global que `main.ts` (prefijo global con la exclusión de SCIM,
 * `HttpExceptionNormalizerFilter` + `LicenseExceptionFilter`, y el
 * `RateLimitInterceptor` como APP_INTERCEPTOR).
 *
 * Por qué e2e y no unit:
 *   Los cuatro defectos que cubre este fichero NO viven en el controller: viven
 *   en la INTERACCIÓN entre el controller y la infraestructura global (filtros,
 *   interceptor, pipes). Un test unitario del controller los da todos por
 *   verdes porque nunca ve el body que sale por el socket.
 *
 * Cubre:
 *   1. El tráfico SCIM autenticado se contabiliza en el bucket del tenant que
 *      identifica su token, no en el bucket `'anonymous'` compartido.
 *   2. Todo error de /scim sale en formato RFC 7644 §3.12 puro (sin
 *      `statusCode` / `message` del normalizador) y con content-type
 *      `application/scim+json` — incluidos los que genera la infraestructura
 *      (402 del LicenseGuard, 429 del rate limiter, 400 de validación Zod).
 *   3. /scim/v2/Groups responde 501 Not Implemented, que es lo que el panel
 *      promete.
 */

import { ConflictException, Controller, Get, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LicenseExceptionFilter, LicenseService } from '@didacta/license-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpExceptionNormalizerFilter } from '../src/common/http-exception-normalizer.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { RateLimitInterceptor } from '../src/rate-limit/rate-limit.interceptor';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';
import { ScimAuthGuard, hashScimToken } from '../src/scim/scim-auth.guard';
import { ScimController } from '../src/scim/scim.controller';
import { ScimService } from '../src/scim/scim.service';
import { SCIM_CONTENT_TYPE, SCIM_SCHEMAS, makeScimError } from '../src/scim/scim.types';

const TENANT_A = 'tenant-aaaa-1111';
const TOKEN_A = 'scim_token_de_tenant_a';

// ---------------------------------------------------------------------------
// Dobles
// ---------------------------------------------------------------------------

/** Llamadas capturadas al rate limiter: (tenantId, isPublic) por request. */
const rateLimitCalls: Array<{ tenantId: string | null | undefined; isPublic: boolean }> = [];
/** Si es false, el limitador rechaza la siguiente request con 429. */
let rateLimitAllows = true;
/** Si es false, el LicenseGuard rechaza con CapabilityRequiredError → 402. */
let scimLicensed = true;
/** Escrituras de lastUsedAt capturadas (defecto 2 — se verifica en unit). */
const tenantSettingUpdates: unknown[] = [];

const fakePrisma = {
  tenantSetting: {
    findMany: async () => [
      {
        tenantId: TENANT_A,
        valueJson: {
          tokenHash: hashScimToken(TOKEN_A),
          prefix: 'scim_xxxxxxxx',
          createdAt: '2026-04-01T10:00:00.000Z',
          lastUsedAt: null,
        },
      },
    ],
    update: async (args: unknown) => {
      tenantSettingUpdates.push(args);
      return {};
    },
  },
};

const fakeRateLimit = {
  async recordRequest(tenantId: string | null | undefined, isPublic: boolean) {
    rateLimitCalls.push({ tenantId, isPublic });
    const resetAt = new Date(Date.now() + 30_000);
    return rateLimitAllows
      ? {
          allowed: true,
          limit: 100,
          remaining: 99,
          resetAt,
          tier: 'community',
          bucket: 'authenticated',
        }
      : {
          allowed: false,
          limit: 100,
          remaining: 0,
          resetAt,
          retryAfterSeconds: 30,
          tier: 'community',
          bucket: 'authenticated',
        };
  },
};

const fakeLicense = {
  isCapabilityEnabled: () => scimLicensed,
};

/** Si está seteado, `createUser` lo lanza en vez de crear. */
let createUserThrows: unknown = null;

const fakeScim = {
  async listUsers(_tenantId: string, query: { startIndex: number; count: number }) {
    return { totalResults: 0, startIndex: query.startIndex, itemsPerPage: 0, resources: [] };
  },
  async createUser() {
    if (createUserThrows) throw createUserThrows;
    return {};
  },
  async deleteUser() {
    return undefined;
  },
};

/**
 * Ruta de control: un endpoint normal del API, sin guard, para comprobar que el
 * arreglo del bucket NO cambia el tráfico realmente anónimo.
 */
@Controller('sonda')
class ProbeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({
  controllers: [ScimController, ProbeController],
  providers: [
    ScimAuthGuard,
    { provide: PrismaService, useValue: fakePrisma },
    { provide: ScimService, useValue: fakeScim },
    { provide: LicenseService, useValue: fakeLicense },
    { provide: RateLimitService, useValue: fakeRateLimit },
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
})
class ScimTestAppModule {}

// ---------------------------------------------------------------------------

describe('Contrato HTTP de /scim/v2', () => {
  let app: NestFastifyApplication;

  const authed = { authorization: `Bearer ${TOKEN_A}` };

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ScimTestAppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    // Mismo prefijo y exclusión que main.ts.
    app.setGlobalPrefix('api/v1', { exclude: ['scim/v2/{*path}'] });
    // Mismos filtros globales que main.ts, en el mismo orden.
    app.useGlobalFilters(new HttpExceptionNormalizerFilter(), new LicenseExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rateLimitCalls.length = 0;
    tenantSettingUpdates.length = 0;
    rateLimitAllows = true;
    scimLicensed = true;
    createUserThrows = null;
  });

  // -------------------------------------------------------------------------
  // Defecto 1 — bucket del rate limiter
  // -------------------------------------------------------------------------

  describe('rate limit', () => {
    it('el tráfico SCIM autenticado se cuenta contra el tenant de su token, no contra "anonymous"', async () => {
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: authed });

      expect(res.statusCode).toBe(200);
      expect(rateLimitCalls).toEqual([{ tenantId: TENANT_A, isPublic: false }]);
    });

    it('el tráfico realmente anónimo sigue cayendo en el bucket público', async () => {
      // Endpoint normal del API, sin JWT ni Bearer SCIM → no hay identidad.
      const res = await app.inject({ method: 'GET', url: '/api/v1/sonda' });

      expect(res.statusCode).toBe(200);
      expect(rateLimitCalls).toHaveLength(1);
      expect(rateLimitCalls[0]?.isPublic).toBe(true);
      // El identificador del cubo público se deriva de la IP del cliente
      // (`anon:<hash>`). Antes era el literal `'anonymous'` para TODO el
      // tráfico público de la instancia, que es el defecto que se corrigió.
      expect(rateLimitCalls[0]?.tenantId).toMatch(/^anon:[0-9a-f]{16}$/);
    });

    it('el bucket del IdP es el del tenant que emitió su token, no uno compartido', async () => {
      // Dos requests del mismo IdP + una anónima: las del IdP van al mismo
      // bucket entre ellas y a uno distinto del anónimo.
      await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: authed });
      await app.inject({ method: 'GET', url: '/scim/v2/ServiceProviderConfig', headers: authed });
      await app.inject({ method: 'GET', url: '/api/v1/sonda' });

      const buckets = rateLimitCalls.map((c) => c.tenantId);
      expect(buckets.slice(0, 2)).toEqual([TENANT_A, TENANT_A]);
      expect(buckets[2]).not.toBe(TENANT_A);
      expect(buckets[2]).toMatch(/^anon:[0-9a-f]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Defectos 3 y 5 — formato de error
  // -------------------------------------------------------------------------

  describe('formato de error RFC 7644 §3.12', () => {
    /** Un error SCIM puro tiene EXACTAMENTE estas claves (scimType opcional). */
    function expectPureScimError(
      res: { statusCode: number; headers: Record<string, unknown>; body: string },
      status: number,
    ) {
      expect(res.statusCode).toBe(status);
      expect(String(res.headers['content-type'])).toContain(SCIM_CONTENT_TYPE);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body['schemas']).toEqual([SCIM_SCHEMAS.ERROR]);
      expect(body['status']).toBe(String(status));
      expect(typeof body['detail']).toBe('string');
      // Lo que NO puede llevar: los campos que mete el normalizador global y
      // los del filtro de licencia / del rate limiter.
      expect(Object.keys(body).sort()).toEqual(
        ['schemas', 'status', 'detail', ...(body['scimType'] ? ['scimType'] : [])].sort(),
      );
      return body;
    }

    it('401 del guard sale como error SCIM puro', async () => {
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
      expectPureScimError(res, 401);
    });

    it('401 con Bearer no reconocido sale como error SCIM puro', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/scim/v2/Users',
        headers: { authorization: 'Bearer no-existe' },
      });
      expectPureScimError(res, 401);
    });

    it('402 del LicenseGuard (capability feat:scim) sale como error SCIM', async () => {
      scimLicensed = false;
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: authed });
      const body = expectPureScimError(res, 402);
      // El detail tiene que nombrar la capability para que el admin sepa qué comprar.
      expect(String(body['detail'])).toContain('feat:scim');
    });

    it('429 del rate limiter sale como error SCIM y conserva Retry-After', async () => {
      rateLimitAllows = false;
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: authed });
      expectPureScimError(res, 429);
      expect(res.headers['retry-after']).toBe('30');
    });

    it('400 de validación Zod sale como error SCIM con scimType', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/scim/v2/Users?count=999',
        headers: authed,
      });
      const body = expectPureScimError(res, 400);
      expect(body['scimType']).toBe('invalidSyntax');
    });

    it('el scimType que calcula el dominio sobrevive al filtro (409 uniqueness)', async () => {
      // El service lanza su propio error SCIM con `scimType`. El filtro NO
      // puede aplanarlo: `uniqueness` es lo que le dice al IdP "ese usuario ya
      // existe, deja de reintentar el POST".
      createUserThrows = new ConflictException(
        makeScimError(409, 'User with userName "ana@x.com" already exists.', 'uniqueness'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/scim/v2/Users',
        headers: authed,
        payload: { userName: 'ana@x.com' },
      });

      const body = expectPureScimError(res, 409);
      expect(body['scimType']).toBe('uniqueness');
      expect(body['detail']).toContain('already exists');
    });

    it('404 de ruta desconocida bajo /scim también sale como error SCIM', async () => {
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Users/x/y/z', headers: authed });
      expect(res.statusCode).toBe(404);
      expect(String(res.headers['content-type'])).toContain(SCIM_CONTENT_TYPE);
    });
  });

  // -------------------------------------------------------------------------
  // Defecto 4 — Groups
  // -------------------------------------------------------------------------

  describe('/scim/v2/Groups', () => {
    it('GET responde 501 Not Implemented con error SCIM', async () => {
      const res = await app.inject({ method: 'GET', url: '/scim/v2/Groups', headers: authed });
      expect(res.statusCode).toBe(501);
      expect(String(res.headers['content-type'])).toContain(SCIM_CONTENT_TYPE);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body['schemas']).toEqual([SCIM_SCHEMAS.ERROR]);
      expect(body['status']).toBe('501');
    });

    it('POST y las subrutas también responden 501', async () => {
      const post = await app.inject({
        method: 'POST',
        url: '/scim/v2/Groups',
        headers: authed,
        payload: { displayName: 'Ventas' },
      });
      expect(post.statusCode).toBe(501);

      const sub = await app.inject({
        method: 'PATCH',
        url: '/scim/v2/Groups/abc-123',
        headers: authed,
        payload: {},
      });
      expect(sub.statusCode).toBe(501);
    });
  });

  // -------------------------------------------------------------------------
  // Content-type de las respuestas correctas
  // -------------------------------------------------------------------------

  it('las respuestas 200 de /scim también van como application/scim+json', async () => {
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain(SCIM_CONTENT_TYPE);
  });

  it('el 204 del DELETE sigue sin cuerpo ni content-type', async () => {
    // Anunciar un tipo de medio para un cuerpo vacío rompe a los clientes que
    // intentan parsearlo.
    const res = await app.inject({
      method: 'DELETE',
      url: '/scim/v2/Users/abc-123',
      headers: authed,
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBeUndefined();
  });

  it('el ServiceProviderConfig apunta a la página de documentación que existe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/ServiceProviderConfig',
      headers: authed,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentationUri).toBe('https://docs.didacta.io/enterprise/scim/');
  });
});
