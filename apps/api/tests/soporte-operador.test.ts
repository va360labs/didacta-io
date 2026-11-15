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
 * Correo inmediato al operador de la plataforma (`SUPPORT_OPERATOR_ALERT_EMAIL`)
 * de cada ticket que le escribe QUIEN ADMINISTRA un aula: en español, diciendo
 * que es del creador del aula, con el aula y su dominio, el tipo, el texto
 * entero, la captura adjunta y Reply-To del creador para contestar por correo;
 * por el SMTP de la PLATAFORMA aunque el aula no tenga el suyo; y si falla, al
 * log con nivel de error.
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const AVISO: AvisoOperadorTicket = {
  tenantId: 'tenant-1',
  ticketId: '7f3c2a10-0000-4000-8000-000000000001',
  tipo: 'FALLO',
  texto: 'Al pulsar «Publicar» sale un error.\n\nPasa desde ayer con Chrome.',
  autorId: 'user-1',
  autorNombre: 'Lucía Martín',
  tieneCaptura: true,
  captura: { data: PNG, contentType: 'image/webp', nombre: 'pantalla.webp' },
  createdAt: new Date('2026-11-15T17:42:00.000Z'),
};

describe('buildOperatorEmail', () => {
  const email = buildOperatorEmail({
    academy: 'Cerámica con Lucía',
    domain: 'ceramica.didacta.io',
    academyUrl: 'https://ceramica.didacta.io',
    tipo: 'FALLO',
    texto: AVISO.texto,
    autorNombre: 'Lucía Martín',
    autorEmail: 'lucia@example.com',
    tieneCaptura: true,
    capturaAdjunta: true,
    createdAt: AVISO.createdAt,
  });

  it('el asunto dice que es del CREADOR del aula, el tipo y quién, en español', () => {
    expect(email.subject).toBe(
      '[Soporte] Creador de Cerámica con Lucía: algo no funciona — Lucía Martín',
    );
  });

  it('el texto plano lleva todo lo necesario para contestar sin abrir nada', () => {
    for (const trozo of [
      'Ticket del CREADOR de «Cerámica con Lucía»',
      'Al pulsar «Publicar» sale un error.',
      'Pasa desde ayer con Chrome.',
      'ceramica.didacta.io',
      'Entrar en el aula: https://ceramica.didacta.io',
      'LO ESCRIBE SU CREADOR (ADMINISTRA EL AULA)\nLucía Martín <lucia@example.com>',
      'Algo no funciona',
      'Sí, va adjunta a este correo',
      '15 de noviembre de 2026 a las 18:42 (hora peninsular)',
      'Contesta a este correo: la respuesta le llega a lucia@example.com.',
    ]) {
      expect(email.text, trozo).toContain(trozo);
    }
    // No hay bandeja del operador ni el ticket sale en la del aula.
    expect(email.text).not.toContain('/admin/support');
  });

  it('el HTML escapa lo que escribe el creador', () => {
    const malo = buildOperatorEmail({
      academy: 'Aula <b>',
      domain: '',
      academyUrl: '',
      tipo: 'MEJORA',
      texto: '<script>alert(1)</script>',
      autorNombre: '<img src=x onerror=alert(1)>',
      autorEmail: null,
      tieneCaptura: false,
      capturaAdjunta: false,
      createdAt: AVISO.createdAt,
    });
    expect(malo.html).not.toContain('<script>');
    expect(malo.html).not.toContain('<img src=x');
    expect(malo.html).toContain('&lt;script&gt;');
    expect(malo.text).toContain('(sin dominio)');
    expect(malo.text).toContain('CAPTURA\nNo');
    expect(malo.text).toContain('No se pudo leer su correo');
    expect(malo.text).not.toContain('Entrar en el aula');
  });

  it('con captura que no se pudo leer, lo dice', () => {
    const sin = buildOperatorEmail({
      academy: 'A',
      domain: 'a.didacta.io',
      academyUrl: '',
      tipo: 'PROBLEMA',
      texto: 'xxxxx',
      autorNombre: '',
      autorEmail: null,
      tieneCaptura: true,
      capturaAdjunta: false,
      createdAt: AVISO.createdAt,
    });
    expect(sin.text).toContain('(sin nombre)');
    expect(sin.text).toContain('Tiene un problema');
    expect(sin.text).toContain('Sí, pero no se pudo adjuntar');
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
        user: {
          findFirst: vi.fn(async () => ({ email: 'lucia@example.com', name: 'Lucía' })),
        },
      },
      smtpResolver: { resolveGlobal, resolve } as never,
      smtp: { send } as never,
      webBaseUrl: async () => 'https://ceramica.didacta.io/',
      alertEmail: 'valen@va360labs.com',
      logger: { error, log: vi.fn() } as never,
      ...over,
    });
  }

  beforeEach(() => {
    send = vi.fn(async () => ({ ok: true, messageId: 'm1' }));
    error = vi.fn();
    resolveGlobal = vi.fn(() => GLOBAL);
    resolve = vi.fn(async () => DEL_AULA);
  });

  it('sale por el SMTP de la plataforma, al operador, con Reply-To del creador y la captura adjunta', async () => {
    await notifier().avisar(AVISO);
    expect(send).toHaveBeenCalledTimes(1);
    const [config, input, nombre] = send.mock.calls[0]!;
    expect(config).toEqual({ ...GLOBAL.config, sender: { replyTo: 'lucia@example.com' } });
    expect(resolve).not.toHaveBeenCalled();
    expect(input.to).toBe('valen@va360labs.com');
    expect(input.subject).toBe(
      '[Soporte] Creador de Cerámica con Lucía: algo no funciona — Lucía Martín',
    );
    expect(input.text).toContain('ceramica.didacta.io');
    expect(input.text).toContain('Lucía Martín <lucia@example.com>');
    expect(input.attachments).toEqual([
      { filename: 'pantalla.webp', content: PNG, contentType: 'image/webp' },
    ]);
    expect(nombre).toBe('Didacta soporte');
    expect(error).not.toHaveBeenCalled();
  });

  it('sin captura no adjunta nada', async () => {
    await notifier().avisar({ ...AVISO, tieneCaptura: false, captura: null });
    expect(send.mock.calls[0]![1]).not.toHaveProperty('attachments');
  });

  it('un correo de creador que no es una dirección limpia no se usa como Reply-To', async () => {
    await notifier({
      prisma: {
        tenant: { findUnique: vi.fn(async () => ({ name: 'A' })) },
        user: {
          findFirst: vi.fn(async () => ({ email: 'mala, dirección@x.com', name: 'X' })),
        },
      },
    }).avisar(AVISO);
    const [config, input] = send.mock.calls[0]!;
    expect(config).toBe(GLOBAL.config);
    expect(input.text).toContain('No se pudo leer su correo');
  });

  it('sale aunque el aula no tenga SMTP propio (control: no se pregunta por el del aula)', async () => {
    resolve.mockResolvedValue(null);
    await notifier().avisar(AVISO);
    expect(send).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('un despliegue sin SMTP de plataforma usa el del aula, también con Reply-To', async () => {
    resolveGlobal.mockReturnValue(null);
    await notifier().avisar(AVISO);
    expect(send.mock.calls[0]![0]).toEqual({
      ...DEL_AULA.config,
      sender: { replyTo: 'lucia@example.com' },
    });
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
    const [config, input] = send.mock.calls[0]!;
    expect(config).toBe(GLOBAL.config);
    expect(input.subject).toContain('tenant-1');
    expect(input.text).toContain('Lucía Martín');
    expect(input.text).toContain('(sin dominio)');
  });
});
