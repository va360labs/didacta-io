/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del gate `feat:white_label` aplicado a `PUT /modules/theming/me`
 * (MIG-026 follow-up). El controller exige la capability sólo cuando el dto
 * incluye `customCss` o `footerHtml`. El resto de campos del theme quedan
 * libres en plan community.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LicenseService, CapabilityRequiredError } from '@didacta/license-sdk';
import { ThemingController } from '../src/modules/theming.controller';

type FakeRegistryCtor = ConstructorParameters<typeof ThemingController>[0];

function makeRegistry(updateSpy: ReturnType<typeof vi.fn>): FakeRegistryCtor {
  return {
    getThemingService: () => ({
      update: updateSpy,
    }),
    // Resto de métodos de ModuleRegistryService no se usan en estos tests.
  } as unknown as FakeRegistryCtor;
}

const adminUser = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roles: ['tenant_admin'],
  email: 'admin@tenant.test',
} as Parameters<ThemingController['updateMine']>[0];

describe('ThemingController · gate feat:white_label en PUT /me (MIG-026 follow-up)', () => {
  let license: LicenseService;
  let updateSpy: ReturnType<typeof vi.fn>;
  let controller: ThemingController;

  beforeEach(() => {
    license = new LicenseService();
    updateSpy = vi.fn().mockResolvedValue({ tenantId: 'tenant-1' });
    controller = new ThemingController(makeRegistry(updateSpy), license);
  });

  describe('community (sin licencia)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('actualiza colores / fuentes sin exigir licencia', async () => {
      const dto = { primaryColor: '#ff0000' } as Parameters<ThemingController['updateMine']>[1];
      await expect(controller.updateMine(adminUser, dto)).resolves.toBeDefined();
      expect(updateSpy).toHaveBeenCalledWith('tenant-1', dto);
    });

    it('rechaza con CapabilityRequiredError si dto incluye customCss', async () => {
      const dto = { customCss: 'body { color: red }' } as Parameters<
        ThemingController['updateMine']
      >[1];
      await expect(controller.updateMine(adminUser, dto)).rejects.toThrow(CapabilityRequiredError);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('rechaza si dto incluye footerHtml', async () => {
      const dto = { footerHtml: '<p>powered by acme</p>' } as Parameters<
        ThemingController['updateMine']
      >[1];
      await expect(controller.updateMine(adminUser, dto)).rejects.toThrow(CapabilityRequiredError);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('PERMITE customCss=null sin licencia (no es "usar" white-label, es no-usarlo/limpiarlo)', async () => {
      // El front SIEMPRE envía customCss/footerHtml (con null si están vacíos).
      // Tratar null como "toca white-label" rebotaba el guardado entero con 402.
      const dto = { customCss: null } as Parameters<ThemingController['updateMine']>[1];
      await expect(controller.updateMine(adminUser, dto)).resolves.toBeDefined();
      expect(updateSpy).toHaveBeenCalledWith('tenant-1', dto);
    });

    it('PERMITE customCss="" (string vacío) sin licencia', async () => {
      const dto = { customCss: '' } as Parameters<ThemingController['updateMine']>[1];
      await expect(controller.updateMine(adminUser, dto)).resolves.toBeDefined();
    });

    it('PERMITE el payload real del front (logo + color + customCss/footerHtml null) sin licencia', async () => {
      // Reproduce exactamente lo que manda handleSave en /admin/branding: este
      // era el caso que tras el fix de type=text afloraba como 402 espurio y
      // tiraba el guardado de logo + colores en Community.
      const dto = {
        brandHue: 200,
        brandSaturation: 60,
        logoUrl: '/api/v1/modules/theming/tenants/tenant-1/logo?v=1',
        faviconUrl: null,
        customCss: null,
        footerHtml: null,
      } as Parameters<ThemingController['updateMine']>[1];
      await expect(controller.updateMine(adminUser, dto)).resolves.toBeDefined();
      expect(updateSpy).toHaveBeenCalledWith('tenant-1', dto);
    });
  });

  describe('con dev bypass (capability activa)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('permite customCss y footerHtml', async () => {
      const dto = {
        customCss: 'body { color: red }',
        footerHtml: '<p>acme</p>',
      } as Parameters<ThemingController['updateMine']>[1];
      await expect(controller.updateMine(adminUser, dto)).resolves.toBeDefined();
      expect(updateSpy).toHaveBeenCalledWith('tenant-1', dto);
    });
  });
});
