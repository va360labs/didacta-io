import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberRegistrationAdminController } from '../src/modules/member-registration/member-registration-admin.controller';

/**
 * Tests del recordatorio de pago desde el panel de solicitudes de inscripción:
 * GET .../renewal-context y POST .../renewal-email. Reusa el motor de email del
 * dashboard (resolución de enlace vía el service del módulo + SMTP del tenant).
 */

const TENANT = 'tenant-a';
const ADMIN = { sub: 'admin-1', tenantId: TENANT, roles: ['tenant_admin'] };
const NON_ADMIN = { sub: 'user-2', tenantId: TENANT, roles: ['student'] };
// UUID válido: los endpoints con :userId validan el formato antes de tocar
// Prisma (un id malformado es 404, nunca el 500 del cast P2023).
const USER_ID = '0b7a2f66-4a1e-4f0e-9a3d-0d0c1b2a3c4d';

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

/// Implementación de doble. Los overrides eran `unknown`, que `vi.fn()` no
/// acepta: el typecheck lo destapa en cuanto entra en cobertura.
type FakeImpl = (...args: any[]) => any;

function build(overrides?: {
  getUserEmail?: FakeImpl;
  getForUser?: FakeImpl;
  runAndStore?: FakeImpl;
  resolveRenewalUrlByRef?: FakeImpl;
  getRenewalTemplate?: FakeImpl;
  resolve?: FakeImpl;
  send?: FakeImpl;
}) {
  const registration = {
    getUserEmail: vi.fn(overrides?.getUserEmail ?? (async () => 'aspirante@x.com')),
  };
  const lookup = {
    getForUser: vi.fn(overrides?.getForUser ?? (async () => ({ results: [MATCH] }))),
    runAndStore: vi.fn(overrides?.runAndStore ?? (async () => ({ matches: [], failures: [] }))),
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
  const prisma = {
    tenant: { findUnique: vi.fn(async () => ({ name: 'Academia X' })) },
    modThemingTenantTheme: {
      findUnique: vi.fn(async () => ({ logoUrl: null, brandHue: 213, brandSaturation: 70 })),
    },
  };
  const controller = new MemberRegistrationAdminController(
    registration as never,
    lookup as never,
    {} as never,
    registry as never,
    smtp as never,
    smtpResolver as never,
    prisma as never,
    {} as never,
  );
  return { controller, registration, lookup, paymentSvc, smtpResolver, smtp, prisma };
}

describe('MemberRegistrationAdminController · renewal-context', () => {
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

  it(':userId que no es UUID → 404 (no el 500 del cast de Prisma)', async () => {
    await expect(
      h.controller.renewalContext(ADMIN as never, 'no-soy-uuid', 'sub_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.controller.sendRenewalEmail(ADMIN as never, 'no-soy-uuid', {
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.controller.rerun(ADMIN as never, 'no-soy-uuid', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.registration.getUserEmail).not.toHaveBeenCalled();
  });

  it('sin subscriptionId → plantilla sin enlace (email a quien no tiene suscripción)', async () => {
    const res = await h.controller.renewalContext(ADMIN as never, USER_ID, undefined);
    expect(res.renewalUrl).toBeNull();
    expect(res.template).toEqual({ subject: 'Renueva {plan}', body: 'Paga aquí: {enlace}' });
    expect(h.paymentSvc.resolveRenewalUrlByRef).not.toHaveBeenCalled();
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

describe('MemberRegistrationAdminController · renewal-email', () => {
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
    const [, message, fromName] = h.smtp.send.mock.calls[0] as [
      unknown,
      Record<string, string>,
      string,
    ];
    expect(message.to).toBe('aspirante@x.com');
    expect(message.subject).toBe(DTO.subject);
    expect(message.text).toBe(DTO.body);
    // El cuerpo se envuelve en HTML y los enlaces se vuelven <a>.
    expect(message.html).toContain('<a href="https://invoice.stripe.com/i/sub_1">');
    // Se envuelve en la plantilla de marca y se firma con el nombre del tenant.
    expect(message.html).toContain('Powered by Didacta');
    expect(fromName).toBe('Academia X');
  });
});

describe('MemberRegistrationAdminController · rerun (mapear suscripción por email)', () => {
  it('usa el email del body cuando se pasa (mapeo por otro email)', async () => {
    const h = build({ getForUser: async () => ({ email: 'registro@x.com', results: [] }) });
    const res = await h.controller.rerun(ADMIN as never, USER_ID, { email: 'pago@x.com' });
    expect(res.email).toBe('pago@x.com');
    expect(h.lookup.runAndStore).toHaveBeenCalledWith(TENANT, USER_ID, 'pago@x.com');
  });

  it('sin email en el body, reusa el del lookup previo (persiste el mapeo)', async () => {
    const h = build({ getForUser: async () => ({ email: 'pago@x.com', results: [] }) });
    const res = await h.controller.rerun(ADMIN as never, USER_ID, {});
    expect(res.email).toBe('pago@x.com');
    expect(h.lookup.runAndStore).toHaveBeenCalledWith(TENANT, USER_ID, 'pago@x.com');
  });

  it('sin email ni lookup previo, usa el de registro', async () => {
    const h = build({
      getForUser: async () => null,
      getUserEmail: async () => 'registro@x.com',
    });
    const res = await h.controller.rerun(ADMIN as never, USER_ID, {});
    expect(res.email).toBe('registro@x.com');
  });

  it('solicitante sin email de cuenta → 404', async () => {
    const h = build({ getUserEmail: async () => null, getForUser: async () => null });
    await expect(h.controller.rerun(ADMIN as never, USER_ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rol no admin → 403', async () => {
    const h = build();
    await expect(h.controller.rerun(NON_ADMIN as never, USER_ID, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
