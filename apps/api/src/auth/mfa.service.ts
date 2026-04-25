import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { loadAuthConfig } from './auth.config';

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

@Injectable()
export class MfaService {
  private readonly config = loadAuthConfig();

  constructor() {
    authenticator.options = {
      window: this.config.totp.window,
    };
  }

  /**
   * Genera un nuevo secreto + 10 recovery codes para que el usuario configure
   * su app de TOTP. El secret se persiste cifrado en `user.mfa_secret` solo
   * tras la primera verificación correcta (`enable`).
   */
  async generateSetup(email: string): Promise<MfaSetup> {
    const secret = authenticator.generateSecret(20);
    const otpauthUrl = authenticator.keyuri(email, this.config.totp.issuer, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M' });
    const recoveryCodes = Array.from({ length: 10 }, () => this.randomRecoveryCode());

    return { secret, otpauthUrl, qrCodeDataUrl, recoveryCodes };
  }

  verifyCode(secret: string, code: string): boolean {
    const sanitized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(sanitized)) return false;
    return authenticator.verify({ token: sanitized, secret });
  }

  /** Devuelve true si el código coincide y un nuevo array sin él (one-time use). */
  consumeRecoveryCode(
    storedCodes: readonly string[],
    candidate: string,
  ): { valid: boolean; remaining: string[] } {
    const sanitized = candidate.replace(/\s+/g, '').toUpperCase();
    const idx = storedCodes.findIndex((c) => c.toUpperCase() === sanitized);
    if (idx === -1) return { valid: false, remaining: [...storedCodes] };
    return {
      valid: true,
      remaining: storedCodes.filter((_, i) => i !== idx),
    };
  }

  private randomRecoveryCode(): string {
    return randomBytes(5).toString('hex').toUpperCase();
  }
}
