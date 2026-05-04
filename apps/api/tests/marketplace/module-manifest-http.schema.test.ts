import { describe, expect, it } from 'vitest';
import {
  HTTP_CAPS,
  moduleManifestSchema,
} from '../../src/marketplace/module-manifest.schema';

/// Tests del bloque `http` añadido al manifest en alpha.49 (HTTP-002).
///
/// El manifest declara el contrato de salida HTTP del módulo: hosts
/// permitidos, rate limit, body cap. El schema rechaza valores que
/// superen los caps duros del core (`HTTP_CAPS.*`) — sin truncar
/// silenciosamente. La razón: defense-in-depth contra módulos que pidan
/// throughput descabellado para tirar a un upstream.
///
/// Wildcard `*` en allowedHosts requiere `unrestrictedHosts: true` como
/// reconocimiento explícito del dev (refuerzo: nadie pide `*` por
/// accidente).

const baseManifest = {
  name: 'mod.example',
  version: '1.0.0',
  displayName: 'Example',
  coreVersionRequired: '^0.0.0',
  tablePrefix: 'mod_example_',
  apiNamespace: '/modules/example',
  vendor: 'didacta' as const,
};

describe('moduleManifestSchema — bloque http (alpha.49)', () => {
  it('manifest sin bloque http es válido (módulos puramente locales)', () => {
    const result = moduleManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('http válido con allowedHosts específicos no requiere unrestrictedHosts', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['api.zoom.us', '*.zoom.us'],
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rechaza allowedHosts: ["*"] sin unrestrictedHosts: true', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['*'],
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message).join(' | ');
      expect(messages).toMatch(/unrestrictedHosts/);
    }
  });

  it('acepta allowedHosts: ["*"] con unrestrictedHosts: true', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['*'],
        unrestrictedHosts: true,
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rechaza requestsPerSecond por encima del cap del core', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['api.example.com'],
        rateLimitPerHost: {
          requestsPerSecond: HTTP_CAPS.MAX_REQUESTS_PER_SECOND + 1,
          burst: 10,
        },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza burst por encima del cap del core', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['api.example.com'],
        rateLimitPerHost: {
          requestsPerSecond: 5,
          burst: HTTP_CAPS.MAX_BURST + 1,
        },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza maxBodyBytes por encima del cap del core', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['api.example.com'],
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: HTTP_CAPS.MAX_BODY_BYTES + 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza host con scheme (http://api.zoom.us)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['http://api.zoom.us'],
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza host con path (api.zoom.us/v2)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['api.zoom.us/v2'],
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza allowedHosts vacío', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: [],
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza burst < requestsPerSecond? — no, no lo rechaza (decisión: el dev decide)', () => {
    // Documentado: schema NO valida coherencia burst >= rps. El token
    // bucket lo aguanta (burst < rps significa bucket pequeño, refill
    // alto — el rate limiter funciona igual). Si quisiéramos enforcar
    // esto, habría que añadir un refine() — pendiente decisión.
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      http: {
        allowedHosts: ['api.example.com'],
        rateLimitPerHost: { requestsPerSecond: 10, burst: 1 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(true);
  });

  it('manifest del migrator-learndash es válido (smoke regresión)', () => {
    const result = moduleManifestSchema.safeParse({
      name: 'mod.migrator-learndash',
      version: '1.0.0',
      displayName: 'Migrador desde WordPress + LearnDash',
      coreVersionRequired: '^0.0.0',
      tablePrefix: 'mod_migrator_learndash_',
      apiNamespace: '/modules/migrator-learndash',
      vendor: 'didacta',
      http: {
        allowedHosts: ['*'],
        unrestrictedHosts: true,
        rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
        maxBodyBytes: 10 * 1024 * 1024,
      },
    });
    expect(result.success).toBe(true);
  });
});
