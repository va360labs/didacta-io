import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { loadAuthConfig } from './auth.config';

@Injectable()
export class PasswordService {
  private readonly config = loadAuthConfig();

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: this.config.argon2.memoryCost,
      timeCost: this.config.argon2.timeCost,
      parallelism: this.config.argon2.parallelism,
    });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
