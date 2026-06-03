/**
 * Configuración runtime del módulo de auth.
 * Lee variables de entorno una sola vez al arrancar.
 */
export interface AuthConfig {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  argon2: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  totp: {
    issuer: string;
    window: number;
  };
}

export function loadAuthConfig(): AuthConfig {
  const jwtSecret = process.env['AUTH_SECRET'];
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error(
      'AUTH_SECRET no definido o demasiado corto (mínimo 32 caracteres). Genera uno con `openssl rand -hex 32`.',
    );
  }

  return {
    jwtSecret,
    jwtIssuer: process.env['AUTH_URL'] ?? 'https://didacta.local',
    jwtAccessTtlSeconds: 60 * 60, // 1h
    jwtRefreshTtlSeconds: 60 * 60 * 24 * 30, // 30d
    argon2: {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    },
    totp: {
      issuer: 'Didacta',
      window: 1,
    },
  };
}
