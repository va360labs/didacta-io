/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La puerta de «Dirección de tu academia»: solo quien administra el aula, y
 * solo en una instancia que la encienda (`TENANT_SUBDOMAIN_SUFFIX`). Lo que
 * pasa dentro (ocupada, límite, alias) lo prueba
 * `integration/academy-address.integration.test.ts` contra Postgres real.
 */

import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcademyAddressController } from '../src/admin/academy-address/academy-address.controller';
import { AcademyAddressService } from '../src/admin/academy-address/academy-address.service';
import type { SessionClaims } from '../src/auth/token.service';

const claims = (roles: string[]): SessionClaims =>
  ({ sub: 'user-1', tenantId: 'tenant-1', roles }) as unknown as SessionClaims;

/** Una base que revienta si se toca: sin la variable nada debe llegar a ella. */
const untouchable = new Proxy(
  {},
  {
    get: (_t, prop) => {
      throw new Error(`no debería tocar la base (${String(prop)})`);
    },
  },
);

const req = { headers: { 'user-agent': 'vitest' }, ip: '10.0.0.1' } as never;

describe('AcademyAddressController', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['TENANT_SUBDOMAIN_SUFFIX'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['TENANT_SUBDOMAIN_SUFFIX'];
    else process.env['TENANT_SUBDOMAIN_SUFFIX'] = saved;
  });

  it('sin sesión: 401; un alumno o un formador: 403 (aunque la función esté encendida)', async () => {
    process.env['TENANT_SUBDOMAIN_SUFFIX'] = 'didacta.io';
    const service = { getState: vi.fn(), checkAvailability: vi.fn(), change: vi.fn() };
    const controller = new AcademyAddressController(service as unknown as AcademyAddressService);

    await expect(controller.get(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    for (const roles of [['student'], ['instructor']]) {
      await expect(controller.get(claims(roles))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.availability(claims(roles), { label: 'otra' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.change(claims(roles), { label: 'otra' }, req)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(service.change).not.toHaveBeenCalled();
  });

  it('el administrador cambia SU aula (la del token), con el rastro de quién y desde dónde', async () => {
    const service = {
      change: vi.fn(async () => ({ previousHostname: 'a.didacta.io', hostname: 'b.didacta.io' })),
    };
    const controller = new AcademyAddressController(service as unknown as AcademyAddressService);
    await controller.change(claims(['tenant_admin']), { label: 'b' }, req);
    expect(service.change).toHaveBeenCalledWith('tenant-1', 'user-1', 'b', {
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
  });

  it('sin TENANT_SUBDOMAIN_SUFFIX: 404 en las tres rutas, sin mirar la base', async () => {
    delete process.env['TENANT_SUBDOMAIN_SUFFIX'];
    const service = new AcademyAddressService(untouchable as never, untouchable as never);
    const controller = new AcademyAddressController(service);
    const admin = claims(['tenant_admin']);
    for (const call of [
      () => controller.get(admin),
      () => controller.availability(admin, { label: 'libre' }),
      () => controller.change(admin, { label: 'libre' }, req),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: 'ACADEMY_ADDRESS_DISABLED',
      });
    }
  });
});
