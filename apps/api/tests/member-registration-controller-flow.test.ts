/**
 * Tests del flujo COMPONIBLE de `MemberRegistrationPublicController` (F2 — registro
 * componible). Verifican el gating por política del tenant y el desacople
 * OTP↔Telegram:
 *
 *  - config: refleja disponibilidad + verificadores + botUsername.
 *  - otp/request: exige el ticket de Telegram SOLO si la política lo incluye;
 *    503 si la política no incluye `otp` o el flujo no está disponible.
 *  - otp/verify: emite verificationToken con telegramId null cuando no aplica.
 *  - register: evidencia según política — verificationToken (con otp), ticket
 *    de Telegram + email de formulario (solo telegram), email de formulario
 *    (registro libre); 503 con registro cerrado o no operativo.
 *
 * Servicios mockeados; los tickets firmados son REALES (signed-ticket con
 * AUTH_SECRET de test) para cubrir también la verificación de firma/purpose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MemberRegistrationPublicController } from '../src/modules/member-registration/member-registration-public.controller';
import type { EffectiveRegistrationPolicy } from '@didacta/mod-member-registration';
import { signTicket } from '@didacta/mod-member-registration';
import { resolveWebBaseUrl, type RequestLike } from '../src/common/resolve-web-base-url';

const AUTH_SECRET = 'secret-de-test-suficientemente-largo';
const TENANT_ID = 'tenant-1';

const REQ = {
  headers: { host: 'demo.ejemplo.com', 'user-agent': 'vitest' },
  ip: '1.2.3.4',
} as never;

function policy(overrides: Partial<EffectiveRegistrationPolicy>): EffectiveRegistrationPolicy {
  return {
    enabled: true,
    verifiers: [],
    operational: true,
    botUsername: null,
    ...overrides,
  };
}

function makeController(effectivePolicy: EffectiveRegistrationPolicy) {
  const telegram = {
    verifyLoginHash: vi.fn().mockReturnValue(true),
    getChatMember: vi.fn().mockResolvedValue('true'),
  };
  const emailVerification = {
    requestCode: vi.fn().mockResolvedValue(600),
    verifyCode: vi.fn().mockResolvedValue(true),
  };
  const registration = {
    createPending: vi.fn().mockResolvedValue({ userId: 'u1', created: true, status: 'PENDING' }),
  };
  const decision = { decide: vi.fn() };
  const settings = {
    resolveEffectivePolicy: vi.fn().mockResolvedValue(effectivePolicy),
    resolveTelegram: vi.fn().mockResolvedValue({
      botToken: 'tok',
      groupId: '-100',
      botUsername: effectivePolicy.botUsername,
    }),
  };
  const tenantResolver = {
    resolveByHost: vi.fn().mockResolvedValue({ id: TENANT_ID }),
    // Sin BD real en este harness: delega en la misma cascada pura que usaba
    // el controller antes de F5 (env → Host del request → localhost).
    resolveTenantWebBaseUrl: vi.fn(async (_tenantId: string | null, req?: RequestLike) =>
      resolveWebBaseUrl(req),
    ),
  };

  const controller = new MemberRegistrationPublicController(
    telegram as never,
    emailVerification as never,
    registration as never,
    decision as never,
    settings as never,
    tenantResolver as never,
  );
  return { controller, telegram, emailVerification, registration, settings, tenantResolver };
}

const ORIGINAL_AUTH_SECRET = process.env['AUTH_SECRET'];

beforeEach(() => {
  process.env['AUTH_SECRET'] = AUTH_SECRET;
});

afterEach(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = ORIGINAL_AUTH_SECRET;
  vi.restoreAllMocks();
});

describe('MemberRegistrationPublicController · config', () => {
  it('expone disponibilidad, verificadores y botUsername de la política efectiva', async () => {
    const { controller } = makeController(
      policy({ verifiers: ['telegram', 'otp'], botUsername: 'mi_bot' }),
    );
    expect(await controller.config(REQ)).toEqual({
      configured: true,
      verifiers: ['telegram', 'otp'],
      botUsername: 'mi_bot',
    });
  });

  it('registro cerrado → configured:false', async () => {
    const { controller } = makeController(policy({ enabled: false, operational: false }));
    const res = await controller.config(REQ);
    expect(res.configured).toBe(false);
  });

  it('no operativo (telegram exigido sin bot) → configured:false', async () => {
    const { controller } = makeController(
      policy({ verifiers: ['telegram', 'otp'], operational: false }),
    );
    const res = await controller.config(REQ);
    expect(res.configured).toBe(false);
  });
});

describe('MemberRegistrationPublicController · telegram/verify', () => {
  it('503 cuando la política no incluye telegram', async () => {
    const { controller } = makeController(policy({ verifiers: ['otp'] }));
    await expect(
      controller.telegramVerify(REQ, { id: '1', auth_date: 1, hash: 'x' } as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('503 cuando el flujo no está operativo', async () => {
    const { controller } = makeController(policy({ verifiers: ['telegram'], operational: false }));
    await expect(
      controller.telegramVerify(REQ, { id: '1', auth_date: 1, hash: 'x' } as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('MemberRegistrationPublicController · otp/request', () => {
  it("sin 'otp' en la política → 503", async () => {
    const { controller } = makeController(policy({ verifiers: ['telegram'] }));
    await expect(controller.otpRequest(REQ, { email: 'a@x.com' } as never)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('política telegram+otp SIN ticket → 401 (el gate se mantiene)', async () => {
    const { controller, emailVerification } = makeController(
      policy({ verifiers: ['telegram', 'otp'] }),
    );
    await expect(controller.otpRequest(REQ, { email: 'a@x.com' } as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(emailVerification.requestCode).not.toHaveBeenCalled();
  });

  it('política solo-otp: NO exige ticket y envía el código (desacople OTP↔Telegram)', async () => {
    const { controller, emailVerification } = makeController(policy({ verifiers: ['otp'] }));
    const res = await controller.otpRequest(REQ, { email: 'a@x.com' } as never);
    expect(res).toEqual({ ok: true, expiresInSeconds: 600 });
    expect(emailVerification.requestCode).toHaveBeenCalledWith(
      TENANT_ID,
      'a@x.com',
      expect.anything(),
    );
  });

  it('política telegram+otp con ticket válido → envía el código', async () => {
    const { controller, emailVerification } = makeController(
      policy({ verifiers: ['telegram', 'otp'] }),
    );
    const ticket = signTicket(
      { telegramId: '42', inGroup: 'true', purpose: 'telegram' },
      AUTH_SECRET,
      900,
    );
    const res = await controller.otpRequest(REQ, { email: 'a@x.com', ticket } as never);
    expect(res.ok).toBe(true);
    expect(emailVerification.requestCode).toHaveBeenCalledTimes(1);
  });
});

describe('MemberRegistrationPublicController · otp/verify', () => {
  it('política solo-otp: emite verificationToken con telegramId null', async () => {
    const { controller, registration } = makeController(policy({ verifiers: ['otp'] }));
    const { verificationToken } = await controller.otpVerify(REQ, {
      email: 'a@x.com',
      code: '123456',
    } as never);

    // El token emitido sirve tal cual para registrar, y aterriza sin Telegram.
    await controller.register(REQ, {
      name: 'Ana',
      password: 'x'.repeat(12),
      verificationToken,
    } as never);
    const input = registration.createPending.mock.calls[0][1];
    expect(input.telegramId).toBeNull();
    expect(input.inGroup).toBe('unknown');
    expect(input.email).toBe('a@x.com');
  });

  it('código inválido → 401', async () => {
    const { controller, emailVerification } = makeController(policy({ verifiers: ['otp'] }));
    emailVerification.verifyCode.mockResolvedValue(false);
    await expect(
      controller.otpVerify(REQ, { email: 'a@x.com', code: '000000' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('MemberRegistrationPublicController · register', () => {
  it('registro cerrado → 503', async () => {
    const { controller } = makeController(policy({ enabled: false, operational: false }));
    await expect(
      controller.register(REQ, { name: 'Ana', password: 'x'.repeat(12) } as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('registro libre: exige email del formulario (400 sin él)', async () => {
    const { controller } = makeController(policy({ verifiers: [] }));
    await expect(
      controller.register(REQ, { name: 'Ana', password: 'x'.repeat(12) } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('registro libre: crea la solicitud con el email normalizado y sin Telegram', async () => {
    const { controller, registration } = makeController(policy({ verifiers: [] }));
    const res = await controller.register(REQ, {
      name: 'Ana',
      password: 'x'.repeat(12),
      email: ' Ana@X.com ',
    } as never);
    expect(res).toEqual({ ok: true, status: 'PENDING' });
    const input = registration.createPending.mock.calls[0][1];
    expect(input.email).toBe('ana@x.com');
    expect(input.telegramId).toBeNull();
  });

  it('política con otp: sin verificationToken → 401', async () => {
    const { controller } = makeController(policy({ verifiers: ['otp'] }));
    await expect(
      controller.register(REQ, {
        name: 'Ana',
        password: 'x'.repeat(12),
        email: 'a@x.com',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('política telegram+otp: el verificationToken debe arrastrar telegramId', async () => {
    const { controller } = makeController(policy({ verifiers: ['telegram', 'otp'] }));
    // Token emitido "sin Telegram" (p.ej. de cuando la política era solo-otp):
    // no vale si ahora la política exige telegram.
    const token = signTicket(
      { telegramId: null, inGroup: 'unknown', email: 'a@x.com', purpose: 'member-register' },
      AUTH_SECRET,
      1800,
    );
    await expect(
      controller.register(REQ, {
        name: 'Ana',
        password: 'x'.repeat(12),
        verificationToken: token,
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('política solo-telegram: ticket del widget + email del formulario', async () => {
    const { controller, registration } = makeController(policy({ verifiers: ['telegram'] }));
    const ticket = signTicket(
      { telegramId: '42', inGroup: 'false', purpose: 'telegram' },
      AUTH_SECRET,
      900,
    );
    await controller.register(REQ, {
      name: 'Ana',
      password: 'x'.repeat(12),
      email: 'a@x.com',
      ticket,
    } as never);
    const input = registration.createPending.mock.calls[0][1];
    expect(input.telegramId).toBe('42');
    expect(input.inGroup).toBe('false');
    expect(input.email).toBe('a@x.com');
  });

  it('política solo-telegram sin ticket → 401', async () => {
    const { controller } = makeController(policy({ verifiers: ['telegram'] }));
    await expect(
      controller.register(REQ, {
        name: 'Ana',
        password: 'x'.repeat(12),
        email: 'a@x.com',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un ticket con purpose equivocado no sirve como evidencia', async () => {
    const { controller } = makeController(policy({ verifiers: ['telegram'] }));
    const wrong = signTicket(
      { telegramId: '42', inGroup: 'true', purpose: 'member-register' },
      AUTH_SECRET,
      900,
    );
    await expect(
      controller.register(REQ, {
        name: 'Ana',
        password: 'x'.repeat(12),
        email: 'a@x.com',
        ticket: wrong,
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
