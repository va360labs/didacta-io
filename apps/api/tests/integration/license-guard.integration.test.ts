/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de integración del LicenseGuard end-to-end (MIG-034).
 *
 * Lo que se valida (con Postgres real arrancado vía docker-compose.test.yml):
 *
 *   1. Sin licencia (community)               → 402 en endpoint EE.
 *   2. Licencia válida CON `feat:white_label` → 200 en endpoint EE.
 *   3. Licencia válida SIN `feat:white_label` → 402 (capability ausente).
 *   4. Licencia EXPIRADA (post grace)         → 402 (status `expired`).
 *   5. Licencia con firma INVÁLIDA            → 402 (status `invalid`).
 *   6. DEV BYPASS activo (NODE_ENV != prod)   → 200 (sintetiza todas caps).
 *   7. POST /configure sin licencia           → 402 (decorator también gatea).
 *   8. POST /configure con licencia válida    → 200 + persistencia en service.
 *
 * El LicenseService es 100% in-memory (opera sobre el JWT), pero el bootstrap
 * de la app sí usa Prisma → Postgres real. La DB nos sirve de prueba de que
 * el guard funciona dentro de un Nest con DI completo y conexión externa
 * activa, no en un sandbox aislado.
 *
 * Naming convention del test runner: el archivo termina en
 * `.integration.test.ts` porque la vitest config separada
 * (`vitest.integration.config.ts`) sólo recoge ese sufijo. La config unit
 * (`vitest.config.ts`) lo excluye explícitamente.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import { createTestApp, type TestApp } from './helpers/test-app';
import { issueCanonicalLicenses, issueTestLicense } from './helpers/issue-test-license';

const PREVIEW_PATH = '/api/v1/branding/white-label/preview';
const CONFIGURE_PATH = '/api/v1/branding/white-label/configure';
const CE_OPTIONS_PATH = '/api/v1/branding/options';

// Helper para cerrar la app y devolver el body parseado de la response.
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

describe('LicenseGuard — integración con Postgres real (MIG-034)', () => {
  let licenses: Awaited<ReturnType<typeof issueCanonicalLicenses>>;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    // Genera todas las licencias canónicas con el mismo `now` para que las
    // ventanas de expiración sean coherentes entre tests.
    licenses = await issueCanonicalLicenses(new Date());
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('[community] sin licencia → 402 en endpoint gateado', async () => {
    const testApp = await createTestApp({ licenseKey: null });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({
        statusCode: 402,
        error: 'CapabilityRequiredError',
        capability: LICENSE_CAPABILITIES.WHITE_LABEL,
      });
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toMatch(/white_label/i);
    });
  });

  it('[active+capability] licencia válida con feat:white_label → 200 + payload', async () => {
    const testApp = await createTestApp({
      licenseKey: licenses.validWithWhiteLabel,
    });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        canHideBrand: true,
        state: expect.any(Object),
      });
    });
  });

  it('[active sin capability] licencia válida sin feat:white_label → 402', async () => {
    const testApp = await createTestApp({
      licenseKey: licenses.validWithoutWhiteLabel,
    });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(402);
      expect(res.body.capability).toBe(LICENSE_CAPABILITIES.WHITE_LABEL);
    });
  });

  it('[grace + capability] licencia expirada DENTRO del grace period con feat:white_label → 200', async () => {
    // 5 días post-expiración con grace de 30 → status `grace`.
    // El SDK trata grace como "active funcionalmente" (capabilities siguen
    // habilitadas) pero reporta el state distinto al cliente.
    //
    // Detalle: el JWT estándar usa `exp` para que jose lo valide; ponemos
    // `jwtExpiresAt` lejano en futuro para que jose acepte la firma, mientras
    // `expiresAt` (didacta) está en pasado para que el runtime calcule grace.
    const now = new Date();
    const farFuture = new Date(now.getTime() + 365 * 86_400_000);
    const graceToken = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.WHITE_LABEL],
      organizationName: 'Acme In Grace',
      issuedAt: new Date(now.getTime() - 100 * 86_400_000),
      expiresAt: new Date(now.getTime() - 5 * 86_400_000),
      jwtExpiresAt: farFuture,
      gracePeriodDays: 30,
    });
    const testApp = await createTestApp({ licenseKey: graceToken });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(200);
      expect(res.body.canHideBrand).toBe(true);
    });
  });

  it('[grace sin capability] licencia en grace SIN feat:white_label → 402 (capability ausente, no expiración)', async () => {
    const now = new Date();
    const farFuture = new Date(now.getTime() + 365 * 86_400_000);
    const graceTokenWithoutCap = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.SCIM],
      organizationName: 'Acme In Grace SCIM only',
      issuedAt: new Date(now.getTime() - 100 * 86_400_000),
      expiresAt: new Date(now.getTime() - 5 * 86_400_000),
      jwtExpiresAt: farFuture,
      gracePeriodDays: 30,
    });
    const testApp = await createTestApp({ licenseKey: graceTokenWithoutCap });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(402);
      expect(res.body.capability).toBe(LICENSE_CAPABILITIES.WHITE_LABEL);
    });
  });

  it('[grace boundary] licencia expirada exactamente al borde del grace (29 días post) → 200', async () => {
    // Edge case: licencia 29 días post-expiración con grace 30 → aún en grace.
    const now = new Date();
    const farFuture = new Date(now.getTime() + 365 * 86_400_000);
    const edgeToken = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.WHITE_LABEL],
      organizationName: 'Acme Grace Edge',
      issuedAt: new Date(now.getTime() - 365 * 86_400_000),
      expiresAt: new Date(now.getTime() - 29 * 86_400_000),
      jwtExpiresAt: farFuture,
      gracePeriodDays: 30,
    });
    const testApp = await createTestApp({ licenseKey: edgeToken });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      // Justo dentro del grace → capability sigue habilitada.
      expect(res.status).toBe(200);
    });
  });

  it('[expired] licencia expirada (post-grace) con feat:white_label → 402', async () => {
    const testApp = await createTestApp({ licenseKey: licenses.expired });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      // Aunque la capability está en el payload, la licencia está expirada
      // → LicenseService la marca como `expired` → isCapabilityEnabled = false.
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('CapabilityRequiredError');

      // Verificamos también el LicenseController público — debe reportar
      // `expired` en el state. Esto confirma que la causa raíz del 402 es
      // la expiración (no la ausencia de capability).
      // Nota: el endpoint /api/license existe en ApiLicenseModule, que NO
      // está montado en el TestApp (excluido a propósito). Aquí sólo
      // chequeamos el contrato de status del guard.
    });
  });

  it('[invalid signature] firma con clave rogue → 402', async () => {
    const testApp = await createTestApp({
      licenseKey: licenses.invalidSignature,
    });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      // SDK marca como `invalid` y desactiva todas las capabilities.
      expect(res.status).toBe(402);
      expect(res.body.capability).toBe(LICENSE_CAPABILITIES.WHITE_LABEL);
    });
  });

  it('[dev bypass] NODE_ENV=development + DIDACTA_DEV_BYPASS → 200 sin licencia', async () => {
    process.env.NODE_ENV = 'development';
    const testApp = await createTestApp({
      licenseKey: 'whatever-not-validated-in-dev-mode',
      allowDevBypass: true,
    });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(200);
      expect(res.body.canHideBrand).toBe(true);
    });
  });

  it('[dev bypass refuses prod] NODE_ENV=production ignora bypass → 402', async () => {
    process.env.NODE_ENV = 'production';
    const testApp = await createTestApp({
      licenseKey: null,
      allowDevBypass: true,
    });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).get(PREVIEW_PATH);

      expect(res.status).toBe(402);
    });
    // Restauramos para que tests siguientes no hereden 'production'.
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('[POST gateado] configure sin licencia → 402 (decorator también gatea writes)', async () => {
    const testApp = await createTestApp({ licenseKey: null });

    await withApp(testApp, async (server) => {
      const res = await supertest(server)
        .post(CONFIGURE_PATH)
        .send({ logoUrl: 'https://acme.example.com/logo.png' });

      expect(res.status).toBe(402);
      expect(res.body.capability).toBe(LICENSE_CAPABILITIES.WHITE_LABEL);
    });
  });

  it('[POST gateado] configure con licencia válida → 200 y persiste en service', async () => {
    const testApp = await createTestApp({
      licenseKey: licenses.validWithWhiteLabel,
    });

    await withApp(testApp, async (server) => {
      const res = await supertest(server).post(CONFIGURE_PATH).send({
        logoUrl: 'https://acme.example.com/logo.png',
        primaryColor: '#ff5500',
        poweredByDidacta: false,
      });

      expect(res.status).toBe(201); // Nest @Post() default 201
      expect(res.body).toMatchObject({
        applied: { logoUrl: 'https://acme.example.com/logo.png' },
        state: expect.objectContaining({
          logoUrl: 'https://acme.example.com/logo.png',
          primaryColor: '#ff5500',
          poweredByDidacta: false,
        }),
      });

      // Comprobación cruzada: el endpoint CE refleja el cambio.
      const optsRes = await supertest(server).get(CE_OPTIONS_PATH);
      expect(optsRes.status).toBe(200);
      expect(optsRes.body.logoUrl).toBe('https://acme.example.com/logo.png');
    });
  });

  it('[regression] flow community → active con licencia distinta cada vez', async () => {
    // Sanity check: dos apps independientes con licencias distintas no
    // contaminan estado entre sí (LicenseService no es singleton cross-app).
    const community = await createTestApp({ licenseKey: null });
    await withApp(community, async (server) => {
      const r = await supertest(server).get(PREVIEW_PATH);
      expect(r.status).toBe(402);
    });

    const tokenScim = await issueTestLicense({
      capabilities: [LICENSE_CAPABILITIES.SCIM],
    });
    const onlyScim = await createTestApp({ licenseKey: tokenScim });
    await withApp(onlyScim, async (server) => {
      const r = await supertest(server).get(PREVIEW_PATH);
      expect(r.status).toBe(402);
      expect(r.body.capability).toBe(LICENSE_CAPABILITIES.WHITE_LABEL);
    });
  });
});
