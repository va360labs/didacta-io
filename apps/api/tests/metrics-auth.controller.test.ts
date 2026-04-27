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

  beforeEach(() => {
    delete process.env['METRICS_TOKEN'];
    stubSuperIndex();
  });
  afterEach(() => {
    if (original === undefined) delete process.env['METRICS_TOKEN'];
    else process.env['METRICS_TOKEN'] = original;
    restoreSuperIndex();
  });

  it('sin METRICS_TOKEN: deja pasar sin auth (backward compat)', async () => {
    const c = makeController();
    const out = await c.index(fakeReply, reqWith(undefined));
    expect(out).toBe(SUPER_OUTPUT);
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
