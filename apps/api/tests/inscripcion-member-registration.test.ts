/**
 * Tests de `MemberRegistrationService.createPending` (flujo de inscripción de
 * miembros: tras superar el gate Telegram + OTP se crea un User PENDING).
 *
 * Cubre:
 *  - Usuario nuevo: crea User PENDING con telegramId/telegramInGroup + rol alumno,
 *    devuelve {created:true}, emite tokens de decisión y notifica al aprobador.
 *  - Email ya existente: devuelve {created:false} sin recrear ni notificar.
 *  - Carrera P2002 en el create: recupera el existente y devuelve {created:false}.
 *  - Audit log 'member.inscription.created' tras crear.
 *  - Email al aprobador con destinatario MEMBER_APPROVAL_EMAIL (smtp mockeado).
 *
 * NOTA: el lookup de suscripción + la notificación al aprobador corren en SEGUNDO
 * PLANO (no bloquean la respuesta al usuario), así que los asserts del envío del
 * email usan `vi.waitFor` para esperar a que el background se complete.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { MemberRegistrationService } from '../src/inscripcion/member-registration.service';
import type { MemberRegistrationInput } from '../src/inscripcion/member-registration.service';
import type { ClientContext } from '../src/auth/client-context';

const TENANT_ID = 'tenant-1';
const WEB_BASE_URL = 'http://test.local';
const CTX: ClientContext = { ip: '1.2.3.4', userAgent: 'vitest' };

const BASE_INPUT: MemberRegistrationInput = {
  name: 'Ana López',
  email: 'ana@x.com',
  password: 'contraseña-super-segura',
  bio: 'Hola soy Ana',
  telegramId: '99887766',
  inGroup: 'true',
};

/**
 * Monta el harness con fake-prisma in-memory + mocks. `existingUser` simula que
 * el findUnique inicial encuentra (o no) una inscripción previa. `throwP2002`
 * fuerza que el create de la transacción choque en el índice único.
 */
function makeHarness(
  opts: {
    existingUser?: { id: string; status: string } | null;
    throwP2002?: boolean;
    roleMissing?: boolean;
  } = {},
) {
  const txUser = {
    create: vi.fn().mockResolvedValue({ id: 'new-user' }),
  };
  const txUserRole = { create: vi.fn().mockResolvedValue({}) };
  const tx = { user: txUser, userRole: txUserRole };

  // findUnique se llama 2 veces como mucho: (1) idempotencia inicial,
  // (2) recuperación tras P2002. La primera devuelve existingUser; la segunda,
  // en el camino P2002, devuelve el usuario que "ganó" la carrera.
  const userFindUnique = vi.fn();
  userFindUnique.mockResolvedValueOnce(opts.existingUser ?? null);
  if (opts.throwP2002) {
    userFindUnique.mockResolvedValueOnce({ id: 'race-user' });
  }

  const prisma = {
    user: { findUnique: userFindUnique },
    role: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.roleMissing ? null : { id: 'role-alumno', name: 'alumno' }),
    },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Academia Demo' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => {
      if (opts.throwP2002) {
        throw new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: '5.0.0',
        });
      }
      return fn(tx);
    }),
  } as never;

  const passwords = {
    // Mock del hash: nunca usar argon2 real en tests.
    hash: vi.fn(async (plain: string) => `hashed:${plain}`),
  } as never;

  const decision = {
    issueDecisionTokens: vi
      .fn()
      .mockResolvedValue({ approveToken: 'raw-approve', rejectToken: 'raw-reject' }),
  } as never;

  const paymentFlags = {
    lookup: vi.fn().mockResolvedValue({ isDelinquent: false, name: null }),
  } as never;

  // El lookup de suscripción corre en background; por defecto no encuentra nada.
  const subscriptionLookup = {
    runAndStore: vi.fn().mockResolvedValue({ matches: [], failures: [] }),
  } as never;

  const smtp = { send: vi.fn().mockResolvedValue({ ok: true }) };
  const smtpResolver = {
    resolve: vi.fn().mockResolvedValue({ config: {}, source: 'global', verified: true }),
  } as never;
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const service = new MemberRegistrationService(
    prisma,
    passwords,
    decision,
    paymentFlags,
    subscriptionLookup,
    smtp as never,
    smtpResolver,
    auditLog as never,
    logger,
  );

  return {
    service,
    prisma,
    passwords,
    decision,
    paymentFlags,
    subscriptionLookup,
    smtp,
    smtpResolver,
    auditLog,
    logger,
    txUser,
    txUserRole,
  };
}

describe('MemberRegistrationService.createPending', () => {
  beforeEach(() => {
    process.env['MEMBER_APPROVAL_EMAIL'] = 'aprobador@example.com';
  });
  afterEach(() => {
    delete process.env['MEMBER_APPROVAL_EMAIL'];
  });

  it('usuario nuevo: crea User PENDING con telegramId/telegramInGroup, rol alumno y devuelve created:true', async () => {
    const h = makeHarness({ existingUser: null });

    const result = await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    expect(result).toEqual({ userId: 'new-user', created: true, status: 'PENDING' });

    // El create persiste status PENDING + telegramId + telegramInGroup (true → boolean true).
    const createArg = h.txUser.create.mock.calls[0][0].data;
    expect(createArg.status).toBe('PENDING');
    expect(createArg.telegramId).toBe('99887766');
    expect(createArg.telegramInGroup).toBe(true);
    expect(createArg.passwordHash).toBe('hashed:contraseña-super-segura');
    expect(createArg.bio).toBe('Hola soy Ana');
    // Rol alumno asignado.
    expect(h.txUserRole.create).toHaveBeenCalledTimes(1);
  });

  it('tras crear emite tokens de decisión y notifica al aprobador con MEMBER_APPROVAL_EMAIL', async () => {
    const h = makeHarness({ existingUser: null });

    await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    // La notificación al aprobador corre en SEGUNDO PLANO (tras el lookup de
    // suscripción), así que esperamos a que el envío del email se complete.
    await vi.waitFor(() => {
      expect(h.smtp.send).toHaveBeenCalledTimes(1);
    });

    // El lookup de suscripción se disparó (con el email del solicitante).
    expect(h.subscriptionLookup.runAndStore).toHaveBeenCalledWith(
      'tenant-1',
      'new-user',
      'ana@x.com',
    );

    // issueDecisionTokens se llamó con (tenant, userId nuevo, ctx).
    expect(h.decision.issueDecisionTokens).toHaveBeenCalledTimes(1);
    expect(h.decision.issueDecisionTokens).toHaveBeenCalledWith('tenant-1', 'new-user', CTX);

    // Email enviado al aprobador (destinatario del env).
    const [, message] = h.smtp.send.mock.calls[0];
    expect(message.to).toBe('aprobador@example.com');
    // Los enlaces firmados van embebidos en el cuerpo.
    expect(message.text).toContain('raw-approve');
    expect(message.text).toContain('raw-reject');
  });

  it('registra audit log member.inscription.created tras crear', async () => {
    const h = makeHarness({ existingUser: null });

    await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    expect(h.auditLog.record).toHaveBeenCalledTimes(1);
    const entry = h.auditLog.record.mock.calls[0][0];
    expect(entry.action).toBe('member.inscription.created');
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.actorId).toBe('new-user');
    expect(entry.resourceId).toBe('new-user');
    expect(entry.metadata).toMatchObject({ telegramId: '99887766', inGroup: 'true' });
  });

  it('email ya existente: devuelve created:false sin recrear, sin emitir tokens ni email', async () => {
    const h = makeHarness({ existingUser: { id: 'user-existente', status: 'PENDING' } });

    const result = await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    expect(result).toEqual({ userId: 'user-existente', created: false, status: 'PENDING' });
    expect(h.txUser.create).not.toHaveBeenCalled();
    expect(h.decision.issueDecisionTokens).not.toHaveBeenCalled();
    expect(h.smtp.send).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });

  it('carrera P2002 en el create: recupera el existente y devuelve created:false', async () => {
    const h = makeHarness({ existingUser: null, throwP2002: true });

    const result = await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    expect(result).toEqual({ userId: 'race-user', created: false, status: 'PENDING' });
    // Al haberse tratado como "ya existe", no se emite token ni email ni audit.
    expect(h.decision.issueDecisionTokens).not.toHaveBeenCalled();
    expect(h.smtp.send).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });

  it('rol "alumno" inexistente: crea el usuario igualmente (sin rol) y devuelve created:true', async () => {
    const h = makeHarness({ existingUser: null, roleMissing: true });

    const result = await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    expect(result.created).toBe(true);
    expect(h.txUser.create).toHaveBeenCalledTimes(1);
    // Sin rol, no se intenta crear el UserRole.
    expect(h.txUserRole.create).not.toHaveBeenCalled();
  });

  it('best-effort: si MEMBER_APPROVAL_EMAIL falta, NO envía email pero la inscripción sobrevive', async () => {
    delete process.env['MEMBER_APPROVAL_EMAIL'];
    const h = makeHarness({ existingUser: null });

    const result = await h.service.createPending(TENANT_ID, BASE_INPUT, WEB_BASE_URL, CTX);

    expect(result.created).toBe(true);
    // La notificación corre en background y debe abortar al faltar el aprobador
    // (loguea un warn). Esperamos a ese warn y confirmamos que NO se envió email.
    await vi.waitFor(() => {
      expect(h.logger.warn).toHaveBeenCalled();
    });
    expect(h.smtp.send).not.toHaveBeenCalled();
  });
});
