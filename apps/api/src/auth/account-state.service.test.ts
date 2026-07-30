import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStateService } from './account-state.service';

/**
 * Estos tests fijan el comportamiento que faltaba: que una cuenta suspendida
 * deje de operar YA, sin esperar a que caduque su access token.
 *
 * Antes de este arreglo nadie escribía en la tabla `session`, así que suspender
 * a alguien borraba cero filas y el usuario seguía dentro hasta una hora.
 */

const USER = '33333333-3333-3333-3333-333333333333';
const SID = '44444444-4444-4444-4444-444444444444';

function setup(over: { status?: string; deletedAt?: Date | null; sessionExists?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: over.status ?? 'ACTIVE',
        deletedAt: over.deletedAt ?? null,
      }),
    },
    session: {
      findFirst: vi.fn().mockResolvedValue(over.sessionExists === false ? null : { id: SID }),
    },
  };
  return { service: new AccountStateService(prisma as never), prisma };
}

describe('AccountStateService — estado de la cuenta', () => {
  it('deja pasar una cuenta activa', async () => {
    const { service } = setup();
    expect(await service.check(USER, SID)).toBeNull();
  });

  it('corta una cuenta suspendida', async () => {
    const { service } = setup({ status: 'SUSPENDED' });
    const rejection = await service.check(USER, SID);
    expect(rejection?.code).toBe('account_suspended');
  });

  it('corta una cuenta desactivada', async () => {
    const { service } = setup({ status: 'DEACTIVATED' });
    expect((await service.check(USER, SID))?.code).toBe('account_suspended');
  });

  it('corta una cuenta pendiente de aprobación', async () => {
    const { service } = setup({ status: 'PENDING' });
    expect((await service.check(USER, SID))?.code).toBe('account_suspended');
  });

  it('corta una cuenta borrada (soft delete)', async () => {
    const { service } = setup({ deletedAt: new Date() });
    expect((await service.check(USER, SID))?.code).toBe('account_deleted');
  });

  it('corta si el usuario ya no existe', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    expect((await service.check(USER, SID))?.code).toBe('account_deleted');
  });
});

describe('AccountStateService — sesión', () => {
  it('corta si la sesión fue cerrada', async () => {
    const { service } = setup({ sessionExists: false });
    expect((await service.check(USER, SID))?.code).toBe('session_revoked');
  });

  it('la consulta descarta sesiones revocadas y caducadas', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    const where = prisma.session.findFirst.mock.calls[0]![0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    expect(where.userId).toBe(USER);
  });

  it('un token viejo sin sid sigue valiendo mientras la cuenta esté activa', async () => {
    // Compatibilidad de despliegue: los tokens emitidos antes de que existiera
    // el registro de sesiones no llevan `sid`. Si los rechazáramos, el deploy
    // echaría a todo el mundo de golpe.
    const { service, prisma } = setup();
    expect(await service.check(USER, undefined)).toBeNull();
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });

  it('un token viejo sin sid NO salva a una cuenta suspendida', async () => {
    const { service } = setup({ status: 'SUSPENDED' });
    expect((await service.check(USER, undefined))?.code).toBe('account_suspended');
  });

  it('el estado de la cuenta manda sobre el de la sesión', async () => {
    const { service } = setup({ status: 'SUSPENDED', sessionExists: false });
    expect((await service.check(USER, SID))?.code).toBe('account_suspended');
  });
});

describe('AccountStateService — caché', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no consulta dos veces dentro de la ventana', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    await service.check(USER, SID);
    await service.check(USER, SID);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.session.findFirst).toHaveBeenCalledTimes(1);
  });

  it('vuelve a consultar pasados los 30 s', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    vi.advanceTimersByTime(31_000);
    await service.check(USER, SID);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser corta al instante en esta instancia', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    service.invalidateUser(USER);
    prisma.user.findUnique.mockResolvedValue({ status: 'SUSPENDED', deletedAt: null });
    expect((await service.check(USER, SID))?.code).toBe('account_suspended');
  });

  it('invalidateSession corta al instante esa sesión', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    service.invalidateSession(SID);
    prisma.session.findFirst.mockResolvedValue(null);
    expect((await service.check(USER, SID))?.code).toBe('session_revoked');
  });

  it('invalidateAllSessions vacía la caché de sesiones sin tocar la de cuentas', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    service.invalidateAllSessions();
    await service.check(USER, SID);
    expect(prisma.session.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique, 'la cuenta sigue cacheada').toHaveBeenCalledTimes(1);
  });

  it('la caché es por usuario', async () => {
    const { service, prisma } = setup();
    await service.check(USER, SID);
    await service.check('otro-usuario', SID);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
