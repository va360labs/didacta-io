/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ============================================================================
 * CONTRATO CON `didacta-cloud` — UC-C104
 * ============================================================================
 *
 * Estas once operaciones son las que un plano de control externo consume para
 * dar de alta, operar, facturar y sostener tenants. **Romperlas es un breaking change**:
 * no basta con que la suite siga verde aquí, hay que coordinar el cambio con
 * `didacta-cloud` (y con cualquier self-hoster que automatice su instalación)
 * antes de mergear.
 *
 * Lo que se fija: la ruta y el verbo, los nombres de campo de la petición, los
 * nombres de campo de la respuesta y los códigos de error. No solo los status
 * codes: un cliente se rompe igual si `activeMembers` pasa a llamarse
 * `active_members` que si el endpoint desaparece.
 *
 * Sustituye al shadow build cross-repo de abril, que necesitaba un PAT y
 * permisos de organización que nunca llegaron a funcionar, y que además solo
 * hacía `tsc --noEmit || echo warning`. Este test corre en cada PR, sin
 * secretos y sin acceso a ningún otro repositorio.
 *
 * Si añades un campo NUEVO opcional a una respuesta, actualiza la lista de
 * abajo: crecer el contrato está bien, encogerlo o renombrarlo no.
 */

import { LicenseService } from '@didacta/license-sdk';
import { RequestMethod, UnauthorizedException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminTenantsController,
  AdminTenantsPayoutsController,
  payoutsSettingsSchema,
  payoutsVolumeQuerySchema,
  createTenantSchema,
  domainSchema,
  setStatusSchema,
  signupsSchema,
  subscriptionGateFields,
  subscriptionGateSchema,
  supportAccessSchema,
} from '../../src/admin/admin-tenants.controller';
import { SupportAccessController } from '../../src/admin/support-access.controller';
import { SIGNUPS_FROZEN_CODE } from '../../src/tenancy/signup-freeze';
import { SUPPORT_ACCESS_CODES } from '../../src/tenancy/support-access';
import { SUBSCRIPTION_LOCKED_CODE } from '../../src/tenancy/subscription-gate';
import { AdminTenantsService } from '../../src/admin/admin-tenants.service';
import { ALLOW_PROVISIONING_KEY } from '../../src/auth/jwt-or-provisioning.guard';
import { PayoutsModule } from '../../src/modules/payouts/payouts.module';
import { loadPlatformPaymentsConfig } from '../../src/modules/payouts/platform-payments.config';

const ACTOR = { kind: 'user' as const, userId: 'user-super-1' };
const TENANT_ID = '99999999-8888-7777-6666-555555555555';

/** Las 11 operaciones del contrato: verbo + ruta relativa al controller. */
const CONTRACT_ROUTES: Array<{ handler: string; method: number; path: string }> = [
  { handler: 'list', method: RequestMethod.GET, path: '/' },
  { handler: 'usage', method: RequestMethod.GET, path: 'usage' },
  { handler: 'getOne', method: RequestMethod.GET, path: ':id' },
  { handler: 'create', method: RequestMethod.POST, path: '/' },
  { handler: 'setStatus', method: RequestMethod.PATCH, path: ':id/status' },
  { handler: 'setSignups', method: RequestMethod.PATCH, path: ':id/signups' },
  {
    handler: 'setSubscriptionGate',
    method: RequestMethod.PUT,
    path: ':id/subscription-gate',
  },
  { handler: 'grantSupportAccess', method: RequestMethod.POST, path: ':id/support-access' },
  {
    handler: 'revokeSupportAccess',
    method: RequestMethod.DELETE,
    path: ':id/support-access/:grantId',
  },
  { handler: 'addDomain', method: RequestMethod.POST, path: ':id/domains' },
  { handler: 'removeDomain', method: RequestMethod.DELETE, path: ':id/domains/:hostname' },
];

/** Ruta del canje. No cuelga de `admin/tenants`: es pública y la abre un navegador. */
const REDEEM_ROUTE = { handler: 'redeem', method: RequestMethod.POST, path: 'redeem' };

/** Respuesta de `list`, `getOne`, `create`, `setStatus`, `addDomain` y `removeDomain`. */
const TENANT_ITEM_FIELDS = [
  'id',
  'slug',
  'name',
  'status',
  'createdAt',
  'domains',
  'userCount',
  'courseCount',
];
const TENANT_DOMAIN_FIELDS = ['hostname', 'isPrimary', 'isVerified'];

/** Respuesta de `PUT :id/subscription-gate`. Cloud copia de aquí sus tipos. */
const SUBSCRIPTION_GATE_FIELDS = ['tenantId', 'state', 'trialEndsAt', 'actionUrl', 'updatedAt'];

/** Respuesta de `usage`. Es la que sostiene la facturación por tramos. */
const TENANT_USAGE_FIELDS = ['tenantId', 'slug', 'activeMembers', 'asOf'];

const TENANT_ROW = {
  id: TENANT_ID,
  slug: 'acme',
  name: 'Acme Corp',
  status: 'ACTIVE' as const,
  createdAt: new Date('2026-01-15T10:00:00.000Z'),
  domains: [{ hostname: 'acme.didacta.io', isPrimary: true, isVerified: true }],
  _count: { users: 12 },
};

function makePrisma() {
  return {
    tenant: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(TENANT_ROW),
      findMany: vi.fn().mockResolvedValue([TENANT_ROW]),
      update: vi.fn().mockResolvedValue(TENANT_ROW),
    },
    tenantDomain: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-tenant-admin' }) },
    user: { groupBy: vi.fn().mockResolvedValue([{ tenantId: TENANT_ID, _count: { id: 7 } }]) },
    modCoursesCourse: {
      count: vi.fn().mockResolvedValue(3),
      groupBy: vi.fn().mockResolvedValue([{ tenantId: TENANT_ID, _count: { id: 3 } }]),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenant: { create: vi.fn().mockResolvedValue({ id: TENANT_ID }), update: vi.fn() },
        tenantDomain: { create: vi.fn().mockResolvedValue({}) },
        user: { create: vi.fn().mockResolvedValue({ id: 'user-admin-1' }) },
        userRole: { create: vi.fn().mockResolvedValue({}) },
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    ),
  };
}

/** Código de error de una excepción de Nest, o null si no la lanzó. */
async function errorCodeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const response = (err as { response?: { code?: string } }).response;
    return response?.code ?? null;
  }
}

describe('CONTRATO · admin/tenants ↔ didacta-cloud', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: AdminTenantsService;

  beforeEach(async () => {
    prisma = makePrisma();
    const license = new LicenseService();
    await license.load({ allowDevBypass: true, key: 'dev-key' });
    service = new AdminTenantsService(
      ...([
        prisma,
        { record: vi.fn().mockResolvedValue(undefined) },
        { requestAndSendEmail: vi.fn().mockResolvedValue(undefined) },
        license,
        { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ] as unknown as ConstructorParameters<typeof AdminTenantsService>),
    );
  });

  describe('rutas', () => {
    it('el controller cuelga de admin/tenants', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AdminTenantsController)).toBe('admin/tenants');
    });

    it.each(CONTRACT_ROUTES)('$handler → $path', ({ handler, method, path }) => {
      const fn = (AdminTenantsController.prototype as unknown as Record<string, unknown>)[handler];
      expect(fn, `falta el handler ${handler}`).toBeTypeOf('function');
      expect(Reflect.getMetadata(PATH_METADATA, fn as object)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, fn as object)).toBe(method);
    });

    it('`usage` se declara antes que `:id` — al revés, Fastify buscaría un tenant llamado "usage"', () => {
      const orden = Object.getOwnPropertyNames(AdminTenantsController.prototype);
      expect(orden.indexOf('usage')).toBeLessThan(orden.indexOf('getOne'));
    });
  });

  describe('petición', () => {
    it('crear tenant acepta exactamente estos campos', () => {
      const body = {
        slug: 'acme',
        name: 'Acme Corp',
        adminEmail: 'admin@acme.io',
        adminName: 'Admin',
        primaryHostname: 'acme.didacta.io',
      };
      expect(createTenantSchema.parse(body)).toEqual(body);
      expect(Object.keys(createTenantSchema.shape).sort()).toEqual(
        ['slug', 'name', 'adminEmail', 'adminName', 'primaryHostname', 'simpleMode'].sort(),
      );
    });

    it('`simpleMode` es opcional y booleano: Cloud puede no enviarlo', () => {
      const base = {
        slug: 'acme',
        name: 'Acme Corp',
        adminEmail: 'admin@acme.io',
        primaryHostname: 'acme.didacta.io',
      };
      expect(createTenantSchema.safeParse({ ...base, simpleMode: true }).success).toBe(true);
      expect(createTenantSchema.safeParse({ ...base, simpleMode: false }).success).toBe(true);
      expect(createTenantSchema.safeParse({ ...base, simpleMode: 'si' }).success).toBe(false);
    });

    it('`adminName` y `simpleMode` son los únicos opcionales al crear', () => {
      const sinAdminName = {
        slug: 'acme',
        name: 'Acme Corp',
        adminEmail: 'admin@acme.io',
        primaryHostname: 'acme.didacta.io',
      };
      expect(createTenantSchema.safeParse(sinAdminName).success).toBe(true);
      for (const campo of ['slug', 'name', 'adminEmail', 'primaryHostname']) {
        const incompleto: Record<string, unknown> = { ...sinAdminName };
        delete incompleto[campo];
        expect(
          createTenantSchema.safeParse(incompleto).success,
          `${campo} debe ser obligatorio`,
        ).toBe(false);
      }
    });

    it('cambiar estado acepta los tres valores del enum y ninguno más', () => {
      for (const status of ['ACTIVE', 'SUSPENDED', 'ARCHIVED']) {
        expect(setStatusSchema.safeParse({ status }).success).toBe(true);
      }
      expect(setStatusSchema.safeParse({ status: 'DELETED' }).success).toBe(false);
      expect(setStatusSchema.safeParse({ status: 'active' }).success).toBe(false);
    });

    it('abrir acceso de soporte exige un motivo con cuerpo; la ventana es opcional', () => {
      // El motivo lo lee el CLIENTE en su audit log cuando quiera saber por qué
      // entró alguien de soporte en su aula. Diez caracteres no lo garantizan,
      // pero descartan el «test» de quien tenía prisa.
      expect(
        supportAccessSchema.parse({ reason: 'Incidencia #4210: no cargan las lecciones.' }),
      ).toEqual({ reason: 'Incidencia #4210: no cargan las lecciones.' });
      expect(supportAccessSchema.safeParse({}).success).toBe(false);
      expect(supportAccessSchema.safeParse({ reason: 'test' }).success).toBe(false);
      expect(
        supportAccessSchema.safeParse({ reason: 'Incidencia #4210.', ttlSeconds: 300 }).success,
      ).toBe(true);
      expect(Object.keys(supportAccessSchema.shape).sort()).toEqual(['reason', 'ttlSeconds']);
    });

    it('el canje vive en auth/support-access y lleva solo el token', () => {
      expect(Reflect.getMetadata(PATH_METADATA, SupportAccessController)).toBe(
        'auth/support-access',
      );
      const fn = (SupportAccessController.prototype as unknown as Record<string, unknown>)[
        REDEEM_ROUTE.handler
      ];
      expect(fn).toBeTypeOf('function');
      expect(Reflect.getMetadata(PATH_METADATA, fn as object)).toBe(REDEEM_ROUTE.path);
      expect(Reflect.getMetadata(METHOD_METADATA, fn as object)).toBe(REDEEM_ROUTE.method);
    });

    it('los códigos del acceso de soporte son estables', () => {
      // Cloud distingue «caducó» de «ya se usó» para decidir si reintenta o
      // pide una concesión nueva. Renombrarlos rompe esa decisión.
      expect(SUPPORT_ACCESS_CODES).toEqual({
        INVALID: 'SUPPORT_ACCESS_INVALID',
        EXPIRED: 'SUPPORT_ACCESS_EXPIRED',
        ALREADY_REDEEMED: 'SUPPORT_ACCESS_ALREADY_REDEEMED',
        REVOKED: 'SUPPORT_ACCESS_REVOKED',
        TENANT_UNAVAILABLE: 'SUPPORT_ACCESS_TENANT_UNAVAILABLE',
        NOT_FOUND: 'SUPPORT_ACCESS_NOT_FOUND',
      });
    });

    it('congelar altas lleva `frozen` y un `reason` obligatorio', () => {
      // El motivo se le enseña a quien se queda fuera, así que no es opcional:
      // «no admite altas» a secas no le dice nada a un alumno que quería entrar.
      expect(signupsSchema.parse({ frozen: true, reason: 'Cohorte completa.' })).toEqual({
        frozen: true,
        reason: 'Cohorte completa.',
      });
      expect(signupsSchema.safeParse({ frozen: true }).success).toBe(false);
      expect(signupsSchema.safeParse({ frozen: true, reason: 'no' }).success).toBe(false);
      expect(Object.keys(signupsSchema.shape).sort()).toEqual(['frozen', 'reason']);
    });

    it('el código que devuelven las cuatro puertas congeladas es estable', () => {
      // Cloud y el propio LMS lo distinguen de cualquier otro 409. Cambiarlo
      // rompe a los dos.
      expect(SIGNUPS_FROZEN_CODE).toBe('TENANT_SIGNUPS_FROZEN');
    });

    it('la puerta de suscripción lleva `state`, `trialEndsAt` y `actionUrl`', () => {
      expect(Object.keys(subscriptionGateFields.shape).sort()).toEqual(
        ['actionUrl', 'state', 'trialEndsAt'].sort(),
      );
      const trial = {
        state: 'TRIAL',
        trialEndsAt: '2026-11-18T18:00:00.000Z',
        actionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
      };
      expect(subscriptionGateSchema.parse(trial)).toEqual(trial);
      // OPEN no necesita nada más; LOCKED puede ir sin fecha.
      expect(subscriptionGateSchema.safeParse({ state: 'OPEN' }).success).toBe(true);
      expect(
        subscriptionGateSchema.safeParse({
          state: 'LOCKED',
          actionUrl: 'https://didacta.io/en/pricing?upgrade=tok',
        }).success,
      ).toBe(true);
    });

    it('la puerta rechaza lo que el contrato no admite (400)', () => {
      const https = 'https://didacta.io/es/pricing?upgrade=tok';
      const casos: Array<[string, unknown]> = [
        ['estado desconocido', { state: 'PAUSED' }],
        ['estado en minúsculas', { state: 'open' }],
        ['TRIAL sin fecha', { state: 'TRIAL', actionUrl: https }],
        ['TRIAL sin enlace', { state: 'TRIAL', trialEndsAt: '2026-11-18T18:00:00.000Z' }],
        ['LOCKED sin enlace', { state: 'LOCKED' }],
        [
          'enlace http',
          {
            state: 'TRIAL',
            trialEndsAt: '2026-11-18T18:00:00.000Z',
            actionUrl: 'http://didacta.io/es/pricing',
          },
        ],
        ['fecha que no es ISO', { state: 'TRIAL', trialEndsAt: '18/11/2026', actionUrl: https }],
      ];
      for (const [caso, body] of casos) {
        expect(subscriptionGateSchema.safeParse(body).success, caso).toBe(false);
      }
    });

    it('el código del 402 de un aula en pausa es estable', () => {
      // El aula lo usa para pintar la pantalla de pausa; Cloud, para saber que
      // el bloqueo está surtiendo efecto.
      expect(SUBSCRIPTION_LOCKED_CODE).toBe('SUBSCRIPTION_LOCKED');
    });

    it('añadir dominio lleva `hostname`', () => {
      expect(domainSchema.parse({ hostname: 'otro.didacta.io' })).toEqual({
        hostname: 'otro.didacta.io',
      });
      expect(Object.keys(domainSchema.shape)).toEqual(['hostname']);
    });
  });

  describe('respuesta', () => {
    it('list devuelve los campos del contrato, con `createdAt` en ISO-8601', async () => {
      const [item] = await service.list();
      expect(item).toBeDefined();
      expect(Object.keys(item!).sort()).toEqual([...TENANT_ITEM_FIELDS].sort());
      expect(item!.createdAt).toBe('2026-01-15T10:00:00.000Z');
      expect(Object.keys(item!.domains[0]!).sort()).toEqual([...TENANT_DOMAIN_FIELDS].sort());
      expect(item!.userCount).toBe(12);
      expect(item!.courseCount).toBe(3);
    });

    it('getDetail devuelve la misma forma que list', async () => {
      const detail = await service.getDetail(TENANT_ID);
      expect(Object.keys(detail).sort()).toEqual([...TENANT_ITEM_FIELDS].sort());
    });

    it('usage devuelve tenantId, slug, activeMembers y el corte aplicado', async () => {
      const asOf = new Date('2026-02-01T00:00:00.000Z');
      const [row] = await service.getUsage(asOf);
      expect(row).toBeDefined();
      expect(Object.keys(row!).sort()).toEqual([...TENANT_USAGE_FIELDS].sort());
      expect(row!.tenantId).toBe(TENANT_ID);
      expect(row!.activeMembers).toBe(7);
      // Eco de la fecha pedida: la factura tiene que ser auditable.
      expect(row!.asOf).toBe('2026-02-01T00:00:00.000Z');
    });

    it('la puerta devuelve tenantId, state, trialEndsAt, actionUrl y updatedAt', async () => {
      prisma.tenant.findFirst.mockResolvedValue({
        id: TENANT_ID,
        subscriptionGateState: 'OPEN',
        subscriptionTrialEndsAt: null,
        subscriptionActionUrl: null,
        subscriptionGateUpdatedAt: null,
      });
      const res = await service.setSubscriptionGate(ACTOR, TENANT_ID, {
        state: 'TRIAL',
        trialEndsAt: '2026-11-18T18:00:00.000Z',
        actionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
      });
      expect(Object.keys(res).sort()).toEqual([...SUBSCRIPTION_GATE_FIELDS].sort());
      expect(res).toMatchObject({
        tenantId: TENANT_ID,
        state: 'TRIAL',
        trialEndsAt: '2026-11-18T18:00:00.000Z',
        actionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
      });
      expect(res.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // No toca `status`: el aula en prueba o en pausa sigue ACTIVE.
      const data = prisma.tenant.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('status');
    });

    it('OPEN borra la fecha y el enlace aunque vengan en la petición', async () => {
      prisma.tenant.findFirst.mockResolvedValue({
        id: TENANT_ID,
        subscriptionGateState: 'LOCKED',
        subscriptionTrialEndsAt: new Date('2026-11-18T18:00:00.000Z'),
        subscriptionActionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
        subscriptionGateUpdatedAt: new Date('2026-11-18T18:05:00.000Z'),
      });
      const res = await service.setSubscriptionGate(ACTOR, TENANT_ID, {
        state: 'OPEN',
        trialEndsAt: '2026-11-18T18:00:00.000Z',
        actionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
      });
      expect(res).toMatchObject({ state: 'OPEN', trialEndsAt: null, actionUrl: null });
      expect(prisma.tenant.update.mock.calls[0]?.[0]?.data).toMatchObject({
        subscriptionGateState: 'OPEN',
        subscriptionTrialEndsAt: null,
        subscriptionActionUrl: null,
      });
    });

    it('es idempotente: repetir lo mismo no escribe ni mueve updatedAt', async () => {
      const antes = new Date('2026-11-11T10:00:00.000Z');
      prisma.tenant.findFirst.mockResolvedValue({
        id: TENANT_ID,
        subscriptionGateState: 'TRIAL',
        subscriptionTrialEndsAt: new Date('2026-11-18T18:00:00.000Z'),
        subscriptionActionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
        subscriptionGateUpdatedAt: antes,
      });
      const res = await service.setSubscriptionGate(ACTOR, TENANT_ID, {
        state: 'TRIAL',
        trialEndsAt: '2026-11-18T18:00:00.000Z',
        actionUrl: 'https://didacta.io/es/pricing?upgrade=tok',
      });
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(res.updatedAt).toBe(antes.toISOString());
    });

    it('un tenant sin miembros aparece con activeMembers 0, no ausente', async () => {
      prisma.user.groupBy.mockResolvedValue([]);
      const [row] = await service.getUsage();
      expect(row?.activeMembers).toBe(0);
    });
  });

  describe('errores', () => {
    const dto = {
      slug: 'acme',
      name: 'Acme Corp',
      adminEmail: 'admin@acme.io',
      primaryHostname: 'acme.didacta.io',
    };

    it('slug con formato inválido', async () => {
      await expect(
        errorCodeOf(() => service.create(ACTOR, { ...dto, slug: 'Acme SA' }, 'http://x')),
      ).resolves.toBe('ADMIN_TENANT_SLUG_INVALID');
    });

    it('hostname con formato inválido', async () => {
      await expect(
        errorCodeOf(() =>
          service.create(ACTOR, { ...dto, primaryHostname: 'ACME_/io' }, 'http://x'),
        ),
      ).resolves.toBe('ADMIN_TENANT_HOSTNAME_INVALID');
    });

    it('slug ya existente', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 'otro' });
      await expect(errorCodeOf(() => service.create(ACTOR, dto, 'http://x'))).resolves.toBe(
        'ADMIN_TENANT_SLUG_EXISTS',
      );
    });

    it('hostname ya asignado', async () => {
      prisma.tenantDomain.findUnique.mockResolvedValue({ id: 'dom-1' });
      await expect(errorCodeOf(() => service.create(ACTOR, dto, 'http://x'))).resolves.toBe(
        'ADMIN_TENANT_HOSTNAME_EXISTS',
      );
    });

    it('tenant inexistente al consultarlo o al cambiarle el estado', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);
      await expect(errorCodeOf(() => service.getDetail('no-existe'))).resolves.toBe(
        'ADMIN_TENANT_NOT_FOUND',
      );
      await expect(
        errorCodeOf(() => service.setStatus(ACTOR, 'no-existe', 'SUSPENDED')),
      ).resolves.toBe('ADMIN_TENANT_NOT_FOUND');
    });

    it('tenant inexistente al mover la puerta', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);
      await expect(
        errorCodeOf(() =>
          service.setSubscriptionGate(ACTOR, 'no-existe', {
            state: 'OPEN',
            trialEndsAt: null,
            actionUrl: null,
          }),
        ),
      ).resolves.toBe('ADMIN_TENANT_NOT_FOUND');
    });

    it('dominio inexistente al quitarlo', async () => {
      prisma.tenantDomain.findFirst.mockResolvedValue(null);
      await expect(
        errorCodeOf(() => service.removeDomain(ACTOR, TENANT_ID, 'otro.didacta.io')),
      ).resolves.toBe('ADMIN_TENANT_DOMAIN_NOT_FOUND');
    });

    it('el dominio primario no se puede quitar', async () => {
      prisma.tenantDomain.findFirst.mockResolvedValue({ id: 'dom-1', isPrimary: true });
      await expect(
        errorCodeOf(() => service.removeDomain(ACTOR, TENANT_ID, 'acme.didacta.io')),
      ).resolves.toBe('ADMIN_TENANT_PRIMARY_DOMAIN_DELETE_FORBIDDEN');
    });

    it('el corte de facturación no puede estar en el futuro', async () => {
      const futuro = new Date(Date.now() + 86_400_000);
      await expect(errorCodeOf(() => service.getUsage(futuro))).resolves.toBe(
        'ADMIN_TENANT_USAGE_ASOF_IN_FUTURE',
      );
    });
  });
});

// ============================================================================
// Cobros de plataforma (E2): dos rutas más del contrato, SOLO con el modo
// plataforma encendido. Las consume `didacta-cloud` (`pool-contract.ts`) para
// empujar la comisión de cada aula y leer su estado de cobro.
// ============================================================================

const PAYOUTS_ROUTES: Array<{ handler: string; method: number; path: string }> = [
  { handler: 'getPayoutsVolume', method: RequestMethod.GET, path: 'payouts/volume' },
  { handler: 'setPayoutsSettings', method: RequestMethod.PUT, path: ':id/payouts-settings' },
  { handler: 'getPayouts', method: RequestMethod.GET, path: ':id/payouts' },
];

describe('CONTRATO · admin/tenants (cobros de plataforma) ↔ didacta-cloud', () => {
  const PAYOUTS_TENANT = '11111111-2222-4333-8444-555555555555';
  const machineReq = {
    provisioningActor: { credentialId: 'cred-1' },
    headers: {},
    ip: '127.0.0.1',
  };

  function buildController(overrides: { tenantExists?: boolean } = {}) {
    const settings = {
      setFeeBps: vi.fn(async (tenantId: string, feeBps: number) => ({
        tenantId,
        feeBps,
        updatedAt: '2026-11-12T10:00:00.000Z',
        changed: true,
        previousFeeBps: 500,
      })),
      get: vi.fn(async (tenantId: string) => ({
        tenantId,
        feeBps: 500,
        updatedAt: null,
      })),
      debtOutstanding: vi.fn(async () => []),
    };
    const reports = {
      volume: vi.fn(async (from: Date, to: Date) => [
        {
          tenantId: PAYOUTS_TENANT,
          day: from.toISOString().slice(0, 10),
          currency: 'eur',
          gmv: 10000,
          stripeFees: 175,
          platformFees: 500,
          refunds: 0,
          disputes: 0,
          salesCount: 1,
          _to: to.toISOString(),
        },
      ]),
    };
    const runtime = {
      reports,
      settings,
      accounts: {
        getAccount: vi.fn(async () => ({ status: 'ONBOARDING', country: 'ES' })),
      },
      mode: {
        resolve: vi.fn(async () => ({
          mode: 'platform',
          ready: false,
          reason: 'onboarding_incomplete',
        })),
      },
      prisma: {
        tenant: {
          findFirst: vi.fn(async () =>
            overrides.tenantExists === false ? null : { id: PAYOUTS_TENANT },
          ),
        },
      },
    };
    const audit = { record: vi.fn(async () => undefined) };
    const controller = new AdminTenantsPayoutsController(
      runtime as unknown as ConstructorParameters<typeof AdminTenantsPayoutsController>[0],
      audit as unknown as ConstructorParameters<typeof AdminTenantsPayoutsController>[1],
    );
    return { controller, settings, audit, reports };
  }

  it('cuelgan de admin/tenants, en un controller aparte del de siempre', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminTenantsPayoutsController)).toBe('admin/tenants');
  });

  it.each(PAYOUTS_ROUTES)('$handler → $path, abierta a la credencial de provisioning', (r) => {
    const fn = (AdminTenantsPayoutsController.prototype as unknown as Record<string, unknown>)[
      r.handler
    ];
    expect(fn, `falta el handler ${r.handler}`).toBeTypeOf('function');
    expect(Reflect.getMetadata(PATH_METADATA, fn as object)).toBe(r.path);
    expect(Reflect.getMetadata(METHOD_METADATA, fn as object)).toBe(r.method);
    expect(Reflect.getMetadata(ALLOW_PROVISIONING_KEY, fn as object)).toBe(true);
  });

  it('solo existen con el modo plataforma: el módulo apagado no las registra', () => {
    const off = PayoutsModule.register({ enabled: false });
    expect(off.controllers ?? []).toEqual([]);
    const on = PayoutsModule.register(
      loadPlatformPaymentsConfig({
        PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventada',
        PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_inventado1',
      }),
    );
    expect(on.controllers).toContain(AdminTenantsPayoutsController);
  });

  it('la petición lleva solo `feeBps`, entero de 0 a 3000', () => {
    expect(Object.keys(payoutsSettingsSchema.shape)).toEqual(['feeBps']);
    for (const ok of [0, 500, 3000]) {
      expect(payoutsSettingsSchema.parse({ feeBps: ok })).toEqual({ feeBps: ok });
    }
    for (const bad of [3001, -1, 2.5, '500', null]) {
      expect(payoutsSettingsSchema.safeParse({ feeBps: bad }).success, String(bad)).toBe(false);
    }
    expect(payoutsSettingsSchema.safeParse({}).success).toBe(false);
  });

  it('PUT payouts-settings responde tenantId, feeBps y updatedAt', async () => {
    const { controller, audit } = buildController();
    const res = await controller.setPayoutsSettings(
      machineReq as never,
      undefined,
      PAYOUTS_TENANT,
      { feeBps: 300 },
    );
    expect(res).toEqual({
      tenantId: PAYOUTS_TENANT,
      feeBps: 300,
      updatedAt: '2026-11-12T10:00:00.000Z',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payouts.settings.fee_changed', tenantId: PAYOUTS_TENANT }),
    );
  });

  it('GET payouts responde tenantId, mode, status, country, feeBps y debtOutstanding', async () => {
    const { controller } = buildController();
    const res = await controller.getPayouts(machineReq as never, undefined, PAYOUTS_TENANT);
    expect(Object.keys(res).sort()).toEqual(
      ['country', 'debtOutstanding', 'feeBps', 'mode', 'status', 'tenantId'].sort(),
    );
    expect(res).toEqual({
      tenantId: PAYOUTS_TENANT,
      mode: 'platform',
      status: 'ONBOARDING',
      country: 'ES',
      feeBps: 500,
      debtOutstanding: [],
    });
  });

  it('sin credencial ni super_admin → 401; tenant inexistente → ADMIN_TENANT_NOT_FOUND', async () => {
    const { controller } = buildController();
    await expect(
      controller.getPayouts({ headers: {} } as never, undefined, PAYOUTS_TENANT),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const missing = buildController({ tenantExists: false });
    await expect(
      errorCodeOf(() =>
        missing.controller.getPayouts(machineReq as never, undefined, PAYOUTS_TENANT),
      ),
    ).resolves.toBe('ADMIN_TENANT_NOT_FOUND');
  });

  // ── GET payouts/volume (E4): lo consume `VolumeCaptureService` de Cloud ──

  it('payouts/volume se declara ANTES que las rutas con `:id`', () => {
    const names = Object.getOwnPropertyNames(AdminTenantsPayoutsController.prototype);
    expect(names.indexOf('getPayoutsVolume')).toBeGreaterThan(-1);
    expect(names.indexOf('getPayoutsVolume')).toBeLessThan(names.indexOf('setPayoutsSettings'));
    expect(names.indexOf('getPayoutsVolume')).toBeLessThan(names.indexOf('getPayouts'));
  });

  it('payouts/volume: `from` y `to` son días YYYY-MM-DD incluidos, máximo 366 días', () => {
    expect(Object.keys(payoutsVolumeQuerySchema.shape).sort()).toEqual(['from', 'to']);
    const ok = (from: string, to: string) =>
      payoutsVolumeQuerySchema.safeParse({ from, to }).success;
    expect(ok('2026-11-01', '2026-11-30')).toBe(true);
    expect(ok('2026-11-12', '2026-11-12')).toBe(true);
    expect(ok('2025-11-12', '2026-11-12')).toBe(true); // 366 días contando los dos extremos
    expect(ok('2025-11-11', '2026-11-12')).toBe(false);
    expect(ok('2026-11-13', '2026-11-12')).toBe(false);
    expect(ok('2026-02-30', '2026-03-01')).toBe(false);
    expect(ok('2026-11-12T00:00:00Z', '2026-11-13')).toBe(false);
    expect(payoutsVolumeQuerySchema.safeParse({ from: '2026-11-01' }).success).toBe(false);
  });

  it('payouts/volume responde filas tenantId, day, currency, gmv, stripeFees, platformFees, refunds, disputes, salesCount', async () => {
    const { controller, reports } = buildController();
    const rows = await controller.getPayoutsVolume(machineReq as never, undefined, {
      from: '2026-11-01',
      to: '2026-11-12',
    });
    // `to` se incluye: el servicio recibe el final EXCLUSIVO del día siguiente.
    expect(reports.volume).toHaveBeenCalledWith(
      new Date('2026-11-01T00:00:00.000Z'),
      new Date('2026-11-13T00:00:00.000Z'),
    );
    const { _to: _ignored, ...row } = rows[0] as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      [
        'currency',
        'day',
        'disputes',
        'gmv',
        'platformFees',
        'refunds',
        'salesCount',
        'stripeFees',
        'tenantId',
      ].sort(),
    );
  });

  it('payouts/volume exige credencial de aprovisionamiento (o super_admin): sin ella 401, tenant_admin 403', async () => {
    const { controller, reports } = buildController();
    const query = { from: '2026-11-01', to: '2026-11-12' };
    await expect(
      controller.getPayoutsVolume({ headers: {} } as never, undefined, query),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      errorCodeOf(() =>
        controller.getPayoutsVolume(
          { headers: {} } as never,
          { sub: 'u', tenantId: PAYOUTS_TENANT, roles: ['tenant_admin'] } as never,
          query,
        ),
      ),
    ).resolves.toBe('ADMIN_FORBIDDEN_SUPER_ADMIN_REQUIRED');
    expect(reports.volume).not.toHaveBeenCalled();
  });
});
