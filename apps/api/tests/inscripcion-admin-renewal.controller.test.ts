import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InscripcionAdminController } from '../src/inscripcion/inscripcion-admin.controller';

/**
 * Tests del recordatorio de pago desde el panel de solicitudes de inscripción:
 * GET .../renewal-context y POST .../renewal-email. Reusa el motor de email del
 * dashboard (resolución de enlace vía el service del módulo + SMTP del tenant).
 */

const TENANT = 'tenant-a';
const ADMIN = { sub: 'admin-1', tenantId: TENANT, roles: ['tenant_admin'] };
const NON_ADMIN = { sub: 'user-2', tenantId: TENANT, roles: ['student'] };
const USER_ID = 'req-user-1';

const MATCH = {
  provider: 'stripe',
  connectionId: 'conn_1',
  connectionName: 'Stripe ES',
  planName: 'Plan Pro',
  status: 'past_due',
  unitAmount: 1999,
  currency: 'eur',
  subscriptionId: 'sub_1',
};

function build(overrides?: {
  getUserEmail?: unknown;
  getForUser?: unknown;
  resolveRenewalUrlByRef?: unknown;
  getRenewalTemplate?: unknown;
  resolve?: unknown;
  send?: unknown;
}) {
  const registration = {
    getUserEmail: vi.fn(overrides?.getUserEmail ?? (async () => 'aspirante@x.com')),
  };
  const lookup = {
    getForUser: vi.fn(overrides?.getForUser ?? (async () => ({ results: [MATCH] }))),
  };
  const paymentSvc = {
    resolveRenewalUrlByRef: vi.fn(
      overrides?.resolveRenewalUrlByRef ?? (async () => 'https://invoice.stripe.com/i/sub_1'),
    ),
    getRenewalTemplate: vi.fn(
      overrides?.getRenewalTemplate ??
        (async () => ({ subject: 'Renueva {plan}', body: 'Paga aquí: {enlace}' })),
    ),
  };
  const registry = { getPaymentConnectionsService: () => paymentSvc };
  const smtpResolver = {
    resolve: vi.fn(overrides?.resolve ?? (async () => ({ config: { host: 'smtp.x' } }))),
  };
  const smtp = { send: vi.fn(overrides?.send ?? (async () => ({ ok: true }))) };
  const controller = new InscripcionAdminController(
    registration as never,
    lookup as never,
    {} as never,
    registry as never,
    smtp as never,
    smtpResolver as never,
  );
  return { controller, registration, lookup, paymentSvc, smtpResolver, smtp };
}

describe('InscripcionAdminController · renewal-context', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('sin usuario → 401', async () => {
    await expect(h.controller.renewalContext(undefined, USER_ID, 'sub_1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rol no admin → 403', async () => {
    await expect(
      h.controller.renewalContext(NON_ADMIN as never, USER_ID, 'sub_1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin subscriptionId → 400', async () => {
    await expect(
      h.controller.renewalContext(ADMIN as never, USER_ID, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subscriptionId que no está en el lookup → 404', async () => {
    await expect(
      h.controller.renewalContext(ADMIN as never, USER_ID, 'sub_ajena'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('happy path: resuelve enlace por la referencia del match + plantilla del tenant', async () => {
    const res = await h.controller.renewalContext(ADMIN as never, USER_ID, 'sub_1');
    expect(res).toEqual({
      template: { subject: 'Renueva {plan}', body: 'Paga aquí: {enlace}' },
      renewalUrl: 'https://invoice.stripe.com/i/sub_1',
    });
    expect(h.paymentSvc.resolveRenewalUrlByRef).toHaveBeenCalledWith(
      TENANT,
      'conn_1',
      'stripe',
      'sub_1',
    );
  });

  it('match antiguo sin connectionId → renewalUrl null y no llama al resolver', async () => {
    const { connectionId, ...legacy } = MATCH;
    void connectionId;
    h = build({ getForUser: async () => ({ results: [legacy] }) });
    const res = await h.controller.renewalContext(ADMIN as never, USER_ID, 'sub_1');
    expect(res.renewalUrl).toBeNull();
    expect(h.paymentSvc.resolveRenewalUrlByRef).not.toHaveBeenCalled();
  });
});

describe('InscripcionAdminController · renewal-email', () => {
  const DTO = { subject: 'Renueva tu plan', body: 'Paga aquí: https://invoice.stripe.com/i/sub_1' };

  it('rol no admin → 403', async () => {
    const h = build();
    await expect(
      h.controller.sendRenewalEmail(NON_ADMIN as never, USER_ID, DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('solicitante sin email → 404', async () => {
    const h = build({ getUserEmail: async () => null });
    await expect(
      h.controller.sendRenewalEmail(ADMIN as never, USER_ID, DTO),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('tenant sin SMTP → 409', async () => {
    const h = build({ resolve: async () => null });
    await expect(
      h.controller.sendRenewalEmail(ADMIN as never, USER_ID, DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('fallo SMTP al enviar → 409', async () => {
    const h = build({ send: async () => ({ ok: false, error: 'connection refused' }) });
    await expect(
      h.controller.sendRenewalEmail(ADMIN as never, USER_ID, DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('happy path: envía al email del solicitante con HTML y devuelve { ok, to }', async () => {
    const h = build();
    const res = await h.controller.sendRenewalEmail(ADMIN as never, USER_ID, DTO);
    expect(res).toEqual({ ok: true, to: 'aspirante@x.com' });
    expect(h.smtp.send).toHaveBeenCalledTimes(1);
    const [, message] = h.smtp.send.mock.calls[0] as [unknown, Record<string, string>];
    expect(message.to).toBe('aspirante@x.com');
    expect(message.subject).toBe(DTO.subject);
    expect(message.text).toBe(DTO.body);
    // El cuerpo se envuelve en HTML y los enlaces se vuelven <a>.
    expect(message.html).toContain('<a href="https://invoice.stripe.com/i/sub_1">');
  });
});
