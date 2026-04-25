import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { loadAuthConfig } from './auth.config';

export interface SessionClaims {
  sub: string; // user id
  tenantId: string;
  roles: string[];
  mfaVerified: boolean;
}

export interface SignedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class TokenService {
  private readonly config = loadAuthConfig();
  private readonly secret = new TextEncoder().encode(this.config.jwtSecret);

  async sign(claims: SessionClaims): Promise<SignedTokens> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const access = await new SignJWT({
      tenantId: claims.tenantId,
      roles: claims.roles,
      mfaVerified: claims.mfaVerified,
      kind: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.config.jwtIssuer)
      .setAudience('learnship-api')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.config.jwtAccessTtlSeconds)
      .sign(this.secret);

    const refresh = await new SignJWT({
      tenantId: claims.tenantId,
      kind: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.config.jwtIssuer)
      .setAudience('learnship-api')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.config.jwtRefreshTtlSeconds)
      .sign(this.secret);

    return {
      accessToken: access,
      refreshToken: refresh,
      expiresIn: this.config.jwtAccessTtlSeconds,
    };
  }

  async verifyAccess(token: string): Promise<SessionClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.config.jwtIssuer,
      audience: 'learnship-api',
    });
    if (payload['kind'] !== 'access') {
      throw new Error('Token no es de tipo access');
    }
    return {
      sub: String(payload.sub),
      tenantId: String(payload['tenantId']),
      roles: (payload['roles'] as string[] | undefined) ?? [],
      mfaVerified: Boolean(payload['mfaVerified']),
    };
  }

  async verifyRefresh(token: string): Promise<{ sub: string; tenantId: string }> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.config.jwtIssuer,
      audience: 'learnship-api',
    });
    if (payload['kind'] !== 'refresh') {
      throw new Error('Token no es de tipo refresh');
    }
    return {
      sub: String(payload.sub),
      tenantId: String(payload['tenantId']),
    };
  }
}
