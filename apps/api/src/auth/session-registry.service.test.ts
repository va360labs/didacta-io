import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken, SessionRegistryService, SessionRevokedError } from './session-registry.service';
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
  const SID = '55555555-5555-5555-5555-555555555555';

  /** Sesión viva cuyo tokenHash corresponde al refresh token que se presenta. */
  function sesionViva(refreshToken: string) {
    return { id: SID, tokenHash: hashToken(refreshToken) };
  }

  it('conserva el sid al refrescar, en vez de acumular sesiones fantasma', async () => {
    const { service: emisor } = setup();
    const previo = await emisor.issue(CLAIMS);
    const { service, prisma, tokens } = setup({
      existingSession: sesionViva(previo.refreshToken),
    });
    const signed = await service.rotate(SID, CLAIMS, previo.refreshToken);
    expect(prisma.session.update).toHaveBeenCalledTimes(1);
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect((await tokens.verifyAccess(signed.accessToken)).sid).toBe(SID);
  });

  it('refresca el tokenHash y la caducidad de la fila', async () => {
    const { service: emisor } = setup();
    const previo = await emisor.issue(CLAIMS);
    const { service, prisma } = setup({ existingSession: sesionViva(previo.refreshToken) });
    const signed = await service.rotate(SID, CLAIMS, previo.refreshToken);
    const data = prisma.session.update.mock.calls[0]![0].data;
    expect(data.tokenHash).toBe(hashToken(signed.refreshToken));
    expect(data.expiresAt).toBeInstanceOf(Date);
  });

  it('abre sesión nueva si el refresh viene sin sid (token previo al despliegue)', async () => {
    const { service, prisma } = setup();
    await service.rotate(undefined, CLAIMS, 'lo-que-sea');
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('cerrar sesión CIERRA la sesión: si la fila ya no está, el refresh no resucita nada (H8)', async () => {
    // Este test decía antes lo contrario ("abre sesión nueva si la fila ya no
    // existe, en vez de fallar") y por eso el agujero pasó los tests durante
    // meses: pulsar "cerrar sesión" borraba la fila y el refresh token, válido
    // 30 días, seguía acuñando tokens frescos.
    const { service, prisma } = setup({ existingSession: null });
    await expect(
      service.rotate(SID, CLAIMS, 'refresh-de-la-sesion-cerrada'),
    ).rejects.toBeInstanceOf(SessionRevokedError);
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('un refresh token ya rotado deja de servir aunque la sesión siga viva (H8)', async () => {
    const { service: emisor } = setup();
    const viejo = await emisor.issue(CLAIMS);
    const nuevo = await emisor.issue(CLAIMS);
    // La fila guarda el hash del ÚLTIMO emitido; se presenta el anterior.
    const { service, prisma } = setup({ existingSession: sesionViva(nuevo.refreshToken) });

    await expect(service.rotate(SID, CLAIMS, viejo.refreshToken)).rejects.toBeInstanceOf(
      SessionRevokedError,
    );
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('solo rota una sesión no revocada y del propio usuario', async () => {
    const { service: emisor } = setup();
    const previo = await emisor.issue(CLAIMS);
    const { service, prisma } = setup({ existingSession: sesionViva(previo.refreshToken) });
    await service.rotate(SID, CLAIMS, previo.refreshToken);
    const where = prisma.session.findFirst.mock.calls[0]![0].where;
    expect(where).toEqual({ id: SID, userId: USER, revokedAt: null });
  });
});
