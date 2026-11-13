/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Los enlaces que salen de un aula apuntan al dominio de ESA aula, también en un
 * servidor con varias (el pool de Didacta Cloud).
 *
 * El caso que lo destapó (13-nov-2026): el plano de control creó `aula-pruebas`
 * con `primaryHostname: aula-pruebas.didacta.io` y el correo de bienvenida de su
 * administradora llegó con `https://pool.didacta.io/reset-password?token=…`. La
 * base se calculaba sin aula y ganaba `WEB_PUBLIC_URL`, que en el pool es el
 * dominio del DESPLIEGUE. El token era del aula nueva: el enlace no servía.
 *
 * Cada test monta el pool tal cual está en producción —`WEB_PUBLIC_URL` y
 * `WEB_PUBLIC_ALLOWED_HOSTS` en `pool.didacta.io`, que además es el dominio de
 * su propia aula— y recorre los cuatro casos de cada camino:
 *
 *   - aula con subdominio de plataforma (`aula-pruebas.didacta.io`, nace
 *     verificado al aprovisionar);
 *   - aula con dominio propio verificado;
 *   - aula sin dominio (o con un primario aún sin verificar): respaldo
 *     `WEB_PUBLIC_URL`;
 *   - petición con un `Host` ajeno: un enlace con token NUNCA sale con él.
 *
 * El `TenantResolverService` es el REAL sobre un `tenant_domain` de mentira: lo
 * que se prueba es que cada camino pregunta por el aula correcta y respeta el
 * orden de la resolución.
 */

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminTenantsController } from '../src/admin/admin-tenants.controller';
import { AuthController } from '../src/auth/auth.controller';
import { OidcController } from '../src/sso/oidc/oidc.controller';
import { SamlController } from '../src/sso/saml/saml.controller';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';

// ─────────────────────────────── aulas ───────────────────────────────

/** El aula del propio despliegue (`didacta-cloud` en el pool). */
const POOL_TENANT = '10000000-0000-4000-8000-000000000001';
/** Aprovisionada por Cloud: subdominio de plataforma. */
const PLATAFORMA = '20000000-0000-4000-8000-000000000002';
/** Con dominio propio ya verificado por DNS. */
const PROPIO = '30000000-0000-4000-8000-000000000003';
/** Con un dominio propio puesto como primario pero AÚN sin verificar. */
const SIN_VERIFICAR = '40000000-0000-4000-8000-000000000004';
/** Sin ningún dominio (instalación de un solo inquilino). */
const SIN_DOMINIO = '50000000-0000-4000-8000-000000000005';

const DOMINIOS: Array<{ tenantId: string; hostname: string; verified: boolean }> = [
  { tenantId: POOL_TENANT, hostname: 'pool.didacta.io', verified: true },
  { tenantId: PLATAFORMA, hostname: 'aula-pruebas.didacta.io', verified: true },
  { tenantId: PROPIO, hostname: 'aula.academia.com', verified: true },
  { tenantId: SIN_VERIFICAR, hostname: 'todavia-no.academia.com', verified: false },
];

const POOL_URL = 'https://pool.didacta.io';
const HOST_AJENO = 'atacante.example';

/** Los cuatro casos de cada camino, con la base que tiene que salir. */
const CASOS = [
  {
    caso: 'subdominio de plataforma',
    tenantId: PLATAFORMA,
    base: 'https://aula-pruebas.didacta.io',
  },
  { caso: 'dominio propio verificado', tenantId: PROPIO, base: 'https://aula.academia.com' },
  { caso: 'primario sin verificar (no cuenta)', tenantId: SIN_VERIFICAR, base: POOL_URL },
  { caso: 'sin dominio', tenantId: SIN_DOMINIO, base: POOL_URL },
] as const;

/** `TenantResolverService` REAL sobre un `tenant_domain` en memoria. */
function makeResolver() {
  const findFirst = vi.fn(
    async (args: {
      where: { hostname?: string; tenantId?: string; isPrimary?: boolean; isVerified?: boolean };
    }) => {
      const w = args.where;
      const row = DOMINIOS.find((d) =>
        w.hostname !== undefined
          ? d.hostname === w.hostname
          : d.tenantId === w.tenantId && w.isPrimary === true,
      );
      if (!row) return null;
      // Las dos consultas del resolvedor piden `isVerified: true`.
      if (w.isVerified && !row.verified) return null;
      return {
        hostname: row.hostname,
        surface: 'APP',
        tenant: { id: row.tenantId, slug: row.hostname, name: row.hostname, status: 'ACTIVE' },
      };
    },
  );
  return new TenantResolverService({ tenantDomain: { findFirst } } as never);
}

/** Petición tal como la deja Traefik delante de la API. */
function peticion(host: string, extra: Record<string, unknown> = {}) {
  return {
    headers: { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
    ip: '203.0.113.7',
    ...extra,
  } as never;
}

const ENV_KEYS = ['WEB_PUBLIC_URL', 'WEB_PUBLIC_ALLOWED_HOSTS'];
const saved: Record<string, string | undefined> = {};

/** El pool tal como está en producción. */
function comoElPool() {
  process.env['WEB_PUBLIC_URL'] = POOL_URL;
  process.env['WEB_PUBLIC_ALLOWED_HOSTS'] = 'pool.didacta.io';
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ═══════════════════ 1. Bienvenida del aprovisionamiento ═══════════════════

describe('POST /admin/tenants · bienvenida a la primera administradora', () => {
  /**
   * Controlador REAL; del servicio solo se imita lo que importa aquí: crea el
   * aula y, ya con ella en la base, pide la base del enlace con su id.
   */
  function crearAula(nuevoTenantId: string, req: unknown) {
    const bases: string[] = [];
    const service = {
      create: vi.fn(
        async (
          _actor: unknown,
          _dto: unknown,
          webBaseUrl: string | ((tenantId: string) => Promise<string> | string),
        ) => {
          bases.push(
            typeof webBaseUrl === 'function' ? await webBaseUrl(nuevoTenantId) : webBaseUrl,
          );
          return { id: nuevoTenantId };
        },
      ),
    };
    const controller = new AdminTenantsController(service as never, {} as never, makeResolver());
    return { controller, bases, req };
  }

  const dto = {
    slug: 'aula-pruebas',
    name: 'Aula de pruebas',
    adminEmail: 'admin@example.test',
    primaryHostname: 'aula-pruebas.didacta.io',
  };
  /** Así llama el plano de control: credencial de provisioning, Host del pool. */
  const desdeCloud = (host = 'pool.didacta.io') =>
    peticion(host, { provisioningActor: { credentialId: 'cred-cloud' } });

  for (const c of CASOS) {
    it(`${c.caso} → ${c.base}`, async () => {
      comoElPool();
      const { controller, bases } = crearAula(c.tenantId, null);
      await controller.create(desdeCloud(), undefined, dto as never);
      expect(bases).toEqual([c.base]);
    });
  }

  it('CONTROL: es el caso exacto de producción y ya no sale pool.didacta.io', async () => {
    comoElPool();
    const { controller, bases } = crearAula(PLATAFORMA, null);
    await controller.create(desdeCloud(), undefined, dto as never);
    expect(bases[0]).not.toContain('pool.didacta.io');
    expect(`${bases[0]}/reset-password?token=x`).toBe(
      'https://aula-pruebas.didacta.io/reset-password?token=x',
    );
  });

  it('SEGURIDAD: Host ajeno, aula sin dominio y sin WEB_PUBLIC_URL → nunca el Host', async () => {
    const { controller, bases } = crearAula(SIN_DOMINIO, null);
    await controller.create(desdeCloud(HOST_AJENO), undefined, dto as never);
    expect(bases).toEqual(['http://localhost:3000']);
  });

  it('SEGURIDAD: Host ajeno con aula con dominio → el del aula', async () => {
    const { controller, bases } = crearAula(PLATAFORMA, null);
    await controller.create(desdeCloud(HOST_AJENO), undefined, dto as never);
    expect(bases).toEqual(['https://aula-pruebas.didacta.io']);
  });
});

// ═══════════════════ 2. Restablecer contraseña ═══════════════════

describe('POST /auth/forgot-password · enlace de restablecer', () => {
  function pedir(accountTenantId: string) {
    const bases: string[] = [];
    const requestAndSendEmail = vi.fn(
      async (
        _args: unknown,
        webBaseUrl: string | ((tenantId: string) => Promise<string> | string),
      ) => {
        bases.push(
          typeof webBaseUrl === 'function' ? await webBaseUrl(accountTenantId) : webBaseUrl,
        );
      },
    );
    const controller = new AuthController(
      {} as never,
      { requestAndSendEmail } as never,
      makeResolver(),
      {} as never,
    );
    return { controller, bases };
  }

  for (const c of CASOS) {
    it(`pedido desde pool.didacta.io, cuenta en un aula con ${c.caso} → ${c.base}`, async () => {
      comoElPool();
      const { controller, bases } = pedir(c.tenantId);
      await controller.forgotPassword(peticion('pool.didacta.io'), {
        email: 'alumna@example.test',
      } as never);
      expect(bases).toEqual([c.base]);
    });
  }

  it('pedido desde el propio dominio del aula → ese dominio', async () => {
    comoElPool();
    const { controller, bases } = pedir(PLATAFORMA);
    await controller.forgotPassword(peticion('aula-pruebas.didacta.io'), {
      email: 'alumna@example.test',
    } as never);
    expect(bases).toEqual(['https://aula-pruebas.didacta.io']);
  });

  it('SEGURIDAD: Host ajeno, aula sin dominio y sin WEB_PUBLIC_URL → nunca el Host', async () => {
    const { controller, bases } = pedir(SIN_DOMINIO);
    await controller.forgotPassword(peticion(HOST_AJENO), {
      email: 'alumna@example.test',
      tenantSlug: 'sin-dominio',
    } as never);
    expect(bases).toEqual(['http://localhost:3000']);
  });
});

// ═══════════════════ 3. Acceso de soporte (enlace con token) ═══════════════════

describe('POST /admin/tenants/:id/support-access · enlace de canje', () => {
  function abrir(tenantId: string, req: unknown) {
    const bases: string[] = [];
    const supportAccess = {
      grant: vi.fn(async (_a: unknown, _id: string, _dto: unknown, webBaseUrl: string) => {
        bases.push(webBaseUrl);
        return {};
      }),
    };
    const controller = new AdminTenantsController(
      {} as never,
      supportAccess as never,
      makeResolver(),
    );
    return controller
      .grantSupportAccess(req as never, undefined, tenantId, {
        reason: 'revisar un fallo de la clienta',
      })
      .then(() => bases);
  }

  for (const c of CASOS) {
    it(`${c.caso} → ${c.base}`, async () => {
      comoElPool();
      const bases = await abrir(
        c.tenantId,
        peticion('pool.didacta.io', { provisioningActor: { credentialId: 'cred-cloud' } }),
      );
      expect(bases).toEqual([c.base]);
    });
  }

  it('SEGURIDAD: Host ajeno, aula sin dominio y sin WEB_PUBLIC_URL → nunca el Host', async () => {
    const bases = await abrir(
      SIN_DOMINIO,
      peticion(HOST_AJENO, { provisioningActor: { credentialId: 'cred-cloud' } }),
    );
    expect(bases).toEqual(['http://localhost:3000']);
  });
});

// ═══════ 4. Invitaciones, reenvíos, alta por API, compras y verificación ═══════

/**
 * Invitar o reenviar el acceso (`admin-users`, `invitations`), el alta por API
 * (`inscribe`), las compras de curso y membresía («define tu contraseña» desde
 * los webhooks de Stripe), la verificación de miembros y los enlaces de
 * referidos piden su base con `resolveTenantWebBaseUrl(tenantId, req)`. El
 * webhook de Stripe llega por el dominio en el que se configuró, que puede no
 * ser el del aula de la compra: lo que manda es el `tenantId` del evento.
 */
describe('resolveTenantWebBaseUrl · enlaces de las peticiones del aula', () => {
  for (const c of CASOS) {
    it(`petición por el dominio del pool, aula con ${c.caso} → ${c.base}`, async () => {
      comoElPool();
      const base = await makeResolver().resolveTenantWebBaseUrl(
        c.tenantId,
        peticion('pool.didacta.io'),
      );
      expect(base).toBe(c.base);
    });
  }

  it('la petición llega por el dominio de OTRA aula → el del aula del enlace', async () => {
    comoElPool();
    const base = await makeResolver().resolveTenantWebBaseUrl(
      PLATAFORMA,
      peticion('aula.academia.com'),
    );
    expect(base).toBe('https://aula-pruebas.didacta.io');
  });
});

// ═══════════════════ 5. Correos de fondo (avisos, .ics, digest…) ═══════════════════

describe('resolveTenantWebBaseUrlForBackground · avisos, recordatorios, .ics', () => {
  for (const c of CASOS) {
    it(`${c.caso} → ${c.base}`, async () => {
      comoElPool();
      expect(await makeResolver().resolveTenantWebBaseUrlForBackground(c.tenantId)).toBe(c.base);
    });
  }

  it('sin dominio y sin WEB_PUBLIC_URL → sin enlace (nunca localhost)', async () => {
    expect(await makeResolver().resolveTenantWebBaseUrlForBackground(SIN_DOMINIO)).toBe('');
  });
});

// ═══════════════════ 6. Callbacks de SSO (redirect con tokens) ═══════════════════

describe('callbacks de OIDC y SAML · los tokens van al aula del usuario', () => {
  function reply() {
    const r = {
      url: '',
      status: vi.fn(() => r),
      redirect: vi.fn((u: string) => {
        r.url = u;
        return r;
      }),
    };
    return r;
  }
  const login = (tenantId: string) => ({
    tokens: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 900 },
    user: {
      id: 'u1',
      email: 'u@example.test',
      name: 'U',
      tenantId,
      tenantSlug: 'aula',
      roles: ['alumno'],
    },
  });

  for (const c of CASOS) {
    it(`OIDC, ${c.caso} → ${c.base}/auth/callback`, async () => {
      comoElPool();
      const oidc = { handleCallback: vi.fn(async () => login(c.tenantId)) };
      const ctrl = new OidcController(oidc as never, makeResolver());
      const res = reply();
      await ctrl.callback(
        'st',
        'code',
        undefined,
        undefined,
        res as never,
        peticion('pool.didacta.io'),
      );
      expect(res.url.startsWith(`${c.base}/auth/callback?`)).toBe(true);
      expect(new URL(res.url).searchParams.get('accessToken')).toBe('AT');
    });

    it(`SAML, ${c.caso} → ${c.base}/auth/callback`, async () => {
      comoElPool();
      const saml = { handleAcs: vi.fn(async () => login(c.tenantId)) };
      const ctrl = new SamlController(saml as never, makeResolver());
      const res = reply();
      await ctrl.acs('aula', { SAMLResponse: 'x' }, res as never, peticion('pool.didacta.io'));
      expect(res.url.startsWith(`${c.base}/auth/callback?`)).toBe(true);
    });
  }

  it('SEGURIDAD: OIDC con Host ajeno y aula sin dominio ni WEB_PUBLIC_URL → nunca el Host', async () => {
    const oidc = { handleCallback: vi.fn(async () => login(SIN_DOMINIO)) };
    const ctrl = new OidcController(oidc as never, makeResolver());
    const res = reply();
    await ctrl.callback('st', 'code', undefined, undefined, res as never, peticion(HOST_AJENO));
    expect(res.url.startsWith('http://localhost:3000/auth/callback?')).toBe(true);
  });

  it('un login fallido (sin tokens) sigue yendo a la base endurecida', async () => {
    comoElPool();
    const oidc = {
      handleCallback: vi.fn(async () => {
        throw new Error('IdP caído');
      }),
    };
    const ctrl = new OidcController(oidc as never, makeResolver());
    const res = reply();
    await ctrl.callback('st', 'code', undefined, undefined, res as never, peticion(HOST_AJENO));
    expect(res.url.startsWith(`${POOL_URL}/auth/error?`)).toBe(true);
  });
});
