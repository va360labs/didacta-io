import { describe, expect, it, vi } from 'vitest';
import { TenancyController } from '../src/tenancy/tenancy.controller';
import type { TenantResolverService } from '../src/tenancy/tenant-resolver.service';

const TENANT = {
  id: 'tenant-1',
  slug: 'aula-demo',
  name: 'Aula Demo',
  matchedBy: 'hostname' as const,
  hostname: 'aula-demo.didacta.io',
};

function makeController(resolved: typeof TENANT | null) {
  const resolveByHost = vi.fn().mockResolvedValue(resolved);
  const controller = new TenancyController({ resolveByHost } as unknown as TenantResolverService);
  return { controller, resolveByHost };
}

/** La forma exacta con la que llega una petición en producción. */
const reqTrasProxy = (publico: string) =>
  ({ headers: { host: 'localhost:4000', 'x-forwarded-host': publico } }) as never;

describe('TenancyController', () => {
  it('un host de un tenant se reconoce', async () => {
    const { controller, resolveByHost } = makeController(TENANT);
    const res = await controller.resolve(reqTrasProxy('aula-demo.didacta.io'));
    expect(res).toEqual({ known: true, slug: 'aula-demo', host: 'aula-demo.didacta.io' });
    // Lo importante no es el 200: es CON QUÉ preguntó.
    expect(resolveByHost).toHaveBeenCalledWith('aula-demo.didacta.io');
  });

  it('un subdominio sin asignar NO se reconoce (UC-C403 AC2)', async () => {
    const { controller, resolveByHost } = makeController(null);
    const res = await controller.resolve(reqTrasProxy('zzz-random.didacta.io'));
    expect(res).toEqual({ known: false, slug: null, host: 'zzz-random.didacta.io' });
    expect(resolveByHost).toHaveBeenCalledWith('zzz-random.didacta.io');
  });

  /**
   * Sin esto el endpoint sería inútil: preguntaría siempre por `localhost:4000`
   * y contestaría «conocido» a cualquier hostname, porque `localhost` pertenece
   * al primer tenant. Es el mismo fallo que venía a cerrar, un piso más arriba.
   */
  it('nunca pregunta por el host del salto interno', async () => {
    const { controller, resolveByHost } = makeController(null);
    await controller.resolve(reqTrasProxy('cualquiera.didacta.io'));
    expect(resolveByHost).not.toHaveBeenCalledWith('localhost:4000');
  });
});
