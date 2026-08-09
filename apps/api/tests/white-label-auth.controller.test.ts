import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '../src/auth/token.service';

// Import dinámico de los targets EE (regla ee-fence: un fichero no-EE no puede
// importar un *.ee estáticamente). Se resuelven en beforeAll.
type WhiteLabelControllerCtor =
  typeof import('../src/branding/white-label.controller.ee').WhiteLabelController;
type WhiteLabelServiceCtor =
  typeof import('../src/branding/white-label.service.ee').WhiteLabelService;

let WhiteLabelController: WhiteLabelControllerCtor;

beforeAll(async () => {
  ({ WhiteLabelController } = await import('../src/branding/white-label.controller.ee'));
});

/**
 * Auth del controller EE de white-label (hallazgo del inventario de docs):
 * solo llevaba @RequiresCapability — la capability gatea la LICENCIA, no la
 * identidad. En una instalación con licencia EE válida, cualquier request
 * anónima podía leer y reconfigurar el branding. Ahora JwtAuthGuard (clase)
 * + rol admin en cada handler.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['alumno'],
    email: 'a@example.com',
    mfaVerified: true,
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeController() {
  const service = {
    preview: vi.fn(() => ({ canHideBrand: true })),
    configure: vi.fn(() => ({ applied: true })),
  };
  return {
    controller: new WhiteLabelController(service as unknown as InstanceType<WhiteLabelServiceCtor>),
    spies: service,
  };
}

describe('WhiteLabelController · auth y rol admin', () => {
  it('preview: rechaza sin sesión con 401', () => {
    const { controller } = makeController();
    expect(() => controller.preview(undefined)).toThrow(UnauthorizedException);
  });

  it('configure: rechaza sin sesión con 401', () => {
    const { controller } = makeController();
    expect(() => controller.configure(undefined, {} as never)).toThrow(UnauthorizedException);
  });

  it('preview: rechaza alumno con 403', () => {
    const { controller } = makeController();
    expect(() => controller.preview(makeUser())).toThrow(ForbiddenException);
  });

  it('configure: rechaza formador con 403 (solo admins)', () => {
    const { controller } = makeController();
    expect(() => controller.configure(makeUser({ roles: ['formador'] }), {} as never)).toThrow(
      ForbiddenException,
    );
  });

  it.each(['tenant_admin', 'super_admin'] as const)('%s puede configurar', (role) => {
    const { controller, spies } = makeController();
    controller.configure(makeUser({ roles: [role] }), { hideBrand: true } as never);
    expect(spies.configure).toHaveBeenCalledWith({ hideBrand: true });
  });
});
