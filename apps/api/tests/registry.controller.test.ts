import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RegistryController } from '../src/registry/registry.controller';
import type { RegistryService } from '../src/registry/registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Guard de /admin/registry/* (hallazgo del inventario de docs): el controller
 * llevaba un TODO y CERO auth — cualquier request anónima podía hacer opt-in,
 * opt-out o leer el estado del registro de la instalación. Ahora exige
 * JwtAuthGuard (a nivel de clase) + super_admin (decisión de instancia).
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['tenant_admin'],
    email: 'a@example.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeController() {
  const service = {
    getStatus: vi.fn(async () => ({ optedIn: false })),
    optIn: vi.fn(async () => ({ optedIn: true })),
    optOut: vi.fn(async () => ({ optedIn: false })),
  };
  return {
    controller: new RegistryController(service as unknown as RegistryService),
    spies: service,
  };
}

describe('RegistryController · guard super_admin', () => {
  // async para que el throw síncrono del guard llegue como promesa rechazada
  const CALLS: Array<
    [string, (c: RegistryController, u: SessionClaims | undefined) => Promise<unknown>]
  > = [
    ['status', async (c, u) => c.status(u)],
    ['optIn', async (c, u) => c.optIn(u, { acceptTerms: true } as never)],
    ['optOut', async (c, u) => c.optOut(u)],
  ];

  it.each(CALLS)('%s: rechaza sin sesión con 401', async (_name, call) => {
    const { controller } = makeController();
    await expect(call(controller, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(CALLS)('%s: rechaza tenant_admin con 403 (decisión de instancia)', async (_n, call) => {
    const { controller } = makeController();
    await expect(call(controller, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('super_admin puede consultar y opt-in', async () => {
    const { controller, spies } = makeController();
    const admin = makeUser({ roles: ['super_admin'] });
    await controller.status(admin);
    await controller.optIn(admin, { acceptTerms: true } as never);
    await controller.optOut(admin);
    expect(spies.getStatus).toHaveBeenCalled();
    expect(spies.optIn).toHaveBeenCalled();
    expect(spies.optOut).toHaveBeenCalled();
  });
});
