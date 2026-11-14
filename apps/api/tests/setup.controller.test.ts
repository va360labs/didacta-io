/**
 * Test unit del controller de setup — cubre específicamente la extracción
 * del header `X-Setup-Token` (lo único que el controller resuelve por su
 * cuenta; el resto de la lógica, incluido el gate 403/409, vive en
 * `SetupService` y se cubre en setup.service.test.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { SetupController } from '../src/setup/setup.controller';
import type { SetupService } from '../src/setup/setup.service';

function makeReq(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers, ip: '127.0.0.1' } as unknown as FastifyRequest;
}

const validDto = {
  organization: { name: 'ACME' },
  admin: { name: 'Pat', email: 'pat@acme.test', password: 'super-secure-1234' },
};

describe('SetupController.init — extracción de X-Setup-Token', () => {
  it('pasa el header tal cual al service cuando es un string', async () => {
    const service = { init: vi.fn(async () => ({}) as never) } as unknown as SetupService;
    const controller = new SetupController(service);

    await controller.init(makeReq({ 'x-setup-token': 'abc123' }), validDto);

    expect(service.init).toHaveBeenCalledWith(validDto, null, expect.any(Object), 'abc123');
  });

  it('pasa null cuando el header no está presente', async () => {
    const service = { init: vi.fn(async () => ({}) as never) } as unknown as SetupService;
    const controller = new SetupController(service);

    await controller.init(makeReq({}), validDto);

    expect(service.init).toHaveBeenCalledWith(validDto, null, expect.any(Object), null);
  });

  it('toma el primer valor si el header llega duplicado (array)', async () => {
    const service = { init: vi.fn(async () => ({}) as never) } as unknown as SetupService;
    const controller = new SetupController(service);

    await controller.init(makeReq({ 'x-setup-token': ['first', 'second'] }), validDto);

    expect(service.init).toHaveBeenCalledWith(validDto, null, expect.any(Object), 'first');
  });
});

describe('SetupController.init — idioma de la academia', () => {
  const orgOf = (service: SetupService) =>
    (
      vi.mocked(service.init).mock.calls[0]![0] as typeof validDto & {
        organization: { locale?: string };
      }
    ).organization;

  it('sin idioma en el cuerpo, toma el del navegador (Accept-Language)', async () => {
    const service = { init: vi.fn(async () => ({}) as never) } as unknown as SetupService;
    await new SetupController(service).init(
      makeReq({ 'accept-language': 'en-GB,en;q=0.9,es;q=0.5' }),
      validDto,
    );
    expect(orgOf(service).locale).toBe('en');
  });

  it('el elegido en el asistente gana al del navegador', async () => {
    const service = { init: vi.fn(async () => ({}) as never) } as unknown as SetupService;
    await new SetupController(service).init(makeReq({ 'accept-language': 'en-US' }), {
      ...validDto,
      organization: { ...validDto.organization, locale: 'pt' as const },
    });
    expect(orgOf(service).locale).toBe('pt');
  });

  it('un navegador en un idioma sin catálogo no fija idioma', async () => {
    const service = { init: vi.fn(async () => ({}) as never) } as unknown as SetupService;
    await new SetupController(service).init(makeReq({ 'accept-language': 'fr-FR,de' }), validDto);
    expect(orgOf(service).locale).toBeUndefined();
  });
});
