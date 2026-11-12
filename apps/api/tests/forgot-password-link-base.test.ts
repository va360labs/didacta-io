import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';

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
 *
 * Ese enlace lleva un token que abre la cuenta: el `Host` no decide nada salvo
 * que sea un dominio verificado de esa misma aula o esté en la lista de hosts
 * permitidos.
 */

const ACCOUNT_TENANT = 'tenant-de-la-cuenta';
const ENV_KEYS = ['WEB_PUBLIC_URL', 'WEB_PUBLIC_ALLOWED_HOSTS'];

function makeController(opts: { hostTenantId?: string; primaryDomain?: string | null }) {
  const bases: string[] = [];
  // El servicio real decide el tenant de la cuenta y solo entonces pide la base.
  const requestAndSendEmail = vi.fn(
    async (
      _args: unknown,
      webBaseUrl: string | ((tenantId: string) => Promise<string> | string),
    ) => {
      bases.push(typeof webBaseUrl === 'function' ? await webBaseUrl(ACCOUNT_TENANT) : webBaseUrl);
    },
  );
  const tenantResolver = {
    resolveByHost: vi.fn(async () => (opts.hostTenantId ? { id: opts.hostTenantId } : null)),
    resolvePrimaryDomain: vi.fn(async (tenantId: string) =>
      tenantId === ACCOUNT_TENANT ? (opts.primaryDomain ?? null) : null,
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

/** Petición con un `Host` que elige quien llama. */
const from = (host: string) =>
  ({ headers: { host, 'x-forwarded-proto': 'https' }, ip: '203.0.113.7' }) as never;
const ATAQUE = { email: 'victima@empresa.com', tenantSlug: 'victima' } as never;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('forgot-password · base del enlace', () => {
  describe('ATAQUE: la petición llega por un dominio que no es del aula de la cuenta', () => {
    it('aula con dominio primario verificado → su dominio, no el de la petición', async () => {
      const { controller, bases, requestAndSendEmail } = makeController({
        primaryDomain: 'aula.victima.example',
      });

      await controller.forgotPassword(from('evil.example'), ATAQUE);

      expect(bases).toEqual(['https://aula.victima.example']);
      // El dominio no resolvió a ningún aula: la cuenta se busca por el slug.
      expect(requestAndSendEmail.mock.calls[0]![0]).toEqual({
        email: 'victima@empresa.com',
        tenantSlug: 'victima',
        resolvedTenantId: undefined,
      });
    });

    it('aula SIN dominio primario y sin WEB_PUBLIC_URL → tampoco: el Host no se usa (y se avisa)', async () => {
      const { controller, bases } = makeController({ primaryDomain: null });

      await controller.forgotPassword(from('evil.example'), ATAQUE);

      expect(bases).toHaveLength(1);
      expect(bases[0]).not.toContain('evil.example');
      // Constante, no controlable por quien llama: el enlace queda inservible
      // antes que secuestrable.
      expect(bases[0]).toBe('http://localhost:3000');
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    });

    it('aula sin dominio primario pero con WEB_PUBLIC_URL → WEB_PUBLIC_URL', async () => {
      process.env['WEB_PUBLIC_URL'] = 'https://aulas.operador.example';
      const { controller, bases } = makeController({ primaryDomain: null });

      await controller.forgotPassword(from('evil.example'), ATAQUE);

      expect(bases).toEqual(['https://aulas.operador.example']);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('un Host que el operador ha puesto en WEB_PUBLIC_ALLOWED_HOSTS sí vale; cualquier otro, no', async () => {
      process.env['WEB_PUBLIC_ALLOWED_HOSTS'] = 'aula.permitida.example';
      const { controller, bases } = makeController({ primaryDomain: null });

      await controller.forgotPassword(from('aula.permitida.example'), ATAQUE);
      await controller.forgotPassword(from('evil.example'), ATAQUE);

      expect(bases).toEqual(['https://aula.permitida.example', 'http://localhost:3000']);
    });

    it('el dominio verificado de OTRA aula tampoco decide (la cuenta se resolvió por el slug del cuerpo)', async () => {
      // No puede pasar hoy —con un dominio que resuelve a un aula la cuenta se
      // busca en ESA aula—, pero la regla no depende de eso.
      const { controller, bases } = makeController({
        hostTenantId: 'aula-del-atacante',
        primaryDomain: null,
      });

      await controller.forgotPassword(from('aula.atacante.example'), ATAQUE);

      expect(bases[0]).not.toContain('atacante');
    });
  });

  describe('CONTROL: la petición llega por un dominio verificado del aula de la cuenta', () => {
    it('con dominio primario → el primario, como siempre', async () => {
      const { controller, bases } = makeController({
        hostTenantId: ACCOUNT_TENANT,
        primaryDomain: 'aula.victima.example',
      });

      await controller.forgotPassword(from('otro-dominio.victima.example'), {
        email: 'victima@empresa.com',
      } as never);

      expect(bases).toEqual(['https://aula.victima.example']);
    });

    it('sin dominio primario → el propio dominio de la petición (está verificado en nuestra base), como siempre', async () => {
      const { controller, bases } = makeController({
        hostTenantId: ACCOUNT_TENANT,
        primaryDomain: null,
      });

      await controller.forgotPassword(from('aula.victima.example'), {
        email: 'victima@empresa.com',
      } as never);

      expect(bases).toEqual(['https://aula.victima.example']);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });
  });
});
