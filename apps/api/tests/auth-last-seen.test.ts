/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `user.lastSeenAt` al renovar el token. Sin esto, quien deja la sesión
 * abierta y entra a diario parecía «sin entrar desde hace semanas» (solo
 * `lastLoginAt`, que cambia al poner la contraseña), y la recuperación y
 * «Miembros en riesgo» le habrían escrito por error.
 */

import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { sessionRegistryStub } from './helpers/session-registry-stub';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  status: 'ACTIVE',
  mfaEnabled: false,
  roles: [{ role: { name: 'alumno' } }],
};

function build(updateMany: (args: unknown) => Promise<{ count: number }>) {
  const tokens = {
    verifyRefresh: async () => ({ sub: USER.id, sid: '00000000-0000-4000-8000-000000000000' }),
    sign: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
  };
  const prisma = { user: { findUnique: async () => USER, updateMany } };
  return new AuthService(
    prisma as never,
    null as never,
    tokens as never,
    null as never,
    null as never,
    sessionRegistryStub(tokens as never),
    null as never,
  );
}

describe('AuthService.refresh · lastSeenAt', () => {
  it('sella lastSeenAt como mucho una vez cada 15 minutos', async () => {
    const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const service = build(async (args) => {
      calls.push(args as (typeof calls)[number]);
      return { count: 1 };
    });
    const before = Date.now();
    const signed = await service.refresh('r');
    expect(signed.accessToken).toBe('a');
    expect(calls).toHaveLength(1);
    const { where, data } = calls[0]!;
    expect(where['id']).toBe(USER.id);
    const or = where['OR'] as Array<Record<string, { lt?: Date } | null>>;
    expect(or[0]).toEqual({ lastSeenAt: null });
    const lt = (or[1]!['lastSeenAt'] as { lt: Date }).lt.getTime();
    expect(before - lt).toBeGreaterThanOrEqual(15 * 60 * 1000 - 50);
    expect(before - lt).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
    expect((data['lastSeenAt'] as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('si no se puede escribir la marca, la renovación sigue', async () => {
    const service = build(async () => {
      throw new Error('BD caída un instante');
    });
    await expect(service.refresh('r')).resolves.toMatchObject({ accessToken: 'a' });
  });
});
