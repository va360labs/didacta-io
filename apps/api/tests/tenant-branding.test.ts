/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `GET/PUT /admin/tenants/:id/branding` (ADR-007): nombre y color del aula para
 * el panel del creador de Didacta Cloud. Es la única puerta por la que la
 * credencial de provisioning puede renombrar un aula, así que aquí se fija lo
 * que NO hace tanto como lo que hace: sin tocar nada si no cambia, validando
 * todo antes de escribir y con el mismo audit log que `rename`.
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AdminTenantsController } from '../src/admin/admin-tenants.controller';
import { AdminTenantsService } from '../src/admin/admin-tenants.service';
import { brandToHex, hexToBrand } from '../src/admin/tenant-branding';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const machineReq = { provisioningActor: { credentialId: 'cred-1' }, headers: {}, ip: '127.0.0.1' };
const noActorReq = { headers: {} };

describe('hexToBrand / brandToHex', () => {
  it('colores conocidos: tono y saturación del hex; la luminosidad se descarta', () => {
    expect(hexToBrand('#ff0000')).toEqual({ brandHue: 0, brandSaturation: 98 });
    expect(hexToBrand('#00ff00')).toEqual({ brandHue: 120, brandSaturation: 98 });
    expect(hexToBrand('#0000ff')).toEqual({ brandHue: 240, brandSaturation: 98 });
    // Grises: sin saturación, tono 0.
    expect(hexToBrand('#808080')).toEqual({ brandHue: 0, brandSaturation: 0 });
    expect(hexToBrand('#FFFFFF')).toEqual({ brandHue: 0, brandSaturation: 0 });
    // Mayúsculas y minúsculas dan lo mismo.
    expect(hexToBrand('#0A84FF')).toEqual(hexToBrand('#0a84ff'));
  });

  it('lo que sale del aula vuelve cerca del mismo aula: hex → marca, con la deriva de 8 bits por canal', () => {
    const circular = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
    for (let hue = 0; hue < 360; hue += 7) {
      for (let saturation = 0; saturation <= 100; saturation += 9) {
        const hex = brandToHex(hue, saturation);
        const back = hexToBrand(hex);
        // El hex tiene 8 bits por canal: se tolera una pequeña deriva…
        if (saturation >= 8)
          expect(circular(back.brandHue, hue), `${hue},${saturation}`).toBeLessThanOrEqual(2);
        expect(
          Math.abs(back.brandSaturation - saturation),
          `${hue},${saturation}`,
        ).toBeLessThanOrEqual(3);
      }
    }
  });

  it('el rango siempre es el que acepta el servicio de theming (tono 0–360, saturación 0–100)', () => {
    for (const hex of ['#000000', '#ffffff', '#ff00ff', '#010101', '#fefefe', '#7f7f80']) {
      const { brandHue, brandSaturation } = hexToBrand(hex);
      expect(brandHue).toBeGreaterThanOrEqual(0);
      expect(brandHue).toBeLessThanOrEqual(360);
      expect(brandSaturation).toBeGreaterThanOrEqual(0);
      expect(brandSaturation).toBeLessThanOrEqual(100);
    }
  });

  it('un hex mal formado no se interpreta: lanza', () => {
    for (const bad of ['red', '#fff', '0a84ff', '#0a84f', '#0a84fg', '']) {
      expect(() => hexToBrand(bad), bad).toThrow();
    }
  });
});

// ── Servicio y controller ─────────────────────────────────────────────────

interface World {
  name: string;
  slug: string;
  theme: { brandHue: number; brandSaturation: number } | null;
}

function build(world: Partial<World> = {}, options: { registry?: boolean; sync?: boolean } = {}) {
  const state: World = {
    name: 'Academia Original',
    slug: 'original',
    theme: { brandHue: 213, brandSaturation: 70 },
    ...world,
  };
  const themeContexts: Array<string | null> = [];
  const prisma = {
    tenantDomain: {
      // Como la base: el filtro `isPrimary` es lo que elige el dominio.
      findFirst: vi.fn(async (args: { where: { tenantId: string; isPrimary: boolean } }) =>
        args.where.tenantId === TENANT && args.where.isPrimary
          ? { hostname: 'original.didacta.io' }
          : null,
      ),
    },
    tenant: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === TENANT
          ? {
              id: TENANT,
              name: state.name,
              slug: state.slug,
              status: 'ACTIVE',
              createdAt: new Date('2026-01-01T00:00:00Z'),
              domains: [
                { hostname: 'otro.didacta.io', isPrimary: false, isVerified: true },
                { hostname: 'original.didacta.io', isPrimary: true, isVerified: true },
              ],
              _count: { users: 3 },
            }
          : null,
      ),
      update: vi.fn(async (args: { data: { name: string } }) => {
        state.name = args.data.name;
        return {};
      }),
    },
    modCoursesCourse: { count: vi.fn(async () => 0) },
    modThemingTenantTheme: {
      findUnique: vi.fn(async () => {
        themeContexts.push(tenantContextStorage.getStore()?.tenantId ?? null);
        return state.theme;
      }),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const themingUpdate = vi.fn(
    async (_id: string, dto: { brandHue: number; brandSaturation: number }) => {
      state.theme = { brandHue: dto.brandHue, brandSaturation: dto.brandSaturation };
      return {};
    },
  );
  const registry =
    options.registry === false
      ? undefined
      : { getThemingService: () => ({ update: themingUpdate }) };
  const sync = options.sync === false ? undefined : { request: vi.fn() };
  const auditLog = { record: vi.fn(async (_entry: Record<string, unknown>) => undefined) };
  const service = new AdminTenantsService(
    prisma as never,
    auditLog as never,
    {} as never,
    {} as never,
    { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    registry as never,
    sync as never,
  );
  const controller = new AdminTenantsController(service, {} as never, {} as never);
  return { service, controller, prisma, themingUpdate, auditLog, sync, state, themeContexts };
}

const actions = (auditLog: { record: ReturnType<typeof vi.fn> }) =>
  auditLog.record.mock.calls.map((c) => c[0]['action']);

describe('GET :id/branding', () => {
  it('responde name, primaryColor, slug y primaryHostname (el primario, no el primero)', async () => {
    const { controller } = build();
    const res = await controller.getBranding(machineReq as never, undefined, TENANT);
    expect(Object.keys(res).sort()).toEqual(['name', 'primaryColor', 'primaryHostname', 'slug']);
    expect(res).toEqual({
      name: 'Academia Original',
      primaryColor: brandToHex(213, 70),
      slug: 'original',
      primaryHostname: 'original.didacta.io',
    });
    expect(res.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('un aula sin marca personalizada → primaryColor null, y leer NO crea el tema', async () => {
    const { controller, prisma } = build({ theme: null });
    const res = await controller.getBranding(machineReq as never, undefined, TENANT);
    expect(res.primaryColor).toBeNull();
    expect(prisma.modThemingTenantTheme.create).not.toHaveBeenCalled();
    expect(prisma.modThemingTenantTheme.update).not.toHaveBeenCalled();
  });

  it('el tema se lee bajo el contexto del aula pedida (RLS)', async () => {
    const { controller, themeContexts } = build();
    await controller.getBranding(machineReq as never, undefined, TENANT);
    expect(themeContexts).toEqual([TENANT]);
  });

  it('aula inexistente → 404 ADMIN_TENANT_NOT_FOUND (CONTROL del anterior)', async () => {
    const { controller } = build();
    await expect(
      controller.getBranding(machineReq as never, undefined, OTHER),
    ).rejects.toMatchObject({
      response: { code: 'ADMIN_TENANT_NOT_FOUND' },
    });
  });

  it('sin credencial → 401; tenant_admin → 403; super_admin → pasa', async () => {
    const { controller } = build();
    await expect(
      controller.getBranding(noActorReq as never, undefined, TENANT),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.getBranding(
        noActorReq as never,
        { sub: 'u', tenantId: TENANT, roles: ['tenant_admin'] } as never,
        TENANT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.getBranding(
        noActorReq as never,
        { sub: 'root', tenantId: TENANT, roles: ['super_admin'] } as never,
        TENANT,
      ),
    ).resolves.toMatchObject({ slug: 'original' });
  });
});

describe('PUT :id/branding', () => {
  it('solo el nombre: pasa por rename (audit admin.tenant.renamed con actor de máquina) y no toca el tema', async () => {
    const { controller, prisma, themingUpdate, auditLog, sync } = build();
    const res = await controller.setBranding(machineReq as never, undefined, TENANT, {
      name: '  Academia Nueva ',
    });
    expect(res.name).toBe('Academia Nueva');
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { name: 'Academia Nueva' },
    });
    expect(actions(auditLog)).toEqual(['admin.tenant.renamed']);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'cred-1',
        metadata: expect.objectContaining({
          previousName: 'Academia Original',
          newName: 'Academia Nueva',
          actorKind: 'provisioning',
        }),
      }),
    );
    expect(themingUpdate).not.toHaveBeenCalled();
    expect(sync!.request).toHaveBeenCalledWith(TENANT);
  });

  it('solo el color: el servicio de theming recibe tono y saturación, queda su audit y el nombre NO se toca', async () => {
    const { controller, prisma, themingUpdate, auditLog, sync } = build();
    const res = await controller.setBranding(machineReq as never, undefined, TENANT, {
      primaryColor: '#E11D48',
    });
    const expected = hexToBrand('#E11D48');
    expect(themingUpdate).toHaveBeenCalledWith(TENANT, expected);
    // La respuesta es el color YA normalizado (luminosidad fija), no el enviado.
    expect(res.primaryColor).toBe(brandToHex(expected.brandHue, expected.brandSaturation));
    expect(res.name).toBe('Academia Original');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(actions(auditLog)).toEqual(['admin.tenant.branding_color_changed']);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          previousColor: brandToHex(213, 70),
          color: res.primaryColor,
          actorKind: 'provisioning',
        }),
      }),
    );
    expect(sync!.request).toHaveBeenCalledWith(TENANT);
  });

  it('el color se escribe bajo el contexto del aula (RLS), no el del que llama', async () => {
    const { controller, themingUpdate } = build();
    let contextTenant: string | null = null;
    themingUpdate.mockImplementationOnce(async () => {
      contextTenant = tenantContextStorage.getStore()?.tenantId ?? null;
      return {};
    });
    await controller.setBranding(machineReq as never, undefined, TENANT, {
      primaryColor: '#E11D48',
    });
    expect(contextTenant).toBe(TENANT);
  });

  it('nombre y color a la vez: los dos cambian, con sus dos filas de audit', async () => {
    const { controller, auditLog } = build();
    const res = await controller.setBranding(machineReq as never, undefined, TENANT, {
      name: 'Otra',
      primaryColor: '#16A34A',
    });
    expect(res.name).toBe('Otra');
    expect(actions(auditLog).sort()).toEqual([
      'admin.tenant.branding_color_changed',
      'admin.tenant.renamed',
    ]);
  });

  it('IDEMPOTENTE: repetir lo que ya hay no escribe, no deja audit y no avisa a Stripe', async () => {
    const { controller, prisma, themingUpdate, auditLog, sync } = build();
    await controller.setBranding(machineReq as never, undefined, TENANT, {
      name: 'Academia Original',
      // Es exactamente el color actual del aula, ya normalizado.
      primaryColor: brandToHex(213, 70),
    });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(themingUpdate).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(sync!.request).not.toHaveBeenCalled();
  });

  it('IDEMPOTENTE: devolver el hex que se acaba de leer nunca reescribe el aula (sin deriva por redondeo)', async () => {
    for (let hue = 0; hue < 360; hue += 17) {
      for (let saturation = 0; saturation <= 100; saturation += 13) {
        const { controller, themingUpdate, auditLog } = build({
          theme: { brandHue: hue, brandSaturation: saturation },
        });
        const read = await controller.getBranding(machineReq as never, undefined, TENANT);
        await controller.setBranding(machineReq as never, undefined, TENANT, {
          primaryColor: read.primaryColor!,
        });
        expect(themingUpdate, `${hue},${saturation}`).not.toHaveBeenCalled();
        expect(auditLog.record, `${hue},${saturation}`).not.toHaveBeenCalled();
      }
    }
  });

  it('IDEMPOTENTE tras un cambio: el segundo PUT idéntico ya no escribe nada', async () => {
    const { controller, themingUpdate, auditLog } = build();
    const dto = { name: 'Otra', primaryColor: '#16A34A' };
    await controller.setBranding(machineReq as never, undefined, TENANT, dto);
    const writes = themingUpdate.mock.calls.length + auditLog.record.mock.calls.length;
    await controller.setBranding(machineReq as never, undefined, TENANT, dto);
    expect(themingUpdate.mock.calls.length + auditLog.record.mock.calls.length).toBe(writes);
  });

  it('se valida TODO antes de escribir: sin servicio de theming y con color pedido → 503 y el nombre NO cambia', async () => {
    const { controller, prisma, auditLog, state } = build({}, { registry: false });
    await expect(
      controller.setBranding(machineReq as never, undefined, TENANT, {
        name: 'No debería guardarse',
        primaryColor: '#16A34A',
      }),
    ).rejects.toMatchObject({ response: { code: 'ADMIN_TENANT_BRANDING_UNAVAILABLE' } });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    expect(state.name).toBe('Academia Original');
    // CONTROL: solo el nombre sí se puede aunque no haya servicio de theming.
    await expect(
      controller.setBranding(machineReq as never, undefined, TENANT, { name: 'Sí se guarda' }),
    ).resolves.toMatchObject({ name: 'Sí se guarda' });
  });

  it('sin cobros de plataforma (sin PayoutsBrandingSync) funciona igual', async () => {
    const { controller } = build({}, { sync: false });
    await expect(
      controller.setBranding(machineReq as never, undefined, TENANT, { name: 'Sin Stripe' }),
    ).resolves.toMatchObject({ name: 'Sin Stripe' });
  });

  it('aula inexistente → 404 y no se escribe nada (CONTROL)', async () => {
    const { controller, prisma, themingUpdate, auditLog } = build();
    await expect(
      controller.setBranding(machineReq as never, undefined, OTHER, { name: 'X' }),
    ).rejects.toMatchObject({ response: { code: 'ADMIN_TENANT_NOT_FOUND' } });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(themingUpdate).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('sin credencial → 401; tenant_admin → 403, sin escribir (la puerta es solo del operador)', async () => {
    const { controller, prisma, themingUpdate } = build();
    await expect(
      controller.setBranding(noActorReq as never, undefined, TENANT, { name: 'X' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.setBranding(
        noActorReq as never,
        { sub: 'u', tenantId: TENANT, roles: ['tenant_admin'] } as never,
        TENANT,
        { name: 'X' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(themingUpdate).not.toHaveBeenCalled();
  });

  it('un super_admin (persona) sí puede, y el audit lo marca como persona, no como máquina', async () => {
    const { controller, auditLog } = build();
    await controller.setBranding(
      noActorReq as never,
      { sub: 'root', tenantId: TENANT, roles: ['super_admin'] } as never,
      TENANT,
      { name: 'Por una persona' },
    );
    const entry = auditLog.record.mock.calls[0]![0];
    expect(entry['actorId']).toBe('root');
    expect(entry['metadata']).not.toHaveProperty('actorKind');
  });
});

describe('`rename` (PATCH :id) sigue sin abrirse a la máquina', () => {
  it('con credencial de provisioning y sin sesión → 401: solo la marca renombra', async () => {
    const { controller, prisma } = build();
    await expect(
      controller.rename(machineReq as never, undefined, TENANT, { name: 'Intento' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
