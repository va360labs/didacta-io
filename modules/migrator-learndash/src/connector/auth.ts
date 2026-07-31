/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Estrategia de autenticación tipada para el connector REST.
 * Para LearnDash usamos Application Passwords (basic auth sobre HTTPS).
 * NUNCA loguear el header Authorization ni el password.
 */
export interface AuthStrategy {
  readonly kind: 'basic' | 'bearer' | 'api-key';
  headers(): Record<string, string>;
}

export class ApplicationPasswordAuth implements AuthStrategy {
  readonly kind = 'basic' as const;

  constructor(
    private readonly username: string,
    private readonly appPassword: string,
  ) {
    if (!username) throw new Error('username vacío');
    if (!appPassword) throw new Error('appPassword vacío');
  }

  headers(): Record<string, string> {
    const token = Buffer.from(`${this.username}:${this.appPassword}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
}

export class BearerAuth implements AuthStrategy {
  readonly kind = 'bearer' as const;
  constructor(private readonly token: string) {
    if (!token) throw new Error('token vacío');
  }
  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }
}
