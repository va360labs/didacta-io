import { describe, expect, it, vi } from 'vitest';
import { InvitationsService } from '../src/admin/invitations.service';

/**
 * El envío por lotes NO puede bloquear la petición HTTP.
 *
 * Regresión que cubre (prod, 2026-07-30): "Enviar a 150" devolvía "No se pudo
 * enviar el lote" y un 500 en consola. El lote se enviaba ENTERO — el bucle
 * seguía en segundo plano — pero cada correo tarda ~1 s y el proxy corta a los
 * 30 s, así que el panel daba por fallido un envío que había funcionado. En una
 * campaña con un solo disparo por destinatario, informar mal es peor que no
 * informar: invita a reintentar a ciegas.
 */

const TENANT = 'tenant-1';
const ACTOR = 'admin-1';

function hacerServicio(opts: { destinatarios: number; fallaEn?: Set<number> }) {
  const usuarios = Array.from({ length: opts.destinatarios }, (_, i) => ({
    id: `u${i}`,
    email: `alumno${i}@example.test`,
  }));

  const prisma = {
    user: { findMany: vi.fn(async () => usuarios) },
    $queryRawUnsafe: vi.fn(async () => usuarios),
  };

  let enviados = 0;
  const adminUsers = {
    resendInvite: vi.fn(async () => {
      const indice = enviados++;
      if (opts.fallaEn?.has(indice)) throw new Error('SMTP caído');
    }),
  };

  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const service = new InvitationsService(prisma as never, adminUsers as never, logger as never);
  return { service, adminUsers, logger };
}

/** Espera a que el envío en segundo plano termine (sin pausa entre correos). */
async function esperarFin(service: InvitationsService): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (service.estadoEnvio(TENANT)?.enCurso === false) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('el envío no terminó');
}

describe('invitaciones · envío por lotes en segundo plano', () => {
  it('responde antes de mandar los correos', async () => {
    const { service, adminUsers } = hacerServicio({ destinatarios: 5 });

    const r = await service.startBatch(TENANT, ACTOR, 'https://aula.test', {} as never, {
      size: 5,
      pauseMs: 5,
    });

    expect(r).toEqual({ aceptado: true, yaEnCurso: false, total: 5 });
    // Lo que importa: al volver de startBatch NO se han mandado los 5.
    expect(adminUsers.resendInvite.mock.calls.length).toBeLessThan(5);

    await esperarFin(service);
    expect(adminUsers.resendInvite).toHaveBeenCalledTimes(5);
  });

  it('el progreso avanza y acaba marcado como terminado', async () => {
    const { service } = hacerServicio({ destinatarios: 4 });

    await service.startBatch(TENANT, ACTOR, 'https://aula.test', {} as never, {
      size: 4,
      pauseMs: 5,
    });
    // Recién arrancado: en curso y todavía sin terminar el lote (el primer
    // correo puede haber salido ya en el mismo tick, eso da igual).
    const alArrancar = service.estadoEnvio(TENANT)!;
    expect(alArrancar.enCurso).toBe(true);
    expect(alArrancar.total).toBe(4);
    expect(alArrancar.enviados).toBeLessThan(4);

    await esperarFin(service);
    expect(service.estadoEnvio(TENANT)).toMatchObject({
      enCurso: false,
      total: 4,
      enviados: 4,
      fallidos: [],
    });
    expect(service.estadoEnvio(TENANT)?.terminadoEn).not.toBeNull();
  });

  it('un segundo lote mientras hay uno en vuelo no arranca otro bucle', async () => {
    const { service, adminUsers } = hacerServicio({ destinatarios: 6 });

    await service.startBatch(TENANT, ACTOR, 'https://aula.test', {} as never, {
      size: 6,
      pauseMs: 10,
    });
    const segundo = await service.startBatch(TENANT, ACTOR, 'https://aula.test', {} as never, {
      size: 6,
      pauseMs: 10,
    });

    // Sin este freno, dos bucles seleccionarían los mismos pendientes en la
    // ventana entre el SELECT y la creación del token: correo duplicado.
    expect(segundo).toEqual({ aceptado: false, yaEnCurso: true, total: 6 });

    await esperarFin(service);
    expect(adminUsers.resendInvite).toHaveBeenCalledTimes(6);
  });

  it('un correo que falla no corta el lote y queda listado', async () => {
    const { service, adminUsers } = hacerServicio({
      destinatarios: 4,
      fallaEn: new Set([1]),
    });

    await service.startBatch(TENANT, ACTOR, 'https://aula.test', {} as never, {
      size: 4,
      pauseMs: 5,
    });
    await esperarFin(service);

    expect(adminUsers.resendInvite).toHaveBeenCalledTimes(4);
    const estado = service.estadoEnvio(TENANT)!;
    expect(estado.enviados).toBe(3);
    expect(estado.fallidos).toEqual([{ email: 'alumno1@example.test', error: 'SMTP caído' }]);
  });

  it('sin nadie a quien invitar no deja el panel en "enviando" para siempre', async () => {
    const { service, adminUsers } = hacerServicio({ destinatarios: 0 });

    const r = await service.startBatch(TENANT, ACTOR, 'https://aula.test', {} as never, {
      size: 25,
    });

    expect(r).toEqual({ aceptado: true, yaEnCurso: false, total: 0 });
    expect(adminUsers.resendInvite).not.toHaveBeenCalled();
    expect(service.estadoEnvio(TENANT)).toMatchObject({ enCurso: false, total: 0 });
  });
});
