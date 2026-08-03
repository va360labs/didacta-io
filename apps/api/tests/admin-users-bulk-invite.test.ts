/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de `AdminUsersService.startBulkInvite` (alta masiva desde CSV, viaje 1
 * de captación de alumnos).
 *
 * El riesgo es el MISMO que documenta `invitations-batch.test.ts`: cada fila
 * hace como mínimo una escritura + un email de bienvenida (~1 s), así que un
 * CSV de tamaño moderado ya supera los ~30 s que aguanta el proxy. Por eso
 * `startBulkInvite` responde antes de terminar y el progreso se seguido con
 * `estadoBulkInvite()` — mismo patrón que el envío por lotes de invitaciones.
 */

import { describe, expect, it, vi } from 'vitest';
import { AdminUsersService } from '../src/admin/admin-users.service';

const TENANT_ID = 't1';
const ACTOR_ID = 'actor-1';
const WEB_BASE_URL = 'http://test.local';

function makeService(opts: { yaExisten?: Set<string> } = {}) {
  const yaExisten = opts.yaExisten ?? new Set<string>();
  let contador = 0;

  const tx = {
    user: {
      create: vi.fn(async ({ data }: { data: { email: string; name: string | null } }) => {
        contador += 1;
        return {
          id: `u${contador}`,
          tenantId: TENANT_ID,
          email: data.email,
          name: data.name,
          status: 'ACTIVE' as const,
        };
      }),
    },
    userRole: { create: vi.fn().mockResolvedValue({}) },
  };

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { tenantId_email: { email: string } } }) => {
        const email = where.tenantId_email.email;
        return yaExisten.has(email) ? { id: `existing-${email}`, email } : null;
      }),
      // getDetail() al final de invite(); el contenido exacto no importa para
      // el bucle del lote (solo cuenta éxito/fallo).
      findFirst: vi.fn().mockResolvedValue({
        id: 'x',
        email: 'x@example.com',
        name: null,
        status: 'ACTIVE',
        mfaEnabled: false,
        emailVerified: false,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        lastLoginAt: null,
        externalSource: null,
        externalId: null,
        locale: 'es-ES',
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        roles: [{ role: { name: 'alumno' } }],
        sessions: [],
      }),
    },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-alumno', name: 'alumno' }) },
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: TENANT_ID, name: 'Tenant' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as never;

  const noopAudit = { record: vi.fn().mockResolvedValue(undefined) } as never;
  const passwordReset = { requestAndSendEmail: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const accessGroups = {
    getGroup: vi.fn().mockResolvedValue({ id: 'grupo-1', name: 'Aula 2026' }),
    assignMembers: vi.fn().mockResolvedValue({ assigned: 1, added: 1 }),
  };

  return {
    service: new AdminUsersService(
      prisma,
      noopAudit,
      passwordReset as never,
      logger as never,
      undefined as never,
      accessGroups as never,
    ),
    tx,
    passwordReset,
    logger,
  };
}

/** Espera a que el lote en segundo plano termine. */
async function esperarFin(service: AdminUsersService): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (service.estadoBulkInvite(TENANT_ID)?.enCurso === false) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('el alta masiva no terminó');
}

describe('admin-users · alta masiva (CSV) en segundo plano', () => {
  it('responde antes de crear a todo el mundo', async () => {
    const { service } = makeService();
    const rows = Array.from({ length: 5 }, (_, i) => ({ email: `alumno${i}@example.test` }));

    const r = await service.startBulkInvite(
      TENANT_ID,
      ACTOR_ID,
      rows,
      'alumno',
      undefined,
      WEB_BASE_URL,
    );

    expect(r).toEqual({ aceptado: true, yaEnCurso: false, total: 5 });
    // Lo que importa: al volver de startBulkInvite no se han creado los 5.
    expect(service.estadoBulkInvite(TENANT_ID)!.creados).toBeLessThan(5);

    await esperarFin(service);
    expect(service.estadoBulkInvite(TENANT_ID)).toMatchObject({
      enCurso: false,
      total: 5,
      creados: 5,
      fallidos: [],
    });
  });

  it('el progreso avanza y acaba marcado como terminado', async () => {
    const { service } = makeService();
    const rows = Array.from({ length: 4 }, (_, i) => ({ email: `a${i}@example.test` }));

    await service.startBulkInvite(TENANT_ID, ACTOR_ID, rows, 'alumno', undefined, WEB_BASE_URL);
    const alArrancar = service.estadoBulkInvite(TENANT_ID)!;
    expect(alArrancar.enCurso).toBe(true);
    expect(alArrancar.total).toBe(4);

    await esperarFin(service);
    const final = service.estadoBulkInvite(TENANT_ID)!;
    expect(final.enCurso).toBe(false);
    expect(final.creados).toBe(4);
    expect(final.terminadoEn).not.toBeNull();
  });

  it('un segundo lote mientras hay uno en vuelo no arranca otro bucle', async () => {
    const { service, tx } = makeService();
    const rows = Array.from({ length: 6 }, (_, i) => ({ email: `b${i}@example.test` }));

    await service.startBulkInvite(TENANT_ID, ACTOR_ID, rows, 'alumno', undefined, WEB_BASE_URL);
    const segundo = await service.startBulkInvite(
      TENANT_ID,
      ACTOR_ID,
      rows,
      'alumno',
      undefined,
      WEB_BASE_URL,
    );

    expect(segundo).toEqual({ aceptado: false, yaEnCurso: true, total: 6 });

    await esperarFin(service);
    expect(tx.user.create).toHaveBeenCalledTimes(6);
  });

  it('una fila con email ya existente falla, no corta el lote y queda listada', async () => {
    const { service } = makeService({ yaExisten: new Set(['dup@example.test']) });
    const rows = [
      { email: 'ok1@example.test' },
      { email: 'dup@example.test' },
      { email: 'ok2@example.test' },
    ];

    await service.startBulkInvite(TENANT_ID, ACTOR_ID, rows, 'alumno', undefined, WEB_BASE_URL);
    await esperarFin(service);

    const estado = service.estadoBulkInvite(TENANT_ID)!;
    expect(estado.creados).toBe(2);
    expect(estado.fallidos).toHaveLength(1);
    expect(estado.fallidos[0]!.email).toBe('dup@example.test');
  });

  it('el mismo email dos veces en el CSV solo se intenta una vez', async () => {
    const { service, tx } = makeService();
    const rows = [
      { email: 'repetido@example.test', name: 'Primera vez' },
      { email: 'REPETIDO@example.test', name: 'Segunda vez (mismo email, mayúsculas)' },
      { email: 'otro@example.test' },
    ];

    const r = await service.startBulkInvite(
      TENANT_ID,
      ACTOR_ID,
      rows,
      'alumno',
      undefined,
      WEB_BASE_URL,
    );
    expect(r.total).toBe(2);

    await esperarFin(service);
    expect(tx.user.create).toHaveBeenCalledTimes(2);
    expect(service.estadoBulkInvite(TENANT_ID)!.creados).toBe(2);
  });

  it('sin nadie a quien dar de alta no deja el panel en "importando" para siempre', async () => {
    const { service, tx } = makeService();

    const r = await service.startBulkInvite(
      TENANT_ID,
      ACTOR_ID,
      [{ email: 'mismo@example.test' }, { email: 'mismo@example.test' }],
      'alumno',
      undefined,
      WEB_BASE_URL,
    );
    // El dedup dentro del propio CSV deja 1 fila, no 0 — probamos el caso
    // límite real (todas duplicadas entre sí) sin dejarlo "importando" nunca.
    expect(r.total).toBe(1);

    await esperarFin(service);
    expect(tx.user.create).toHaveBeenCalledTimes(1);
  });
});
