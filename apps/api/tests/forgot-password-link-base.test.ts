import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';
import { resolveWebBaseUrl, type RequestLike } from '../src/common/resolve-web-base-url';

/**
 * Adónde apunta el enlace de «restablecer contraseña».
 *
 * El endpoint es público y resuelve la cuenta por tres caminos: el dominio de
 * la petición, el `tenantSlug` del cuerpo o el correo si solo existe en un
 * aula. La base del enlace se calculaba con el tenant del DOMINIO, antes de
 * saber en qué aula estaba la cuenta: con un dominio que no es de ningún aula
 * (lo pone quien llama) la base salía sin tenant → `WEB_PUBLIC_URL` y, sin
 * ella, el propio `Host` de la petición. Un enlace con el token de la víctima,
 * en su buzón, apuntando al dominio de un tercero.
 */

const ACCOUNT_TENANT = 'tenant-de-la-cuenta';
const PRIMARY_DOMAIN: Record<string, string> = { [ACCOUNT_TENANT]: 'aula.victima.example' };

function makeController(opts: { hostTenantId?: string }) {
  // El servicio real decide el tenant de la cuenta y solo entonces pide la base.
  const requestAndSendEmail = vi.fn(
    async (
      _args: unknown,
      webBaseUrl: string | ((tenantId: string) => Promise<string> | string),
    ) => {
      bases.push(typeof webBaseUrl === 'function' ? await webBaseUrl(ACCOUNT_TENANT) : webBaseUrl);
    },
  );
  const bases: string[] = [];
  const tenantResolver = {
    resolveByHost: vi.fn(async () => (opts.hostTenantId ? { id: opts.hostTenantId } : null)),
    // La cascada de verdad (dominio primario del tenant → env → Host).
    resolveTenantWebBaseUrl: vi.fn(async (tenantId: string | null, req?: RequestLike) =>
      resolveWebBaseUrl(req, tenantId ? (PRIMARY_DOMAIN[tenantId] ?? null) : null),
    ),
  };
  const controller = new AuthController(
    {} as never,
    { requestAndSendEmail } as never,
    tenantResolver as never,
    {} as never,
  );
  return { controller, bases, requestAndSendEmail };
}

const SAVED = process.env['WEB_PUBLIC_URL'];
beforeEach(() => {
  delete process.env['WEB_PUBLIC_URL'];
});
afterEach(() => {
  if (SAVED === undefined) delete process.env['WEB_PUBLIC_URL'];
  else process.env['WEB_PUBLIC_URL'] = SAVED;
});

describe('forgot-password · base del enlace', () => {
  it('ATAQUE: dominio que no es de ningún aula + tenantSlug en el cuerpo → el enlace va al dominio del aula de la cuenta, no al de la petición', async () => {
    const { controller, bases, requestAndSendEmail } = makeController({});
    const req = {
      headers: { host: 'evil.example', 'x-forwarded-proto': 'https' },
      ip: '203.0.113.7',
    } as never;

    await controller.forgotPassword(req, {
      email: 'victima@empresa.com',
      tenantSlug: 'victima',
    } as never);

    expect(bases).toEqual(['https://aula.victima.example']);
    // El dominio no resolvió a ningún aula: la cuenta se busca por el slug.
    expect(requestAndSendEmail.mock.calls[0]![0]).toEqual({
      email: 'victima@empresa.com',
      tenantSlug: 'victima',
      resolvedTenantId: undefined,
    });
  });

  it('CONTROL: dominio verificado del aula de la cuenta → su dominio primario, como siempre', async () => {
    const { controller, bases } = makeController({ hostTenantId: ACCOUNT_TENANT });
    const req = { headers: { host: 'aula.victima.example' }, ip: '198.51.100.4' } as never;

    await controller.forgotPassword(req, { email: 'victima@empresa.com' } as never);

    expect(bases).toEqual(['https://aula.victima.example']);
  });
});
