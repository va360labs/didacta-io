import { beforeEach, describe, expect, it } from 'vitest';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../src/modules/community/broadcast-unsubscribe';

/**
 * Token de baja de avisos masivos: firma HMAC (tenant+user), sin expiración. La
 * verificación debe: aceptar un token válido, rechazar firma manipulada, rechazar
 * basura y ser estable ante el mismo secret.
 */
describe('broadcast unsubscribe token', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const USER = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    process.env['AUTH_SECRET'] = 'test-secret-para-unsubscribe';
  });

  it('firma y verifica ida y vuelta', () => {
    const token = signUnsubscribeToken(TENANT, USER);
    expect(verifyUnsubscribeToken(token)).toEqual({ tenantId: TENANT, userId: USER });
  });

  it('rechaza un token con la firma manipulada', () => {
    const token = signUnsubscribeToken(TENANT, USER);
    const [data] = token.split('.');
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
});
