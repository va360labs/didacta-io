import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { loadAuthConfig } from './auth.config';

export interface SessionClaims {
  sub: string; // user id
  tenantId: string;
  roles: string[];
  mfaVerified: boolean;
  /**
   * Id de la fila `session` que respalda este token.
   *
   * Es lo que permite revocar un acceso ya emitido: sin él, un access token
   * firmado sigue siendo válido hasta que expira, pase lo que pase con la
   * cuenta. `AccountStateService` lo comprueba en cada petición.
   *
   * Opcional a propósito: los tokens emitidos ANTES de este cambio no lo
   * llevan, y deben seguir funcionando hasta que caduquen. Para ellos se
   * valida el estado del usuario, pero no la sesión concreta.
   */
  sid?: string;
}

export interface SignedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Claims mínimos de un ticket de stream SSE. El stream `/me/notifications/stream`
 * no puede mandar el access token por header `Authorization` (EventSource no
 * permite custom headers), así que el cliente primero pide un ticket de vida
 * corta vía `POST /me/notifications/stream-ticket` (autenticado con Bearer) y
 * lo pasa como query param `?ticket=...` al abrir el EventSource.
 */
export interface StreamTicketClaims {
  sub: string;
  tenantId: string;
}

/** TTL del ticket SSE — corto a propósito: solo cubre el handshake del stream. */
const STREAM_TICKET_TTL_SECONDS = 60;
const STREAM_TICKET_AUDIENCE = 'didacta-sse';

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
      ...(claims.sid ? { sid: claims.sid } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.config.jwtIssuer)
      .setAudience('didacta-api')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.config.jwtAccessTtlSeconds)
      .sign(this.secret);

    const refresh = await new SignJWT({
      tenantId: claims.tenantId,
      kind: 'refresh',
      ...(claims.sid ? { sid: claims.sid } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.config.jwtIssuer)
      .setAudience('didacta-api')
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
      audience: 'didacta-api',
    });
    if (payload['kind'] !== 'access') {
      throw new Error('Token no es de tipo access');
    }
    const sid = payload['sid'];
    return {
      sub: String(payload.sub),
      tenantId: String(payload['tenantId']),
      roles: (payload['roles'] as string[] | undefined) ?? [],
      mfaVerified: Boolean(payload['mfaVerified']),
      ...(typeof sid === 'string' ? { sid } : {}),
    };
  }

  async verifyRefresh(token: string): Promise<{ sub: string; tenantId: string; sid?: string }> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.config.jwtIssuer,
      audience: 'didacta-api',
    });
    if (payload['kind'] !== 'refresh') {
      throw new Error('Token no es de tipo refresh');
    }
    const sid = payload['sid'];
    return {
      sub: String(payload.sub),
      tenantId: String(payload['tenantId']),
      ...(typeof sid === 'string' ? { sid } : {}),
    };
  }

  /**
   * Firma un ticket de stream SSE (HS256, mismo secreto que el access token
   * pero `kind:'sse'` y `audience:'didacta-sse'` para que NO sea aceptado por
   * `verifyAccess` ni viceversa). TTL corto (60s): solo debe sobrevivir el
   * tiempo entre que el cliente lo pide y abre el EventSource.
   */
  async signStreamTicket(claims: StreamTicketClaims): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({
      tenantId: claims.tenantId,
      kind: 'sse',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.config.jwtIssuer)
      .setAudience(STREAM_TICKET_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + STREAM_TICKET_TTL_SECONDS)
      .sign(this.secret);
  }

  /** Verifica un ticket SSE. Lanza si firma/expiración/audience/kind no cuadran. */
  async verifyStreamTicket(token: string): Promise<StreamTicketClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.config.jwtIssuer,
      audience: STREAM_TICKET_AUDIENCE,
    });
    if (payload['kind'] !== 'sse') {
      throw new Error('Token no es de tipo sse');
    }
    return {
      sub: String(payload.sub),
      tenantId: String(payload['tenantId']),
    };
  }
}
