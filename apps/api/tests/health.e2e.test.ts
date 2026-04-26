import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { OutboxQueueService } from '../src/modules/outbox-queue.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Test e2e del HealthController con mocks de los providers que inyecta.
 * Evita bootstrapear el AppModule completo (que necesitaría DB + Redis reales).
 */

const fakePrisma = {
  async $queryRaw() {
    return [{ '?column?': 1 }];
  },
};

const fakeOutboxQueue = {
  isEnabled() {
    return false;
  },
  async ping() {
    return false;
  },
};

@Module({
  controllers: [HealthController],
  providers: [
    { provide: PrismaService, useValue: fakePrisma },
    { provide: OutboxQueueService, useValue: fakeOutboxQueue },
  ],
})
class HealthAppModule {}

describe('Health endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(HealthAppModule, new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'livez'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz responde 200 con payload válido', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api');
    expect(typeof body.uptime).toBe('number');
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('GET /readyz responde 200 con checks por dependencia', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ db: 'ok', redis: 'disabled' });
  });

  it('/readyz devuelve 503 cuando la DB falla', async () => {
    const failingPrisma = {
      async $queryRaw() {
        throw new Error('connection refused');
      },
    };

    @Module({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: failingPrisma },
        { provide: OutboxQueueService, useValue: fakeOutboxQueue },
      ],
    })
    class FailingAppModule {}

    const failingApp = await NestFactory.create<NestFastifyApplication>(
      FailingAppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    failingApp.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'livez'] });
    await failingApp.init();
    await failingApp.getHttpAdapter().getInstance().ready();

    try {
      const response = await failingApp.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.checks.db).toBe('error');
    } finally {
      await failingApp.close();
    }
  });

  it('/readyz devuelve 503 cuando Redis está habilitado pero falla el ping', async () => {
    const brokenRedis = {
      isEnabled() {
        return true;
      },
      async ping() {
        return false;
      },
    };

    @Module({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: fakePrisma },
        { provide: OutboxQueueService, useValue: brokenRedis },
      ],
    })
    class BrokenRedisAppModule {}

    const brokenApp = await NestFactory.create<NestFastifyApplication>(
      BrokenRedisAppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    brokenApp.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'livez'] });
    await brokenApp.init();
    await brokenApp.getHttpAdapter().getInstance().ready();

    try {
      const response = await brokenApp.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.checks.redis).toBe('error');
    } finally {
      await brokenApp.close();
    }
  });

  it('/healthz está fuera del prefijo /api/v1', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(response.statusCode).toBe(404);
  });
});
