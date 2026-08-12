import { describe, expect, it } from 'vitest';
import { resolvePublicHost } from '../src/common/resolve-public-host';
import type { RequestLike } from '../src/common/resolve-web-base-url';

function makeReq(headers: Record<string, string | string[] | undefined>): RequestLike {
  return { headers };
}

describe('resolvePublicHost', () => {
  /**
   * LA regresión. Esta es exactamente la forma que entrega el despliegue real:
   * Next reescribe `/api/*` hacia `localhost:4000`, reemplaza `Host` por el del
   * destino y deja el original en `x-forwarded-host`.
   *
   * Leer `host` primero devolvía `localhost:4000` en producción, y el tenant se
   * resolvía por ahí — al dueño de `localhost`, que es el primer tenant creado.
   * Ningún test lo vio porque todos llaman a la API directa, que es el único
   * camino que en producción no existe.
   */
  it('con la forma que entrega el proxy, gana el host del visitante', () => {
    const host = resolvePublicHost(
      makeReq({ host: 'localhost:4000', 'x-forwarded-host': 'aula-demo.didacta.io' }),
    );
    expect(host).toBe('aula-demo.didacta.io');
  });

  it('sin proxy delante, cae al Host normal', () => {
    expect(resolvePublicHost(makeReq({ host: 'academia.example.com' }))).toBe(
      'academia.example.com',
    );
  });

  it('conserva el puerto (quitarlo es cosa de quien normaliza después)', () => {
    expect(resolvePublicHost(makeReq({ host: 'localhost:3000' }))).toBe('localhost:3000');
  });

  it('cabecera repetida: se queda con la primera', () => {
    const host = resolvePublicHost(
      makeReq({ 'x-forwarded-host': ['aula.didacta.io', 'interno.local'] }),
    );
    expect(host).toBe('aula.didacta.io');
  });

  it('cadena de proxies en una sola línea: se queda con el primero, que es el del visitante', () => {
    const host = resolvePublicHost(
      makeReq({ 'x-forwarded-host': 'aula.didacta.io, borde.interno, localhost:4000' }),
    );
    expect(host).toBe('aula.didacta.io');
  });

  it('x-forwarded-host vacío no tapa al Host bueno', () => {
    expect(resolvePublicHost(makeReq({ 'x-forwarded-host': '', host: 'aula.didacta.io' }))).toBe(
      'aula.didacta.io',
    );
  });

  it('sin ninguna de las dos, undefined (el caller decide)', () => {
    expect(resolvePublicHost(makeReq({}))).toBeUndefined();
  });
});
