/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de integración del LicenseGuard end-to-end para las 7 capabilities
 * EE del Sprint 2 (ART-025). Cada capability se valida con Postgres real
 * arrancado vía docker-compose.test.yml.
 *
 * Por qué un único archivo monolítico:
 *   - Compartimos `beforeAll`/`afterAll` para issue de licencias canónicas y
 *     restauración de NODE_ENV (mismo patrón que `license-guard.integration.
 *     test.ts`).
 *   - Reduce el coste de bootstrap: cada test crea una `NestFastifyApplication`
 *     limpia (Postgres + Prisma init), con 24 tests el coste agregado ya es
 *     significativo. Un solo archivo permite a vitest reusar el `globalSetup`.
 *   - Mantiene el "smoke pattern" visible: ver de un vistazo la cobertura
 *     completa de gating EE en un único lugar.
 *
 * Por qué smoke (4 escenarios por controller) en lugar de tests profundos:
 *   - El deep behavior por capability ya tiene tests unit (e.g.
 *     `audit-export.controller.test.ts`, `oidc-admin.controller.test.ts`,
 *     etc.) — esto cubre business logic con fakes.
 *   - Lo que aporta la integración aquí es CONFIRMAR que el guard runtime
 *     opera dentro de un Nest real con DI completo y conexión Postgres real.
 *     Los 4 estados (sin auth / sin licencia / con licencia + cap / con
 *     licencia sin cap) son la matriz mínima para considerar "gated".
 *
 * Convenciones:
 *   - Cada describe corresponde a 1 capability + 1 controller "smoke target".
 *   - Helpers privados al archivo: `withApp`, `bearer`.
 *   - No mockeamos ningún servicio: licensia firmada real, JWT firmado real,
 *     PrismaService conectado al Postgres efímero (esquema aplicado por
 *     globalSetup).
 *
 * Capabilities cubiertas (7/7):
 *   1. feat:scim                       → ScimAdminTokenController
 *   2. feat:sso.oidc                   → OidcAdminController
 *   3. feat:custom_domains             → CustomDomainsController
 *   4. feat:reports.advanced_signed    → AuditExportController
 *   5. feat:mfa.enforcement            → MfaPolicyController
 *   6. feat:audit.long_retention       → AuditController (gating semántico)
 *   7. feat:api.rate_limit.elevated    → RateLimitInfoController (gating semántico)
 *
 * Total: 24 nuevos tests. Sumados a los 12 de `license-guard.integration.
 * test.ts` → 36 tests de integración del LicenseGuard end-to-end.
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

// Imports del core de auth/tenant — minimal para arrancar JwtAuthGuard.
import { TokenService } from '../../src/auth/token.service';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../src/modules/prisma-tenant-config.service';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import { MfaPolicyService } from '../../src/auth/mfa-policy/mfa-policy.service';

// Imports de los controllers EE bajo test + sus deps mínimas.
import { CustomDomainsController } from '../../src/admin/custom-domains/custom-domains.controller';
import { CustomDomainsService } from '../../src/admin/custom-domains/custom-domains.service';
import { ScimAdminTokenController } from '../../src/admin/scim/scim-admin.controller';
import { OidcAdminController } from '../../src/admin/sso/oidc-admin.controller';
import { OidcService } from '../../src/sso/oidc/oidc.service';
import { AuditExportController } from '../../src/modules/audit-export/audit-export.controller';
import { AuditExportService } from '../../src/modules/audit-export/audit-export.service';
import { AuditController } from '../../src/modules/audit.controller';
import { MfaPolicyController } from '../../src/auth/mfa-policy/mfa-policy.controller';
import { RateLimitInfoController } from '../../src/rate-limit/rate-limit-info.controller';
import { RATE_LIMIT_REDIS_TOKEN, RateLimitService } from '../../src/rate-limit/rate-limit.service';

// ---------------------------------------------------------------------------
// IntegrationAuthCoreModule — núcleo mínimo de auth para los tests de
// integración del LicenseGuard. Reproduce los providers de `AuthModule` que
// los controllers EE realmente usan, SIN arrastrar:
//   - AuthController / MfaController / MeController / ApiKeyController
//     (necesitan TenantResolverService, AuthService, MfaService, etc. → mucha
//     superficie irrelevante para los smoke tests del guard).
//   - PasswordResetService / SmtpAdapterService (mailer), AuthService.
//
// Lo declaramos `@Global` para que cualquier feature module pueda inyectar
// sus exports sin re-importarlo. Esto evita la coreografía de imports cruzados
// y mantiene el wiring de los feature modules legible.
// ---------------------------------------------------------------------------

@Global()
@Module({
  providers: [
    TokenService,
    JwtAuthGuard,
    PrismaAuditLogService,
    {
      provide: SecretCipherService,
      // Misma key determinista que `setup-db.ts` setea en TENANT_SETTINGS_ENC_KEY.
      // Suficiente para tests — no debe coincidir con prod.
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
  exports: [
    TokenService,
    JwtAuthGuard,
    PrismaAuditLogService,
    PrismaTenantConfigService,
    MfaPolicyService,
  ],
})
class IntegrationAuthCoreModule {}

// ---------------------------------------------------------------------------
// Módulos de feature por capability — el mínimo viable para arrancar el
// controller con sus deps reales sin arrastrar BullMQ/Redis/SMTP/S3.
//
// Patrón:
//   - Importan IntegrationAuthCoreModule (que es @Global, así que basta con
//     que esté presente una vez en el grafo).
//   - Registran solo el controller + service específico de esa capability.
//   - LicenseModule lo aporta `createTestApp` (también @Global).
// ---------------------------------------------------------------------------

@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [ScimAdminTokenController],
})
class IntegrationScimAdminModule {}

@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [OidcAdminController],
  providers: [OidcService],
})
class IntegrationOidcAdminModule {}

@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [CustomDomainsController],
  providers: [CustomDomainsService],
})
class IntegrationCustomDomainsModule {}

@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [AuditExportController],
  providers: [AuditExportService],
})
class IntegrationAuditExportModule {}

@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [MfaPolicyController],
})
class IntegrationMfaPolicyModule {}

// AuditController — gating semántico (NO 402); necesita LicenseService (global)
// + PrismaAuditLogService (vía IntegrationAuthCoreModule).
@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [AuditController],
})
class IntegrationAuditLongRetentionModule {}

// RateLimitInfoController — gating semántico. RateLimitService necesita un
// cliente Redis (puede ser null → failsafe open). Inyectamos null.
@Module({
  imports: [IntegrationAuthCoreModule],
  controllers: [RateLimitInfoController],
  providers: [RateLimitService, { provide: RATE_LIMIT_REDIS_TOKEN, useValue: null }],
})
class IntegrationRateLimitModule {}

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

describe('LicenseGuard — integración 7 capabilities EE (ART-025, Sprint 2)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  // Licencias canónicas reusadas entre tests (evita re-firmar JWTs ES256
  // en cada `it`, cada uno cuesta ~5ms de CPU).
  let licenseWithScim: string;
  let licenseWithOidc: string;
  let licenseWithCustomDomains: string;
  let licenseWithReports: string;
  let licenseWithMfaEnforcement: string;
  let licenseWithAuditLongRetention: string;
  let licenseWithRateLimitElevated: string;
  let licenseEnterpriseNoCaps: string;

  beforeAll(async () => {
    licenseWithScim = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.SCIM],
      organizationName: 'Acme SCIM',
    });
    licenseWithOidc = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.SSO_OIDC],
      organizationName: 'Acme OIDC',
    });
    licenseWithCustomDomains = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.CUSTOM_DOMAINS],
      organizationName: 'Acme Domains',
    });
    licenseWithReports = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED],
      organizationName: 'Acme Reports',
    });
    licenseWithMfaEnforcement = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.MFA_ENFORCEMENT],
      organizationName: 'Acme MFA',
    });
    licenseWithAuditLongRetention = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.AUDIT_LONG_RETENTION],
      organizationName: 'Acme Audit Long',
    });
    licenseWithRateLimitElevated = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.API_RATE_LIMIT_ELEVATED],
      organizationName: 'Acme RateLimit',
    });
    // Licencia "enterprise" pero SIN capabilities — usado para validar que
    // tener licencia EE NO implica todas las features (cada cap requiere su
    // entry explícita). Reusamos `WHITE_LABEL` (capability ortogonal a las
    // 7 que probamos) para representar una EE con scope distinto.
    licenseEnterpriseNoCaps = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.WHITE_LABEL],
      organizationName: 'Acme Otro Scope',
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ===========================================================================
  // 1. feat:scim — ScimAdminTokenController (GET /admin/scim/token)
  // ===========================================================================
  describe('feat:scim — ScimAdminTokenController', () => {
    const PATH = '/api/v1/admin/scim/token';

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationScimAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).get(PATH);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 402 capability requerida', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationScimAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body).toMatchObject({
          statusCode: 402,
          error: 'CapabilityRequiredError',
          capability: LICENSE_CAPABILITIES.SCIM,
        });
      });
    });

    it('con auth admin + licencia con feat:scim → 200', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithScim,
        extraModules: [IntegrationScimAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        // Sin token previo configurado → { active: false }.
        expect(res.body).toMatchObject({ active: false });
      });
    });

    it('con auth admin + licencia EE distinta scope → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseEnterpriseNoCaps,
        extraModules: [IntegrationScimAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.SCIM);
      });
    });
  });

  // ===========================================================================
  // 2. feat:sso.oidc — OidcAdminController (GET /admin/sso/oidc/config)
  // ===========================================================================
  describe('feat:sso.oidc — OidcAdminController', () => {
    const PATH = '/api/v1/admin/sso/oidc/config';

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationOidcAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).get(PATH);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationOidcAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.SSO_OIDC);
      });
    });

    it('con auth admin + licencia con feat:sso.oidc → 200', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithOidc,
        extraModules: [IntegrationOidcAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        // Tenant nuevo sin config previa → exists:false con redirectUri presente.
        expect(res.body).toMatchObject({
          exists: false,
          capability: LICENSE_CAPABILITIES.SSO_OIDC,
        });
        expect(typeof res.body.redirectUri).toBe('string');
      });
    });

    it('con auth admin + licencia EE distinta scope → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseEnterpriseNoCaps,
        extraModules: [IntegrationOidcAdminModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.SSO_OIDC);
      });
    });
  });

  // ===========================================================================
  // 3. feat:custom_domains — CustomDomainsController (GET /admin/custom-domains)
  // ===========================================================================
  describe('feat:custom_domains — CustomDomainsController', () => {
    const PATH = '/api/v1/admin/custom-domains';

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationCustomDomainsModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).get(PATH);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationCustomDomainsModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.CUSTOM_DOMAINS);
      });
    });

    it('con auth admin + licencia con feat:custom_domains → 200', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithCustomDomains,
        extraModules: [IntegrationCustomDomainsModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          domains: [],
          capability: LICENSE_CAPABILITIES.CUSTOM_DOMAINS,
        });
      });
    });

    it('con auth admin + licencia EE distinta scope → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseEnterpriseNoCaps,
        extraModules: [IntegrationCustomDomainsModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.CUSTOM_DOMAINS);
      });
    });
  });

  // ===========================================================================
  // 4. feat:reports.advanced_signed — AuditExportController (GET /audit/entries.zip)
  // ===========================================================================
  describe('feat:reports.advanced_signed — AuditExportController', () => {
    const PATH = '/api/v1/audit/entries.zip';

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationAuditExportModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).get(PATH);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationAuditExportModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED);
      });
    });

    it('con auth admin + licencia con feat:reports.advanced_signed → 200 + ZIP', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithReports,
        extraModules: [IntegrationAuditExportModule],
      });
      // El controller registra un entry `audit.report.exported` en la
      // descarga; el insert tiene FK al tenant → seedeamos.
      await seedMinimalTenant(testApp.prisma);
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/zip/);
        expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-/);
        // El audit log del tenant está vacío → entry count == 0 (header informativo).
        expect(res.headers['x-audit-entry-count']).toBe('0');
      });
    });

    it('con auth admin + licencia EE distinta scope → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseEnterpriseNoCaps,
        extraModules: [IntegrationAuditExportModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED);
      });
    });
  });

  // ===========================================================================
  // 5. feat:mfa.enforcement — MfaPolicyController (PUT /admin/mfa-policy)
  // ===========================================================================
  describe('feat:mfa.enforcement — MfaPolicyController', () => {
    const PATH = '/api/v1/admin/mfa-policy';
    const VALID_BODY = { requiredForAll: true, gracePeriodDays: 7 };

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationMfaPolicyModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).put(PATH).send(VALID_BODY);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationMfaPolicyModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .put(PATH)
          .set('Authorization', await bearer())
          .send(VALID_BODY);
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.MFA_ENFORCEMENT);
      });
    });

    it('con auth admin + licencia con feat:mfa.enforcement → 200', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithMfaEnforcement,
        extraModules: [IntegrationMfaPolicyModule],
      });
      // PUT escribe en tenant_setting (vía PrismaTenantConfigService) — FK
      // requiere que el tenant exista en DB.
      await seedMinimalTenant(testApp.prisma);
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .put(PATH)
          .set('Authorization', await bearer())
          .send(VALID_BODY);
        expect(res.status).toBe(200);
        // El service devuelve `{ policy, enforcementActive, capability, licensed }`.
        expect(res.body).toMatchObject({
          capability: LICENSE_CAPABILITIES.MFA_ENFORCEMENT,
          licensed: true,
          policy: expect.objectContaining({
            requiredForAll: true,
            gracePeriodDays: 7,
          }),
        });
      });
    });

    it('con auth admin + licencia EE distinta scope → 402', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseEnterpriseNoCaps,
        extraModules: [IntegrationMfaPolicyModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .put(PATH)
          .set('Authorization', await bearer())
          .send(VALID_BODY);
        expect(res.status).toBe(402);
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.MFA_ENFORCEMENT);
      });
    });
  });

  // ===========================================================================
  // 6. feat:audit.long_retention — AuditController (GET /audit/retention-info)
  // GATING SEMÁNTICO: NO devuelve 402; cambia el JSON de la response (plan +
  // maxDays) según haya o no capability. El frontend usa el shape para mostrar
  // el aviso "Plan Community: 90 días" o "Plan Enterprise: ilimitado".
  // ===========================================================================
  describe('feat:audit.long_retention — AuditController retention-info (gating semántico)', () => {
    const PATH = '/api/v1/audit/retention-info';

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationAuditLongRetentionModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).get(PATH);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 200 con plan=community + maxDays=90', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationAuditLongRetentionModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          plan: 'community',
          maxDays: 90,
          capability: LICENSE_CAPABILITIES.AUDIT_LONG_RETENTION,
        });
      });
    });

    it('con auth admin + licencia con feat:audit.long_retention → 200 con plan=enterprise + maxDays=null', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithAuditLongRetention,
        extraModules: [IntegrationAuditLongRetentionModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          plan: 'enterprise',
          maxDays: null,
          capability: LICENSE_CAPABILITIES.AUDIT_LONG_RETENTION,
        });
      });
    });
  });

  // ===========================================================================
  // 7. feat:api.rate_limit.elevated — RateLimitInfoController (GET /admin/rate-limit/info)
  // GATING SEMÁNTICO: el endpoint NO va gateado (sirve también para el upsell
  // desde plan community). Cambia el `tier` del response según licencia.
  // ===========================================================================
  describe('feat:api.rate_limit.elevated — RateLimitInfoController (gating semántico)', () => {
    const PATH = '/api/v1/admin/rate-limit/info';

    it('sin auth → 401', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationRateLimitModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server).get(PATH);
        expect(res.status).toBe(401);
      });
    });

    it('con auth admin, sin licencia → 200 con tier=community', async () => {
      const testApp = await createTestApp({
        licenseKey: null,
        extraModules: [IntegrationRateLimitModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        expect(res.body.tier).toBe('community');
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.API_RATE_LIMIT_ELEVATED);
        // Los límites efectivos deben ser los del tier comunidad.
        expect(res.body.authenticated.limit).toBe(res.body.community.authenticated);
        expect(res.body.public.limit).toBe(res.body.community.public);
      });
    });

    it('con auth admin + licencia con feat:api.rate_limit.elevated → 200 con tier=enterprise', async () => {
      const testApp = await createTestApp({
        licenseKey: licenseWithRateLimitElevated,
        extraModules: [IntegrationRateLimitModule],
      });
      await withApp(testApp, async (server) => {
        const res = await supertest(server)
          .get(PATH)
          .set('Authorization', await bearer());
        expect(res.status).toBe(200);
        expect(res.body.tier).toBe('enterprise');
        expect(res.body.capability).toBe(LICENSE_CAPABILITIES.API_RATE_LIMIT_ELEVATED);
        // Los límites efectivos deben ser los del tier enterprise (mayor que
        // community por contrato del piloto sexto).
        expect(res.body.authenticated.limit).toBe(res.body.enterprise.authenticated);
        expect(res.body.enterprise.authenticated).toBeGreaterThan(res.body.community.authenticated);
      });
    });
  });
});
