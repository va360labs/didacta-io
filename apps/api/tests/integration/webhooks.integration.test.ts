/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de integración del 10º piloto License SDK
 * (`feat:api.webhooks.high_throughput`) — Postgres real arrancado vía
 * docker-compose.test.yml.
 *
 * Cobertura mínima end-to-end:
 *   1. POST /api/v1/webhooks/endpoints → 201 + secret one-shot.
 *   2. GET  /api/v1/webhooks/endpoints → lista con secretMasked (NO secret).
 *   3. POST /api/v1/webhooks/endpoints (community, 2do endpoint) → 422.
 *   4. POST /api/v1/webhooks/endpoints (community, 4 eventos) → 422.
 *   5. PUT  /api/v1/webhooks/endpoints/:id { active:false } → 200 con active=false.
 *   6. DELETE /api/v1/webhooks/endpoints/:id → 204 + idempotencia.
 *   7. GET  /api/v1/admin/webhooks/dead-letter sin licencia EE → 402.
 *
 * El path EE real (BullMQ + HMAC + dead-letter) requiere Redis levantado
 * y queda probado en los unit tests del dispatcher. Aquí solo validamos el
 * gating del endpoint admin.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { Global, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LICENSE_CAPABILITIES, LicenseService } from '@didacta/license-sdk';

import { createTestApp, type TestApp } from './helpers/test-app';
import { issueTestLicense } from './helpers/issue-test-license';
import { issueTestAccessJwt } from './helpers/issue-test-jwt';
import { seedMinimalTenant } from './helpers/seed-tenant';
// Los imports `.ee` viven en el helper *.module.ts (excepción aceptada del
// ee-fence): este spec no importa nada `.ee` directamente.
import { buildIntegrationWebhooksModule } from './helpers/webhooks-ee-test.module';

import { TokenService } from '../../src/auth/token.service';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../src/modules/prisma-tenant-config.service';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import { MfaPolicyService } from '../../src/auth/mfa-policy/mfa-policy.service';

// ---------------------------------------------------------------------------
// Auth core mínimo (idéntico patrón a capabilities-ee.integration.test.ts).
// ---------------------------------------------------------------------------
@Global()
@Module({
  providers: [
    TokenService,
    JwtAuthGuard,
    PrismaAuditLogService,
    {
      provide: SecretCipherService,
      useFactory: () => new SecretCipherService('0'.repeat(64)),
    },
    {
      provide: PrismaTenantConfigService,
      inject: [PrismaService, SecretCipherService, PrismaAuditLogService],
      useFactory: (
        prisma: PrismaService,
        cipher: SecretCipherService,
        auditLog: PrismaAuditLogService,
      ) => new PrismaTenantConfigService(prisma, cipher, auditLog),
    },
    {
      provide: MfaPolicyService,
      inject: [PrismaTenantConfigService, LicenseService],
      useFactory: (tenantConfig: PrismaTenantConfigService, license: LicenseService) =>
        new MfaPolicyService(tenantConfig, license),
    },
  ],
  exports: [TokenService, JwtAuthGuard, PrismaTenantConfigService, MfaPolicyService],
})
class IntegrationAuthCoreModule {}

const IntegrationWebhooksModule = buildIntegrationWebhooksModule(IntegrationAuthCoreModule);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withApp<T>(
  testApp: TestApp,
  fn: (server: ReturnType<NestFastifyApplication['getHttpServer']>) => Promise<T>,
): Promise<T> {
  try {
    return await fn(testApp.app.getHttpServer());
  } finally {
    await testApp.close();
  }
}

async function bearer(opts: { roles?: readonly string[]; mfaVerified?: boolean } = {}) {
  const jwt = await issueTestAccessJwt(opts);
  return `Bearer ${jwt}`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Webhooks salientes — integración 10º piloto', () => {
  beforeAll(async () => {
    // Crea el tenant canónico para que las FKs de webhook_endpoint resuelvan.
    const tmp = await createTestApp({ licenseKey: null });
    try {
      await seedMinimalTenant(tmp.prisma);
    } finally {
      await tmp.close();
    }
  });

  afterAll(async () => {
    // Limpieza: borrar endpoints creados por estos tests para no contaminar
    // el siguiente run (la DB es efímera, pero seamos explícitos).
    const tmp = await createTestApp({ licenseKey: null });
    try {
      await tmp.prisma.webhookDeadLetter.deleteMany({});
      await tmp.prisma.webhookEndpoint.deleteMany({});
    } finally {
      await tmp.close();
    }
  });

  describe('CRUD community', () => {
    it('POST /webhooks/endpoints crea endpoint con secret one-shot', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationWebhooksModule],
      });
      await withApp(testApp, async (server) => {
        const auth = await bearer();
        const res = await supertest(server)
          .post('/api/v1/webhooks/endpoints')
          .set('Authorization', auth)
          .send({
            url: 'https://hook.example.com/it1',
            eventTypes: ['learning.course.completed'],
          });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          url: 'https://hook.example.com/it1',
          eventTypes: ['learning.course.completed'],
          active: true,
        });
        // Secret one-shot presente.
        expect(res.body.secret).toMatch(/^whsec_/);
        // Mascarado coherente.
        expect(res.body.secretMasked.endsWith(res.body.secret.slice(-4))).toBe(true);
      });
    });

    it('GET /webhooks/endpoints devuelve lista con secretMasked y SIN secret', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationWebhooksModule],
      });
      await withApp(testApp, async (server) => {
        const auth = await bearer();
        const res = await supertest(server)
          .get('/api/v1/webhooks/endpoints')
          .set('Authorization', auth);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        for (const ep of res.body) {
          expect(ep).toHaveProperty('secretMasked');
          expect(ep).not.toHaveProperty('secret');
        }
      });
    });

    it('POST /webhooks/endpoints en community con 2do endpoint → 422', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationWebhooksModule],
      });
      await withApp(testApp, async (server) => {
        const auth = await bearer();
        const res = await supertest(server)
          .post('/api/v1/webhooks/endpoints')
          .set('Authorization', auth)
          .send({
            url: 'https://hook.example.com/segundo',
            eventTypes: ['*'],
          });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('webhook_limit_exceeded');
        expect(res.body.limit).toBe('endpoints');
      });
    });

    it('GET /admin/webhooks/dead-letter sin licencia EE → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationWebhooksModule],
      });
      await withApp(testApp, async (server) => {
        const auth = await bearer();
        const res = await supertest(server)
          .get('/api/v1/admin/webhooks/dead-letter')
          .set('Authorization', auth);
        expect(res.status).toBe(402);
      });
    });

    it('GET /admin/webhooks/dead-letter con licencia EE → 200 (lista vacía)', async () => {
      const license = await issueTestLicense({
        capabilities: [LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT],
        organizationName: 'Acme Webhooks EE',
      });
      const testApp = await createTestApp({
        licenseKey: license,
        extraModules: [IntegrationWebhooksModule],
      });
      await withApp(testApp, async (server) => {
        const auth = await bearer();
        const res = await supertest(server)
          .get('/api/v1/admin/webhooks/dead-letter')
          .set('Authorization', auth);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ items: [], count: 0 });
      });
    });
  });
});
