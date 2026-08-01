/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests de `AdminUsersService.invite`: el flag `options.sendInvite` (alpha.81) y
 * el estado con el que nace la cuenta.
 *
 * Contexto de `sendInvite`: el migrador (ctx.didacta.users.upsertByExternalRef
 * con `suppressInvite: true`) crea miles de users importados de un LMS de origen
 * y NO debe bombardearlos con emails de activación durante la migración. Para
 * eso `invite()` acepta `options.sendInvite` (default `true`):
 *  - `sendInvite: false` → crea el user + asigna rol + audit, pero NO dispara
 *    `passwordReset.requestAndSendEmail`.
 *  - default (ausente) o `true` → comportamiento de siempre: envía el email.
 *    Es lo que usa el endpoint admin manual (un admin invitando a mano).
 *
 * Contexto del status: la cuenta nace ACTIVE. No puede entrar igualmente hasta
 * definir contraseña (`signin` exige `passwordHash`), pero ya no necesita que un
 * admin la "reactive" a mano después de que su dueño estrene el enlace.
 *
 * Contexto de `accessGroupId` (F5 viaje 1): invitar CON aula. El grupo se
 * valida ANTES de crear el user (un id inválido no debe dejar un alta a
 * medias) y el alta en el grupo tras crear es fail-soft (si el fan-out de
 * matrículas falla, el user queda creado y el operador reintenta desde el
 * panel de grupos).
 */

import { describe, expect, it, vi } from 'vitest';
import { AdminUsersService } from '../src/admin/admin-users.service';

const TENANT_ID = 't1';
const ACTOR_ID = 'actor-1';
const WEB_BASE_URL = 'http://test.local';

function makeService() {
  // user.findUnique → null (no existe), create → fila nueva.
  const createdUser = {
    id: 'new-user',
    tenantId: TENANT_ID,
    email: 'nuevo@example.com',
    name: 'Nuevo',
    status: 'ACTIVE' as const,
  };

  const tx = {
    user: { create: vi.fn().mockResolvedValue(createdUser) },
    userRole: { create: vi.fn().mockResolvedValue({}) },
  };

  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      // getDetail() al final de invite()
      findFirst: vi.fn().mockResolvedValue({
        id: 'new-user',
        email: 'nuevo@example.com',
        name: 'Nuevo',
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
  const passwordReset = {
    requestAndSendEmail: vi.fn().mockResolvedValue(undefined),
  };
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
      undefined as never, // accountState: no participa en invite()
      accessGroups as never,
    ),
    passwordReset,
    tx,
    logger,
    accessGroups,
  };
}

describe('AdminUsersService.invite — flag sendInvite (alpha.81)', () => {
  it('default (sin options): envía el email de bienvenida — comportamiento del admin manual', async () => {
    const { service, passwordReset } = makeService();

    await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', name: 'Nuevo', role: 'alumno' },
      WEB_BASE_URL,
    );

    expect(passwordReset.requestAndSendEmail).toHaveBeenCalledTimes(1);
  });

  it('la cuenta nace ACTIVE — nadie tiene que activarla a mano después', async () => {
    const { service, tx } = makeService();

    const detail = await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', name: 'Nuevo', role: 'alumno' },
      WEB_BASE_URL,
    );

    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(detail.status).toBe('ACTIVE');
  });

  it('sendInvite: true explícito → envía el email', async () => {
    const { service, passwordReset } = makeService();

    await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', name: 'Nuevo', role: 'alumno' },
      WEB_BASE_URL,
      undefined,
      { sendInvite: true },
    );

    expect(passwordReset.requestAndSendEmail).toHaveBeenCalledTimes(1);
  });

  it('sendInvite: false (path migrador) → NO envía email, pero crea el user igual', async () => {
    const { service, passwordReset } = makeService();

    const detail = await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', name: 'Nuevo', role: 'alumno' },
      WEB_BASE_URL,
      undefined,
      { sendInvite: false },
    );

    expect(passwordReset.requestAndSendEmail).not.toHaveBeenCalled();
    // El user igual queda creado y utilizable; solo le falta el email, que el
    // operador manda después con resend-invite.
    expect(detail.status).toBe('ACTIVE');
    expect(detail.email).toBe('nuevo@example.com');
  });
});

describe('AdminUsersService.invite — accessGroupId (F5 viaje 1)', () => {
  it('sin accessGroupId no toca el módulo de grupos', async () => {
    const { service, accessGroups } = makeService();

    await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', role: 'alumno' },
      WEB_BASE_URL,
    );

    expect(accessGroups.getGroup).not.toHaveBeenCalled();
    expect(accessGroups.assignMembers).not.toHaveBeenCalled();
  });

  it('con accessGroupId válido: valida el grupo y añade al user recién creado', async () => {
    const { service, accessGroups } = makeService();

    await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', role: 'alumno', accessGroupId: 'grupo-1' },
      WEB_BASE_URL,
    );

    expect(accessGroups.getGroup).toHaveBeenCalledWith(TENANT_ID, 'grupo-1');
    expect(accessGroups.assignMembers).toHaveBeenCalledWith(TENANT_ID, 'grupo-1', ['new-user']);
  });

  it('grupo inexistente: aborta ANTES de crear el user (nada a medias)', async () => {
    const { service, accessGroups, tx } = makeService();
    accessGroups.getGroup.mockRejectedValue(new Error('Grupo de acceso no encontrado'));

    await expect(
      service.invite(
        TENANT_ID,
        ACTOR_ID,
        { email: 'nuevo@example.com', role: 'alumno', accessGroupId: 'no-existe' },
        WEB_BASE_URL,
      ),
    ).rejects.toThrow('Grupo de acceso no encontrado');

    expect(tx.user.create).not.toHaveBeenCalled();
    expect(accessGroups.assignMembers).not.toHaveBeenCalled();
  });

  it('fallo al añadir al grupo: fail-soft — el user queda creado y se registra warn', async () => {
    const { service, accessGroups, logger } = makeService();
    accessGroups.assignMembers.mockRejectedValue(new Error('fan-out roto'));

    const detail = await service.invite(
      TENANT_ID,
      ACTOR_ID,
      { email: 'nuevo@example.com', role: 'alumno', accessGroupId: 'grupo-1' },
      WEB_BASE_URL,
    );

    expect(detail.email).toBe('nuevo@example.com');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
