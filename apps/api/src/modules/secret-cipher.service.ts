/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;

export interface CipherPayload {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Cifrado simétrico de credenciales de tenant en reposo.
 *
 * Usa AES-256-GCM con IV aleatorio de 96 bits y auth tag de 128 bits.
 * Cada llamada a encrypt() produce un ciphertext distinto incluso para el mismo
 * plaintext, gracias al IV aleatorio. La integridad la garantiza GCM: si alguien
 * altera ciphertext, IV o tag, decrypt() lanza al verificar el tag.
 *
 * La clave llega del env (`TENANT_SETTINGS_ENC_KEY`, 32 bytes hex). Si se rota,
 * todos los settings cifrados quedan ilegibles hasta re-cifrar — backup.
 */
@Injectable()
export class SecretCipherService {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!keyHex) {
      throw new Error('TENANT_SETTINGS_ENC_KEY es obligatoria');
    }
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
      throw new Error(
        'TENANT_SETTINGS_ENC_KEY debe ser 32 bytes en hex (64 caracteres). Generala con: openssl rand -hex 32',
      );
    }
    this.key = Buffer.from(keyHex, 'hex');
    if (this.key.length !== KEY_LENGTH) {
      throw new Error(`TENANT_SETTINGS_ENC_KEY debe decodificar a ${KEY_LENGTH} bytes`);
    }
  }

  encrypt(plaintext: string): CipherPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { cipher: enc, iv, tag };
  }

  decrypt(payload: CipherPayload): string {
    if (payload.iv.length !== IV_LENGTH) {
      throw new Error(`IV inválido (esperado ${IV_LENGTH} bytes, recibido ${payload.iv.length})`);
    }
    if (payload.tag.length !== TAG_LENGTH) {
      throw new Error(
        `Auth tag inválido (esperado ${TAG_LENGTH} bytes, recibido ${payload.tag.length})`,
      );
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, payload.iv);
    decipher.setAuthTag(payload.tag);
    const dec = Buffer.concat([decipher.update(payload.cipher), decipher.final()]);
    return dec.toString('utf8');
  }
}
