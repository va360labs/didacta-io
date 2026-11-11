import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import type { SessionClaims } from '../src/auth/token.service';
import { BrandingService } from '../src/branding/branding.service';

// Import dinámico de los targets EE (regla ee-fence: un fichero no-EE no puede
// importar un *.ee estáticamente). Se resuelven en beforeAll.
type WhiteLabelControllerCtor =
  typeof import('../src/branding/white-label.controller.ee').WhiteLabelController;
type WhiteLabelServiceCtor =
  typeof import('../src/branding/white-label.service.ee').WhiteLabelService;

let WhiteLabelController: WhiteLabelControllerCtor;
let WhiteLabelService: WhiteLabelServiceCtor;

beforeAll(async () => {
  ({ WhiteLabelController } = await import('../src/branding/white-label.controller.ee'));
  ({ WhiteLabelService } = await import('../src/branding/white-label.service.ee'));
});

/**
 * Auth del controller EE de white-label.
 *
 * Primer hallazgo (inventario de docs): solo llevaba @RequiresCapability — la
 * capability gatea la LICENCIA, no la identidad. En una instalación con
 * licencia EE válida, cualquier request anónima podía leer y reconfigurar el
 * branding. Se cerró con JwtAuthGuard (clase) + rol admin en cada handler.
 *
 * Segundo hallazgo, el que fija este fichero: «rol admin» incluía a
 * `tenant_admin`, y el estado que tocan estos endpoints es GLOBAL — un
 * singleton en memoria (`BrandingService`) que comparten todos los tenants de
 * la instalación. El admin de un tenant le cambiaba la marca a todos los
 * demás. Ahora solo `super_admin`.
 *
 * Se usa el `BrandingService` real y no un doble: lo que hay que demostrar es
 * que el estado compartido NO se mueve, no que un espía no fue llamado.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['alumno'],
    mfaVerified: true,
    ...overrides,
  };
}

let branding: BrandingService;
let controller: InstanceType<WhiteLabelControllerCtor>;

beforeEach(() => {
  branding = new BrandingService();
  controller = new WhiteLabelController(new WhiteLabelService(branding));
});

const CAMBIO = {
  logoUrl: 'https://tenant-b.example.com/logo.png',
  primaryColor: '#ff0000',
  poweredByDidacta: false,
};

describe('WhiteLabelController · auth y rol', () => {
  it('exige JwtAuthGuard a nivel de clase', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, WhiteLabelController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('preview: rechaza sin sesión con 401', () => {
    expect(() => controller.preview(undefined)).toThrow(UnauthorizedException);
  });

  it('configure: rechaza sin sesión con 401 y no cambia el estado', () => {
    const before = branding.getRawState();
    expect(() => controller.configure(undefined, CAMBIO)).toThrow(UnauthorizedException);
    expect(branding.getRawState()).toEqual(before);
  });

  it.each(['alumno', 'formador'] as const)('%s → 403 en preview y en configure', (role) => {
    const user = makeUser({ roles: [role] });
    expect(() => controller.preview(user)).toThrow(ForbiddenException);
    expect(() => controller.configure(user, CAMBIO)).toThrow(ForbiddenException);
  });

  /**
   * El caso del fallo. El estado es global: lo que el admin de UN tenant
   * escribiese aquí lo verían todos los demás en `/branding/options`.
   */
  it('tenant_admin NO puede configurar: 403 y el estado global no se mueve', () => {
    const before = branding.getRawState();
    const beforePublic = branding.getPublicOptions(true);

    let thrown: unknown;
    try {
      controller.configure(makeUser({ roles: ['tenant_admin'], tenantId: 'tenant-B' }), CAMBIO);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toEqual({
      message: 'Esta acción requiere rol super_admin.',
      code: 'ADMIN_FORBIDDEN_SUPER_ADMIN_REQUIRED',
    });
    expect(branding.getRawState()).toEqual(before);
    // Lo que ve cualquier OTRO tenant de la instalación sigue igual.
    expect(branding.getPublicOptions(true)).toEqual(beforePublic);
  });

  it('tenant_admin tampoco lee el estado global (preview → 403)', () => {
    expect(() => controller.preview(makeUser({ roles: ['tenant_admin'] }))).toThrow(
      ForbiddenException,
    );
  });

  it('tener además otros roles no convierte a un tenant_admin en super_admin', () => {
    const user = makeUser({ roles: ['tenant_admin', 'formador', 'alumno'] });
    expect(() => controller.configure(user, CAMBIO)).toThrow(ForbiddenException);
  });

  it('super_admin configura: el cambio se aplica al estado global', () => {
    const result = controller.configure(makeUser({ roles: ['super_admin'] }), CAMBIO);
    expect(result.state).toEqual(CAMBIO);
    expect(branding.getRawState()).toEqual(CAMBIO);
  });

  it('super_admin lee el estado (preview)', () => {
    const p = controller.preview(makeUser({ roles: ['super_admin'] }));
    expect(p.canHideBrand).toBe(true);
    expect(p.state).toEqual(branding.getRawState());
  });
});
