import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MfaService } from '../src/auth/mfa.service';

const ORIGINAL = process.env['AUTH_SECRET'];

beforeAll(() => {
  process.env['AUTH_SECRET'] = 'a'.repeat(64);
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = ORIGINAL;
});

describe('MfaService', () => {
  it('genera secret + otpauth url + qr + 10 recovery codes únicos', async () => {
    const service = new MfaService();
    const setup = await service.generateSetup('test@learnship.test');

    expect(setup.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    expect(setup.otpauthUrl).toContain('LearnShip');
    expect(setup.otpauthUrl).toContain(encodeURIComponent('test@learnship.test'));
    expect(setup.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.recoveryCodes).toHaveLength(10);
    expect(new Set(setup.recoveryCodes).size).toBe(10);
    setup.recoveryCodes.forEach((c) => expect(c).toMatch(/^[0-9A-F]{10}$/));
  });

  it('verifyCode acepta el código TOTP del secret generado', async () => {
    const service = new MfaService();
    const setup = await service.generateSetup('a@b.c');
    const code = authenticator.generate(setup.secret);
    expect(service.verifyCode(setup.secret, code)).toBe(true);
  });

  it('verifyCode rechaza código de longitud incorrecta', async () => {
    const service = new MfaService();
    const setup = await service.generateSetup('a@b.c');
    expect(service.verifyCode(setup.secret, '12345')).toBe(false);
    expect(service.verifyCode(setup.secret, 'abcdef')).toBe(false);
  });

  it('verifyCode tolera espacios en el código', async () => {
    const service = new MfaService();
    const setup = await service.generateSetup('a@b.c');
    const code = authenticator.generate(setup.secret);
    const padded = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(service.verifyCode(setup.secret, padded)).toBe(true);
  });

  it('consumeRecoveryCode marca como válido y devuelve restantes sin él', () => {
    const service = new MfaService();
    const codes = ['ABCDEF1234', 'FEDCBA0987', 'ZZZZZZZZZZ'];
    const result = service.consumeRecoveryCode(codes, 'fedcba0987');
    expect(result.valid).toBe(true);
    expect(result.remaining).toEqual(['ABCDEF1234', 'ZZZZZZZZZZ']);
  });

  it('consumeRecoveryCode con código inválido no muta', () => {
    const service = new MfaService();
    const codes = ['ABCDEF1234'];
    const result = service.consumeRecoveryCode(codes, 'WRONG12345');
    expect(result.valid).toBe(false);
    expect(result.remaining).toEqual(codes);
  });
});
