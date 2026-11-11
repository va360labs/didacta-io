import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../src/modules/community/broadcast-unsubscribe';
import { CommunityPublicController } from '../src/modules/community/community-public.controller';

/**
 * Token de baja de los correos de la comunidad: firma HMAC (tenant+user), sin
 * expiración. La verificación debe: aceptar un token válido, rechazar firma
 * manipulada, rechazar basura y ser estable ante el mismo secret.
 *
 * Y se firma SOLO con `AUTH_SECRET`: sin él no hay respaldo, ni a la clave de
 * cifrado de ajustes ni a una cadena fija del código.
 */
describe('broadcast unsubscribe token', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const USER = '22222222-2222-2222-2222-222222222222';

  // Mismo mínimo que exige el arranque de auth (32 caracteres).
  const SECRET = 'test-secret-para-unsubscribe-con-mas-de-32-caracteres';
  /** La cadena que estaba escrita en el código como último respaldo. */
  const CADENA_FIJA_DE_ANTES = 'didacta-dev-secret';

  const savedAuth = process.env['AUTH_SECRET'];
  const savedEnc = process.env['TENANT_SETTINGS_ENC_KEY'];

  beforeEach(() => {
    process.env['AUTH_SECRET'] = SECRET;
  });

  afterEach(() => {
    if (savedAuth === undefined) delete process.env['AUTH_SECRET'];
    else process.env['AUTH_SECRET'] = savedAuth;
    if (savedEnc === undefined) delete process.env['TENANT_SETTINGS_ENC_KEY'];
    else process.env['TENANT_SETTINGS_ENC_KEY'] = savedEnc;
  });

  /** Fabrica un token como lo haría alguien de fuera que conoce el formato. */
  function forge(secret: string, tenantId = TENANT, userId = USER): string {
    const data = Buffer.from(JSON.stringify({ t: tenantId, u: userId }), 'utf8').toString(
      'base64url',
    );
    return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
  }

  it('firma y verifica ida y vuelta', () => {
    const token = signUnsubscribeToken(TENANT, USER);
    expect(verifyUnsubscribeToken(token)).toEqual({ tenantId: TENANT, userId: USER });
  });

  it('rechaza un token con la firma manipulada', () => {
    const token = signUnsubscribeToken(TENANT, USER);
    const data = token.split('.')[0]!;
    expect(verifyUnsubscribeToken(`${data}.firmafalsa`)).toBeNull();
  });

  it('rechaza el payload manipulado (firma no cuadra)', () => {
    const token = signUnsubscribeToken(TENANT, USER);
    const sig = token.split('.')[1]!;
    const otherData = Buffer.from(JSON.stringify({ t: TENANT, u: 'otro-user' }), 'utf8').toString(
      'base64url',
    );
    expect(verifyUnsubscribeToken(`${otherData}.${sig}`)).toBeNull();
  });

  it('rechaza basura y tokens vacíos', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('no-es-un-token')).toBeNull();
    expect(verifyUnsubscribeToken('a.b.c')).toBeNull();
  });

  // Los enlaces ya enviados están firmados con AUTH_SECRET: tienen que seguir valiendo.
  it('acepta un token firmado con HMAC-SHA256 de AUTH_SECRET (enlaces ya enviados)', () => {
    expect(verifyUnsubscribeToken(forge(SECRET))).toEqual({ tenantId: TENANT, userId: USER });
  });

  it('CONTROL: con AUTH_SECRET puesto, la cadena fija de antes nunca valió', () => {
    expect(verifyUnsubscribeToken(forge(CADENA_FIJA_DE_ANTES))).toBeNull();
  });

  describe('sin AUTH_SECRET no hay respaldo', () => {
    it('no firma con la clave de cifrado de ajustes: lanza', () => {
      delete process.env['AUTH_SECRET'];
      process.env['TENANT_SETTINGS_ENC_KEY'] = 'x'.repeat(64);
      expect(() => signUnsubscribeToken(TENANT, USER)).toThrow(/AUTH_SECRET/);
    });

    it('no firma con una cadena fija: lanza', () => {
      delete process.env['AUTH_SECRET'];
      delete process.env['TENANT_SETTINGS_ENC_KEY'];
      expect(() => signUnsubscribeToken(TENANT, USER)).toThrow(/AUTH_SECRET/);
    });

    it('no acepta un token fabricado con la cadena fija de antes', () => {
      delete process.env['AUTH_SECRET'];
      delete process.env['TENANT_SETTINGS_ENC_KEY'];
      // Antes esto devolvía { tenantId, userId }: cualquiera que leyese el
      // código podía dar de baja a quien quisiera.
      expect(() => verifyUnsubscribeToken(forge(CADENA_FIJA_DE_ANTES))).toThrow(/AUTH_SECRET/);
    });

    it('no acepta un token fabricado con la clave de cifrado de ajustes', () => {
      delete process.env['AUTH_SECRET'];
      const encKey = 'x'.repeat(64);
      process.env['TENANT_SETTINGS_ENC_KEY'] = encKey;
      expect(() => verifyUnsubscribeToken(forge(encKey))).toThrow(/AUTH_SECRET/);
    });

    it('un AUTH_SECRET más corto que el mínimo del arranque tampoco firma', () => {
      process.env['AUTH_SECRET'] = 'corto';
      expect(() => signUnsubscribeToken(TENANT, USER)).toThrow(/AUTH_SECRET/);
    });
  });

  describe('endpoint público de baja', () => {
    function makeController() {
      const setCommunityEmailOptOut = vi.fn().mockResolvedValue(undefined);
      const controller = new CommunityPublicController(
        { getCommunityService: () => ({ setCommunityEmailOptOut }) } as never,
        { user: { findUnique: vi.fn().mockResolvedValue({ locale: 'es-ES' }) } } as never,
      );
      const out: { status?: number; body?: string } = {};
      const reply = {
        status(code: number) {
          out.status = code;
          return reply;
        },
        header() {
          return reply;
        },
        send(body: string) {
          out.body = body;
          return reply;
        },
      };
      return { controller, setCommunityEmailOptOut, reply: reply as never, out };
    }
    const req = { headers: {} } as never;

    it('sin AUTH_SECRET, un enlace fabricado con la cadena fija NO da de baja a nadie', async () => {
      delete process.env['AUTH_SECRET'];
      delete process.env['TENANT_SETTINGS_ENC_KEY'];
      const { controller, setCommunityEmailOptOut, reply, out } = makeController();

      await controller.unsubscribe(forge(CADENA_FIJA_DE_ANTES), req, reply);

      expect(setCommunityEmailOptOut).not.toHaveBeenCalled();
      expect(out.status).toBe(500);
      expect(out.body).not.toContain('Te has dado de baja');
    });

    it('con AUTH_SECRET, el mismo enlace fabricado es un 400 y tampoco da de baja', async () => {
      const { controller, setCommunityEmailOptOut, reply, out } = makeController();

      await controller.unsubscribeOneClick(forge(CADENA_FIJA_DE_ANTES), req, reply);

      expect(setCommunityEmailOptOut).not.toHaveBeenCalled();
      expect(out.status).toBe(400);
    });
  });
});
