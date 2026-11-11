import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { MetricsAuthController } from '../src/modules/metrics-auth.controller';

/**
 * Tests del wrapper de auth de `/metrics`. `super.index` se resuelve
 * estáticamente al prototipo de `PrometheusController`, así que
 * stubeamos ese método con `vi.spyOn` y restauramos al final de cada test.
 */
function makeController(): MetricsAuthController {
  return new MetricsAuthController();
}

const SUPER_OUTPUT = 'METRICS_OUTPUT';

let superSpy: ReturnType<typeof vi.spyOn> | undefined;
function stubSuperIndex() {
  superSpy = vi
    .spyOn(PrometheusController.prototype, 'index')
    .mockImplementation(async () => SUPER_OUTPUT as never);
}
function restoreSuperIndex() {
  superSpy?.mockRestore();
  superSpy = undefined;
}

const fakeReply = {} as never;

function reqWith(authHeader?: string): never {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as never;
}

describe('MetricsAuthController', () => {
  const original = process.env['METRICS_TOKEN'];
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    delete process.env['METRICS_TOKEN'];
    process.env['NODE_ENV'] = 'development';
    stubSuperIndex();
  });
  afterEach(() => {
    if (original === undefined) delete process.env['METRICS_TOKEN'];
    else process.env['METRICS_TOKEN'] = original;
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    restoreSuperIndex();
  });

  it('sin METRICS_TOKEN fuera de producción: deja pasar sin auth', async () => {
    const c = makeController();
    const out = await c.index(fakeReply, reqWith(undefined));
    expect(out).toBe(SUPER_OUTPUT);
  });

  /**
   * El fallo: en producción, sin token, `/metrics` era público — memoria, GC,
   * event loop y los contadores de outbox, digest y jobs para cualquiera que
   * alcanzase la API. La imagen Docker fija NODE_ENV=production, así que era
   * el estado por defecto de cualquier instalación que no definiera el token.
   */
  it('sin METRICS_TOKEN en producción: 401, y dice qué configurar', async () => {
    process.env['NODE_ENV'] = 'production';
    const c = makeController();
    await expect(c.index(fakeReply, reqWith(undefined))).rejects.toThrow(
      new UnauthorizedException(
        'En producción /metrics exige METRICS_TOKEN: defínelo en el entorno de la API y envíalo como Bearer.',
      ),
    );
    expect(superSpy).not.toHaveBeenCalled();
  });

  it('sin METRICS_TOKEN en producción: ningún Bearer lo abre (no hay token que acertar)', async () => {
    process.env['NODE_ENV'] = 'production';
    const c = makeController();
    for (const header of ['Bearer cualquiera', 'Bearer ', 'Bearer undefined', 'Basic abc']) {
      await expect(c.index(fakeReply, reqWith(header))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    expect(superSpy).not.toHaveBeenCalled();
  });

  it('METRICS_TOKEN vacío en producción cuenta como no definido: 401', async () => {
    // Es lo que llega al contenedor desde un compose con `${METRICS_TOKEN:-}`.
    process.env['NODE_ENV'] = 'production';
    process.env['METRICS_TOKEN'] = '';
    const c = makeController();
    await expect(c.index(fakeReply, reqWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(c.index(fakeReply, reqWith('Bearer '))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(superSpy).not.toHaveBeenCalled();
  });

  it('con METRICS_TOKEN en producción: acepta el token correcto y rechaza el resto', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['METRICS_TOKEN'] = 'super-secret';
    const c = makeController();
    expect(await c.index(fakeReply, reqWith('Bearer super-secret'))).toBe(SUPER_OUTPUT);
    await expect(c.index(fakeReply, reqWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(c.index(fakeReply, reqWith('Bearer otro-token'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('con METRICS_TOKEN: rechaza si no hay header', async () => {
    process.env['METRICS_TOKEN'] = 'super-secret';
    const c = makeController();
    await expect(c.index(fakeReply, reqWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('con METRICS_TOKEN: rechaza si el header no es Bearer', async () => {
    process.env['METRICS_TOKEN'] = 'super-secret';
    const c = makeController();
    await expect(c.index(fakeReply, reqWith('Basic abc'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('con METRICS_TOKEN: rechaza si el token no matchea', async () => {
    process.env['METRICS_TOKEN'] = 'super-secret';
    const c = makeController();
    await expect(c.index(fakeReply, reqWith('Bearer otro-token'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('con METRICS_TOKEN: acepta token correcto', async () => {
    process.env['METRICS_TOKEN'] = 'super-secret';
    const c = makeController();
    const out = await c.index(fakeReply, reqWith('Bearer super-secret'));
    expect(out).toBe(SUPER_OUTPUT);
  });

  it('rechaza tokens de longitud distinta sin tirar (timing-safe path)', async () => {
    process.env['METRICS_TOKEN'] = 'super-secret';
    const c = makeController();
    await expect(c.index(fakeReply, reqWith('Bearer short'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      c.index(fakeReply, reqWith('Bearer super-secret-mucho-mas-largo')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
