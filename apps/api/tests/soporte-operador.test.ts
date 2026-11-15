/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { AvisoOperadorTicket } from '@didacta/mod-soporte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOperatorEmail,
  dominio,
  SoporteOperatorNotifier,
} from '../src/modules/soporte/soporte-operator-notifier';
import { readSupportOperatorConfig } from '../src/modules/soporte/soporte-operator.config';

/**
 * Aviso inmediato al operador de la plataforma (`SUPPORT_OPERATOR_ALERT_EMAIL`)
 * de cada ticket nuevo de cualquier aula: en español, con el aula, el tipo, el
 * texto entero, quién lo abre, si trae captura y el enlace al ticket; por el
 * SMTP de la PLATAFORMA aunque el aula no tenga el suyo; y si falla, al log
 * con nivel de error.
 */

describe('SUPPORT_OPERATOR_ALERT_EMAIL', () => {
  it('sin la variable (Community sin operador) no se avisa a nadie y no es un problema', () => {
    expect(readSupportOperatorConfig({})).toEqual({ alertEmail: null, problem: null });
    expect(readSupportOperatorConfig({ SUPPORT_OPERATOR_ALERT_EMAIL: '   ' })).toEqual({
      alertEmail: null,
      problem: null,
    });
  });

  it('con un correo, ese (sin espacios)', () => {
    expect(
      readSupportOperatorConfig({ SUPPORT_OPERATOR_ALERT_EMAIL: ' valen@va360labs.com ' }),
    ).toEqual({ alertEmail: 'valen@va360labs.com', problem: null });
  });

  it('mal escrita: no avisa y lo dice (no tumba el arranque)', () => {
    const c = readSupportOperatorConfig({ SUPPORT_OPERATOR_ALERT_EMAIL: 'valen@va360labs' });
    expect(c.alertEmail).toBeNull();
    expect(c.problem).toContain('SUPPORT_OPERATOR_ALERT_EMAIL');
  });
});

const AVISO: AvisoOperadorTicket = {
  tenantId: 'tenant-1',
  ticketId: '7f3c2a10-0000-4000-8000-000000000001',
  tipo: 'FALLO',
  texto: 'Al pulsar «Publicar» sale un error.\n\nPasa desde ayer con Chrome.',
  autorId: 'user-1',
  autorNombre: 'Ana López',
  tieneCaptura: true,
  createdAt: new Date('2026-11-15T17:42:00.000Z'),
};

describe('buildOperatorEmail', () => {
  const email = buildOperatorEmail({
    academy: 'Cerámica con Lucía',
    domain: 'ceramica.didacta.io',
    tipo: 'FALLO',
    texto: AVISO.texto,
    autorNombre: 'Ana López',
    autorEmail: 'ana@example.com',
    tieneCaptura: true,
    createdAt: AVISO.createdAt,
    ticketUrl: 'https://ceramica.didacta.io/admin/support?ticket=abc',
  });

  it('el asunto dice el aula, el tipo y quién, en español', () => {
    expect(email.subject).toBe('[Soporte] Cerámica con Lucía: algo no funciona — Ana López');
  });

  it('el texto plano lleva todo lo necesario para actuar sin abrir nada', () => {
    for (const trozo of [
      'Ticket nuevo en «Cerámica con Lucía»',
      'Al pulsar «Publicar» sale un error.',
      'Pasa desde ayer con Chrome.',
      'Cerámica con Lucía',
      'ceramica.didacta.io',
      'Algo no funciona',
      'Ana López <ana@example.com>',
      'Sí (se ve en el ticket)',
      '15 de noviembre de 2026 a las 18:42 (hora peninsular)',
      'Abrir el ticket en la bandeja del aula: https://ceramica.didacta.io/admin/support?ticket=abc',
    ]) {
      expect(email.text, trozo).toContain(trozo);
    }
  });

  it('el HTML escapa lo que escribe el miembro', () => {
    const malo = buildOperatorEmail({
      academy: 'Aula <b>',
      domain: '',
      tipo: 'MEJORA',
      texto: '<script>alert(1)</script>',
      autorNombre: '<img src=x onerror=alert(1)>',
      autorEmail: null,
      tieneCaptura: false,
      createdAt: AVISO.createdAt,
      ticketUrl: '',
    });
    expect(malo.html).not.toContain('<script>');
    expect(malo.html).not.toContain('<img src=x');
    expect(malo.html).toContain('&lt;script&gt;');
    expect(malo.text).toContain('(sin dominio)');
    expect(malo.text).toContain('CAPTURA\nNo');
    expect(malo.text).not.toContain('Abrir el ticket');
  });

  it('sin nombre de cuenta lo dice; sin correo, solo el nombre', () => {
    const sin = buildOperatorEmail({
      academy: 'A',
      domain: 'a.didacta.io',
      tipo: 'PROBLEMA',
      texto: 'xxxxx',
      autorNombre: '',
      autorEmail: null,
      tieneCaptura: false,
      createdAt: AVISO.createdAt,
      ticketUrl: '',
    });
    expect(sin.text).toContain('(sin nombre)');
    expect(sin.text).toContain('Tiene un problema');
    expect(sin.text).toContain('No');
  });
});

describe('dominio', () => {
  it.each([
    ['https://ceramica.didacta.io', 'ceramica.didacta.io'],
    ['http://aula.localhost:3031', 'aula.localhost:3031'],
    ['', ''],
    ['no es una url', ''],
  ])('%s → %s', (base, esperado) => {
    expect(dominio(base)).toBe(esperado);
  });
});

describe('SoporteOperatorNotifier', () => {
  const GLOBAL = { config: { host: 'smtp.plataforma', from: 'plataforma@didacta.io' } };
  const DEL_AULA = { config: { host: 'smtp.aula', from: 'aula@example.com' } };
  let send: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;
  let resolveGlobal: ReturnType<typeof vi.fn>;
  let resolve: ReturnType<typeof vi.fn>;

  function notifier(over: Partial<ConstructorParameters<typeof SoporteOperatorNotifier>[0]> = {}) {
    return new SoporteOperatorNotifier({
      prisma: {
        tenant: { findUnique: vi.fn(async () => ({ name: 'Cerámica con Lucía' })) },
        user: { findFirst: vi.fn(async () => ({ email: 'ana@example.com', name: 'Ana' })) },
      },
      smtpResolver: { resolveGlobal, resolve } as never,
      smtp: { send } as never,
      webBaseUrl: async () => 'https://ceramica.didacta.io/',
      alertEmail: 'valen@va360labs.com',
      logger: { error, log: vi.fn() },
      ...over,
    });
  }

  beforeEach(() => {
    send = vi.fn(async () => ({ ok: true, messageId: 'm1' }));
    error = vi.fn();
    resolveGlobal = vi.fn(() => GLOBAL);
    resolve = vi.fn(async () => DEL_AULA);
  });

  it('sale por el SMTP de la plataforma, a la dirección del operador, con el enlace al ticket', async () => {
    await notifier().avisar(AVISO);
    expect(send).toHaveBeenCalledTimes(1);
    const [config, input, nombre] = send.mock.calls[0]!;
    expect(config).toBe(GLOBAL.config);
    expect(resolve).not.toHaveBeenCalled();
    expect(input.to).toBe('valen@va360labs.com');
    expect(input.subject).toBe('[Soporte] Cerámica con Lucía: algo no funciona — Ana López');
    expect(input.text).toContain('ceramica.didacta.io');
    expect(input.text).toContain('Ana López <ana@example.com>');
    expect(input.text).toContain(
      `https://ceramica.didacta.io/admin/support?ticket=${AVISO.ticketId}`,
    );
    expect(nombre).toBe('Didacta soporte');
    expect(error).not.toHaveBeenCalled();
  });

  it('sale aunque el aula no tenga SMTP propio (control: no se pregunta por el del aula)', async () => {
    resolve.mockResolvedValue(null);
    await notifier().avisar(AVISO);
    expect(send).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('un despliegue sin SMTP de plataforma usa el del aula', async () => {
    resolveGlobal.mockReturnValue(null);
    await notifier().avisar(AVISO);
    expect(send.mock.calls[0]![0]).toBe(DEL_AULA.config);
  });

  it('sin ningún SMTP: no envía y lo deja en el log con nivel de error', async () => {
    resolveGlobal.mockReturnValue(null);
    resolve.mockResolvedValue(null);
    await notifier().avisar(AVISO);
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('alert: soporte.operator.no_smtp'));
  });

  it('si el servidor de correo lo rechaza, error en el log y no lanza', async () => {
    send.mockResolvedValue({ ok: false, error: '550 buzón lleno' });
    await expect(notifier().avisar(AVISO)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('550 buzón lleno'));
  });

  it('si algo revienta, error en el log y no lanza', async () => {
    send.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(notifier().avisar(AVISO)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('sin poder leer el aula ni el autor, sale igual con lo que hay', async () => {
    await notifier({
      prisma: {
        tenant: {
          findUnique: vi.fn(async () => {
            throw new Error('RLS');
          }),
        },
        user: {
          findFirst: vi.fn(async () => {
            throw new Error('RLS');
          }),
        },
      },
      webBaseUrl: async () => {
        throw new Error('sin dominio');
      },
    }).avisar(AVISO);
    const input = send.mock.calls[0]![1];
    expect(input.subject).toContain('tenant-1');
    expect(input.text).toContain('Ana López');
    expect(input.text).toContain('(sin dominio)');
  });
});
