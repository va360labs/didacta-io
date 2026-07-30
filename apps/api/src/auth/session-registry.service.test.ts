import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken, SessionRegistryService } from './session-registry.service';
import { TokenService } from './token.service';

// `TokenService` firma de verdad, así que necesita un secreto válido. Se firma
// y se verifica en el mismo proceso: el valor concreto da igual, solo la
// longitud mínima.
beforeAll(() => {
  process.env['AUTH_SECRET'] ??= 'secreto_de_pruebas_con_mas_de_32_caracteres';
});

/**
 * El bug que arregla este servicio: la tabla `session` no la escribía nadie.
 * Estos tests fijan que emitir tokens y registrar la sesión son la MISMA
 * operación, para que no vuelvan a separarse.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';

const CLAIMS = { sub: USER, tenantId: TENANT, roles: ['alumno'], mfaVerified: true };

function setup(over: { existingSession?: unknown } = {}) {
  const prisma = {
    session: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(over.existingSession ?? null),
    },
  };
  const tokens = new TokenService();
  const service = new SessionRegistryService(prisma as never, tokens);
  return { service, prisma, tokens };
}

describe('SessionRegistryService.issue', () => {
  it('escribe la fila de sesión al emitir tokens', async () => {
    const { service, prisma } = setup();
    await service.issue(CLAIMS, { ip: '10.0.0.1', userAgent: 'Firefox' });
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    const data = prisma.session.create.mock.calls[0]![0].data;
    expect(data.userId).toBe(USER);
    expect(data.tenantId).toBe(TENANT);
    expect(data.ip).toBe('10.0.0.1');
    expect(data.userAgent).toBe('Firefox');
    expect(data.expiresAt).toBeInstanceOf(Date);
  });

  it('el sid del token coincide con el id de la fila: es lo que permite revocar', async () => {
    const { service, prisma, tokens } = setup();
    const signed = await service.issue(CLAIMS);
    const rowId = prisma.session.create.mock.calls[0]![0].data.id;
    const claims = await tokens.verifyAccess(signed.accessToken);
    expect(claims.sid).toBe(rowId);
  });

  it('el refresh token también lleva el sid, para poder rotar la misma sesión', async () => {
    const { service, prisma, tokens } = setup();
    const signed = await service.issue(CLAIMS);
    const rowId = prisma.session.create.mock.calls[0]![0].data.id;
    const refresh = await tokens.verifyRefresh(signed.refreshToken);
    expect(refresh.sid).toBe(rowId);
  });

  it('guarda el hash del refresh token, nunca el token en claro', async () => {
    const { service, prisma } = setup();
    const signed = await service.issue(CLAIMS);
    const stored = prisma.session.create.mock.calls[0]![0].data.tokenHash;
    expect(stored).toBe(hashToken(signed.refreshToken));
    expect(stored).not.toContain(signed.refreshToken);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dos sesiones del mismo usuario son independientes', async () => {
    const { service, prisma } = setup();
    await service.issue(CLAIMS);
    await service.issue(CLAIMS);
    const [a, b] = prisma.session.create.mock.calls.map((c) => c[0].data.id);
    expect(a).not.toBe(b);
  });
});

describe('SessionRegistryService.rotate', () => {
  it('conserva el sid al refrescar, en vez de acumular sesiones fantasma', async () => {
    const sid = '55555555-5555-5555-5555-555555555555';
    const { service, prisma, tokens } = setup({ existingSession: { id: sid } });
    const signed = await service.rotate(sid, CLAIMS);
    expect(prisma.session.update).toHaveBeenCalledTimes(1);
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect((await tokens.verifyAccess(signed.accessToken)).sid).toBe(sid);
  });

  it('refresca el tokenHash y la caducidad de la fila', async () => {
    const sid = '55555555-5555-5555-5555-555555555555';
    const { service, prisma } = setup({ existingSession: { id: sid } });
    const signed = await service.rotate(sid, CLAIMS);
    const data = prisma.session.update.mock.calls[0]![0].data;
    expect(data.tokenHash).toBe(hashToken(signed.refreshToken));
    expect(data.expiresAt).toBeInstanceOf(Date);
  });

  it('abre sesión nueva si el refresh viene sin sid (token previo al despliegue)', async () => {
    const { service, prisma } = setup();
    await service.rotate(undefined, CLAIMS);
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('abre sesión nueva si la fila ya no existe, en vez de fallar', async () => {
    const { service, prisma } = setup({ existingSession: null });
    await service.rotate('sid-que-ya-no-esta', CLAIMS);
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
  });

  it('solo rota una sesión no revocada y del propio usuario', async () => {
    const sid = '55555555-5555-5555-5555-555555555555';
    const { service, prisma } = setup({ existingSession: { id: sid } });
    await service.rotate(sid, CLAIMS);
    const where = prisma.session.findFirst.mock.calls[0]![0].where;
    expect(where).toEqual({ id: sid, userId: USER, revokedAt: null });
  });
});
