/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

/**
 * Cifrado simétrico AES-256-GCM para las API keys de providers IA.
 *
 * Clave maestra del cluster en `AI_CONFIG_ENCRYPTION_KEY` (hex 64 chars =
 * 32 bytes = 256 bits). Se carga al boot y se mantiene en memoria.
 *
 * Cada cifrado genera IV aleatorio (96 bits) + auth tag (128 bits) que se
 * persisten junto al ciphertext. Sin todos los tres no se puede descifrar.
 *
 * Diseño:
 *   - 1 sola clave del cluster (no per-tenant) para simplicidad operativa.
 *     Si en el futuro se necesita per-tenant, KMS o HSM externo.
 *   - Rotación de la clave: requiere re-cifrar todas las filas. No
 *     implementado todavía; cuando se necesite, script de migración.
 */
@Injectable()
export class ApiKeyCipher implements OnModuleInit {
  private masterKey: Buffer | null = null;

  constructor(private readonly logger: Logger) {}

  onModuleInit() {
    const hex = process.env.AI_CONFIG_ENCRYPTION_KEY;
    if (!hex) {
      this.logger.warn(
        'AI_CONFIG_ENCRYPTION_KEY no configurada. La gestión de configs IA por tenant fallará.',
      );
      return;
    }
    if (hex.length !== 64) {
      throw new Error('AI_CONFIG_ENCRYPTION_KEY debe ser hex de 64 chars (32 bytes / 256 bits).');
    }
    this.masterKey = Buffer.from(hex, 'hex');
    this.logger.log('ApiKeyCipher listo');
  }

  encrypt(plaintext: string): { cipher: string; iv: string; tag: string } {
    this.assertReady();
    const iv = randomBytes(12); // 96 bits para GCM
    const cipher = createCipheriv('aes-256-gcm', this.masterKey!, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      cipher: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  decrypt(payload: { cipher: string; iv: string; tag: string }): string {
    this.assertReady();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.masterKey!,
      Buffer.from(payload.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.cipher, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  isReady(): boolean {
    return this.masterKey !== null;
  }

  private assertReady() {
    if (!this.masterKey) {
      throw new Error('AI_CONFIG_ENCRYPTION_KEY no configurada — imposible cifrar/descifrar.');
    }
  }
}
