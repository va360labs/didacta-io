/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del OidcController — 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Cobertura:
 *   - GET :tenantSlug/start con flow OK → res.redirect(authorizationUrl).
 *   - GET :tenantSlug/start cuando el service throws NotFoundException → propaga.
 *   - GET callback success → redirect a /auth/callback con tokens en query.
 *   - GET callback con UnauthorizedException nonce_mismatch → /auth/error?reason=nonce_mismatch.
 *   - GET callback con NotFoundException → /auth/error?reason=tenant_not_configured.
 *   - GET callback con ServiceUnavailableException → /auth/error?reason=idp_unreachable.
 *   - mapErrorToReason cubre los códigos relevantes.
 *
 * Las verificaciones de criptografía / id_token / state ya están cubiertas en
 * oidc.service.test.ts. Aquí sólo verificamos el WIRE controller→service y el
 * mapping de errores a redirect URLs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OidcController } from '../src/sso/oidc/oidc.controller';

interface FakeReply {
  status: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  _statusCode?: number;
  _redirectUrl?: string;
}

function makeFakeReply(): FakeReply {
  const reply: FakeReply = {
    status: vi.fn(),
    redirect: vi.fn(),
  };
  reply.status.mockImplementation((code: number) => {
    reply._statusCode = code;
    return reply;
  });
  reply.redirect.mockImplementation((url: string) => {
    reply._redirectUrl = url;
    return reply;
  });
  return reply;
}

interface FakeOidcService {
  startFlow: ReturnType<typeof vi.fn>;
  handleCallback: ReturnType<typeof vi.fn>;
  isEnabledForTenantSlug: ReturnType<typeof vi.fn>;
}

function makeFakeService(): FakeOidcService {
  return {
    startFlow: vi.fn(),
    handleCallback: vi.fn(),
    isEnabledForTenantSlug: vi.fn(),
  };
}

beforeEach(() => {
  process.env['WEB_PUBLIC_URL'] = 'http://localhost:3000';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// /:tenantSlug/start
// ---------------------------------------------------------------------------

describe('OidcController.start', () => {
  it('delega al service y hace redirect 302 al authorizationUrl', async () => {
    const svc = makeFakeService();
    svc.startFlow.mockResolvedValue({
      authorizationUrl: 'https://idp.example.com/authorize?state=abc&nonce=xyz',
      state: 'abc',
      nonce: 'xyz',
      codeVerifier: 'cv',
    });
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();

    await ctrl.start('acme', reply as unknown as Parameters<OidcController['start']>[1]);

    expect(svc.startFlow).toHaveBeenCalledWith('acme');
    expect(reply._statusCode).toBe(302);
    expect(reply._redirectUrl).toBe('https://idp.example.com/authorize?state=abc&nonce=xyz');
  });

  it('propaga NotFoundException del service (Nest la mapea a 404)', async () => {
    const svc = makeFakeService();
    svc.startFlow.mockRejectedValue(new NotFoundException('Tenant no encontrado.'));
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();
    await expect(
      ctrl.start('does-not-exist', reply as unknown as Parameters<OidcController['start']>[1]),
    ).rejects.toThrow(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// /:tenantSlug/status
// ---------------------------------------------------------------------------

describe('OidcController.status', () => {
  it('devuelve { enabled: true } cuando el service confirma habilitado', async () => {
    const svc = makeFakeService();
    svc.isEnabledForTenantSlug.mockResolvedValue(true);
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const out = await ctrl.status('acme');
    expect(svc.isEnabledForTenantSlug).toHaveBeenCalledWith('acme');
    expect(out).toEqual({ enabled: true });
  });

  it('devuelve { enabled: false } cuando el tenant no tiene config', async () => {
    const svc = makeFakeService();
    svc.isEnabledForTenantSlug.mockResolvedValue(false);
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const out = await ctrl.status('unknown');
    expect(out).toEqual({ enabled: false });
  });

  it('NUNCA expone configuración (issuer/clientId/secret) en la respuesta', async () => {
    const svc = makeFakeService();
    svc.isEnabledForTenantSlug.mockResolvedValue(true);
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const out = await ctrl.status('acme');
    expect(Object.keys(out)).toEqual(['enabled']);
  });
});

// ---------------------------------------------------------------------------
// /callback
// ---------------------------------------------------------------------------

describe('OidcController.callback', () => {
  it('OK → redirect a /auth/callback con tokens en query', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockResolvedValue({
      tokens: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresIn: 900,
      },
      user: {
        id: 'u1',
        email: 'u@acme.com',
        name: 'U',
        tenantId: 't1',
        tenantSlug: 'acme',
        roles: ['student'],
      },
    });
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();

    await ctrl.callback(
      'state-token',
      'code-token',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );

    expect(svc.handleCallback).toHaveBeenCalledWith({
      state: 'state-token',
      code: 'code-token',
      error: undefined,
      errorDescription: undefined,
    });
    expect(reply._statusCode).toBe(302);
    expect(reply._redirectUrl).toContain('http://localhost:3000/auth/callback');
    expect(reply._redirectUrl).toContain('accessToken=AT');
    expect(reply._redirectUrl).toContain('refreshToken=RT');
    expect(reply._redirectUrl).toContain('expiresIn=900');
    expect(reply._redirectUrl).toContain('tenantSlug=acme');
    expect(reply._redirectUrl).toContain('userId=u1');
    expect(reply._redirectUrl).toContain('email=u%40acme.com');
    expect(reply._redirectUrl).toContain('tenantId=t1');
    expect(reply._redirectUrl).toContain('roles=student');
    expect(reply._redirectUrl).toContain('mfaEnabled=true');
  });

  it('UnauthorizedException con "nonce" → reason=nonce_mismatch', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(
      new UnauthorizedException('nonce del id_token no coincide.'),
    );
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();

    await ctrl.callback(
      'state-token',
      'code-token',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('/auth/error');
    expect(reply._redirectUrl).toContain('reason=nonce_mismatch');
  });

  it('UnauthorizedException con "State desconocido" → reason=state_invalid', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(
      new UnauthorizedException('State desconocido o expirado.'),
    );
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();

    await ctrl.callback(
      'bad-state',
      'code',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=state_invalid');
  });

  it('UnauthorizedException con "No tienes cuenta" → reason=user_not_provisioned', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(
      new UnauthorizedException('No tienes cuenta en este tenant.'),
    );
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();

    await ctrl.callback(
      's',
      'c',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=user_not_provisioned');
  });

  it('UnauthorizedException con "dominios" → reason=email_not_allowed', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(
      new UnauthorizedException('El email no pertenece a los dominios permitidos.'),
    );
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();
    await ctrl.callback(
      's',
      'c',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=email_not_allowed');
  });

  it('NotFoundException → reason=tenant_not_configured', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(new NotFoundException('Sin config.'));
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();
    await ctrl.callback(
      's',
      'c',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=tenant_not_configured');
  });

  it('ServiceUnavailableException → reason=idp_unreachable', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(new ServiceUnavailableException('IdP down'));
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();
    await ctrl.callback(
      's',
      'c',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=idp_unreachable');
  });

  it('BadRequestException → reason=bad_request', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(new BadRequestException('Faltan params.'));
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();
    await ctrl.callback(
      undefined,
      'c',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=bad_request');
  });

  it('error genérico → reason=internal', async () => {
    const svc = makeFakeService();
    svc.handleCallback.mockRejectedValue(new Error('boom'));
    const ctrl = new OidcController(
      svc as unknown as ConstructorParameters<typeof OidcController>[0],
    );
    const reply = makeFakeReply();
    await ctrl.callback(
      's',
      'c',
      undefined,
      undefined,
      reply as unknown as Parameters<OidcController['callback']>[4],
      { headers: {} } as Parameters<OidcController['callback']>[5],
    );
    expect(reply._redirectUrl).toContain('reason=internal');
  });
});
