import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretCipherService } from '../src/modules/secret-cipher.service';

const VALID_KEY = randomBytes(32).toString('hex');

describe('SecretCipherService', () => {
  describe('constructor', () => {
    it('rechaza key vacía', () => {
      expect(() => new SecretCipherService('')).toThrow(/TENANT_SETTINGS_ENC_KEY/);
    });

    it('rechaza key con caracteres no hex', () => {
      expect(() => new SecretCipherService('zzzz' + 'a'.repeat(60))).toThrow(/32 bytes en hex/);
    });

    it('rechaza key de longitud incorrecta', () => {
      expect(() => new SecretCipherService('abcd1234')).toThrow(/32 bytes en hex/);
    });

    it('acepta 32 bytes hex válidos', () => {
      expect(() => new SecretCipherService(VALID_KEY)).not.toThrow();
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('round-trip preserva el plaintext', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const plain = 'hola mundo, contraseña super secreta 🔐';
      const payload = cipher.encrypt(plain);
      const back = cipher.decrypt(payload);
      expect(back).toBe(plain);
    });

    it('round-trip funciona con strings vacíos', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const payload = cipher.encrypt('');
      expect(cipher.decrypt(payload)).toBe('');
    });

    it('round-trip funciona con JSON serializado', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const obj = { host: 'smtp.brevo.com', port: 587, user: 'foo', pass: 'bar!@#$' };
      const payload = cipher.encrypt(JSON.stringify(obj));
      expect(JSON.parse(cipher.decrypt(payload))).toEqual(obj);
    });

    it('IV es aleatorio: dos encrypts del mismo plaintext dan ciphertexts distintos', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const a = cipher.encrypt('mismo texto');
      const b = cipher.encrypt('mismo texto');
      expect(a.iv).not.toEqual(b.iv);
      expect(a.cipher).not.toEqual(b.cipher);
      // Pero ambos descifran al mismo plaintext
      expect(cipher.decrypt(a)).toBe(cipher.decrypt(b));
    });
  });

  describe('integridad (auth tag)', () => {
    it('detecta tampering en el ciphertext', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const payload = cipher.encrypt('importante');
      const tampered = { ...payload, cipher: Buffer.from(payload.cipher) };
      tampered.cipher[0] = tampered.cipher[0]! ^ 0xff;
      expect(() => cipher.decrypt(tampered)).toThrow();
    });

    it('detecta tampering en el auth tag', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const payload = cipher.encrypt('importante');
      const tampered = { ...payload, tag: Buffer.from(payload.tag) };
      tampered.tag[0] = tampered.tag[0]! ^ 0xff;
      expect(() => cipher.decrypt(tampered)).toThrow();
    });

    it('detecta tampering en el IV', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      const payload = cipher.encrypt('importante');
      const tampered = { ...payload, iv: Buffer.from(payload.iv) };
      tampered.iv[0] = tampered.iv[0]! ^ 0xff;
      expect(() => cipher.decrypt(tampered)).toThrow();
    });

    it('rechaza payload con IV de longitud incorrecta', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      expect(() =>
        cipher.decrypt({ cipher: Buffer.from('x'), iv: Buffer.alloc(8), tag: Buffer.alloc(16) }),
      ).toThrow(/IV/);
    });

    it('rechaza payload con tag de longitud incorrecta', () => {
      const cipher = new SecretCipherService(VALID_KEY);
      expect(() =>
        cipher.decrypt({ cipher: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(8) }),
      ).toThrow(/tag/);
    });
  });

  describe('aislamiento por key', () => {
    it('una key distinta no puede descifrar lo de la primera', () => {
      const cipherA = new SecretCipherService(VALID_KEY);
      const cipherB = new SecretCipherService(randomBytes(32).toString('hex'));
      const payload = cipherA.encrypt('algo privado');
      expect(() => cipherB.decrypt(payload)).toThrow();
    });
  });
});
