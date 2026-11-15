/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapturaInvalidaError,
  LimiteDiarioError,
  SinPermisoError,
  SOPORTE_ERROR_CODES,
  TextoInvalidoError,
  TicketNoEncontradoError,
} from '../src/errors';
import {
  LIMITES,
  PLANTILLA_TICKET_ESTADO,
  PLANTILLA_TICKET_NUEVO,
  SoporteService,
  marcasEstado,
  marcasTipo,
  type AutorTicket,
  type AvisoOperadorTicket,
  type Caller,
  type SoporteCapturaStorage,
  type SoportePorts,
  type TicketInput,
} from '../src/soporte.service';
import { fakePrisma, type FakePrisma } from './fake-prisma';

const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';
const HORA = 3600 * 1000;
const AHORA = new Date('2026-11-12T10:00:00.000Z');
const mas = (horas: number) => new Date(AHORA.getTime() + horas * HORA);

const ana: AutorTicket = { id: '11111111-1111-4111-8111-111111111111', nombre: 'Ana' };
const beto: AutorTicket = { id: '22222222-2222-4222-8222-222222222222', nombre: 'Beto' };
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN2_ID = '55555555-5555-4555-8555-555555555555';
const admin: Caller = { id: ADMIN_ID, esAdmin: true };
const comoMiembro = (a: AutorTicket): Caller => ({ id: a.id, esAdmin: false });

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('resto de la imagen'),
]);

const base: TicketInput = {
  tipo: 'FALLO',
  texto: '  El botón de guardar no hace nada.  ',
  contexto: {
    url: 'https://aula.example.test/courses/1',
    userAgent: 'Mozilla/5.0',
    viewport: '1280x720',
    at: '2026-11-12T09:59:00.000Z',
  },
};

interface Envio {
  tenantId: string;
  channel: string;
  templateKey: string;
  to: string;
  locale?: string;
  variables: Record<string, unknown>;
}

let db: FakePrisma;
let envios: Envio[];
let eventos: Array<{ name: string; data: unknown; tenantId: string }>;
let guardadas: Map<string, Buffer>;
let storage: SoporteCapturaStorage;
let admins: Record<string, string[]>;
let operador: AvisoOperadorTicket[];
let segundoPlano: string[];
let send: ReturnType<typeof vi.fn>;
let avisarOperador: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;
let error: ReturnType<typeof vi.fn>;
let svc: SoporteService;

function construir(ports: Partial<SoportePorts> = {}) {
  return new SoporteService(
    db as never,
    {
      adminIds: async (t) => admins[t] ?? [],
      storage,
      webBaseUrl: async (t) => (t === T1 ? 'https://aula-uno.didacta.io/' : ''),
      avisarOperador: avisarOperador as never,
      enSegundoPlano: async (tenantId, tarea) => {
        segundoPlano.push(tenantId);
        await tarea();
      },
      ...ports,
    },
    {
      notificationHub: { send } as never,
      logger: { warn, error, info: vi.fn(), debug: vi.fn() } as never,
      eventBus: {
        publish: vi.fn(
          async (e: { name: string; data: unknown; metadata: { tenantId: string } }) => {
            eventos.push({ name: e.name, data: e.data, tenantId: e.metadata.tenantId });
          },
        ),
      } as never,
    },
  );
}

beforeEach(() => {
  db = fakePrisma();
  envios = [];
  eventos = [];
  operador = [];
  segundoPlano = [];
  guardadas = new Map();
  admins = { [T1]: [ADMIN_ID, ADMIN2_ID], [T2]: [] };
  storage = {
    putImage: vi.fn(async (_t: string, key: string, data: Buffer) => {
      // Como el storage real: recomprime a WebP y cambia la extensión.
      const real = key.replace(/\.\w+$/, '.webp');
      guardadas.set(real, data);
      return { key: real, contentType: 'image/webp', size: data.length };
    }),
    get: vi.fn(async (_t: string, key: string) => {
      const data = guardadas.get(key);
      if (!data) throw new Error('no existe');
      return data;
    }),
  };
  send = vi.fn(async (n: Envio) => {
    envios.push(n);
  });
  avisarOperador = vi.fn(async (a: AvisoOperadorTicket) => {
    operador.push(a);
  });
  warn = vi.fn();
  error = vi.fn();
  svc = construir();
});

async function crear(autor = ana, input: Partial<TicketInput> = {}, tenant = T1, now = AHORA) {
  return svc.crear(tenant, autor, { ...base, ...input }, now);
}

/** Crea y espera a que salgan los avisos de fondo. */
async function crearYAvisar(...args: Parameters<typeof crear>) {
  const t = await crear(...args);
  await svc.esperarAvisos();
  return t;
}

describe('crear', () => {
  it('guarda el ticket NUEVO con el texto recortado, el contexto y la copia del autor', async () => {
    const t = await crear();
    expect(t).toEqual({
      id: expect.any(String),
      tipo: 'FALLO',
      texto: 'El botón de guardar no hace nada.',
      estado: 'NUEVO',
      tieneCaptura: false,
      createdAt: AHORA.toISOString(),
      updatedAt: expect.any(String),
      closedAt: null,
    });
    expect(db.tickets[0]).toMatchObject({
      id: t.id,
      tenantId: T1,
      autorId: ana.id,
      autorNombre: 'Ana',
      contextoUrl: 'https://aula.example.test/courses/1',
      contextoUserAgent: 'Mozilla/5.0',
      contextoViewport: '1280x720',
      contextoAt: new Date('2026-11-12T09:59:00.000Z'),
      capturaKey: null,
      notaInterna: null,
    });
    expect(storage.putImage).not.toHaveBeenCalled();
  });

  it('sin nombre de cuenta lo guarda vacío, sin una palabra en español', async () => {
    await crear({ id: ana.id, nombre: '   ' });
    expect(db.tickets[0]).toMatchObject({ autorNombre: '' });
  });

  it('sin contexto guarda todo a null', async () => {
    await crear(ana, { contexto: undefined });
    expect(db.tickets[0]).toMatchObject({
      contextoUrl: null,
      contextoUserAgent: null,
      contextoViewport: null,
      contextoAt: null,
    });
  });

  it('recorta el contexto a sus límites y descarta una fecha que no es ISO', async () => {
    await crear(ana, {
      contexto: { url: 'x'.repeat(900), viewport: '9'.repeat(40), at: 'ayer' },
    });
    const row = db.tickets[0]!;
    expect((row['contextoUrl'] as string).length).toBe(LIMITES.contextoUrl);
    expect((row['contextoViewport'] as string).length).toBe(LIMITES.contextoViewport);
    expect(row['contextoAt']).toBeNull();
  });

  it('con captura la guarda en el storage del aula bajo la clave del ticket', async () => {
    const t = await crear(ana, {
      captura: { data: PNG.toString('base64'), filename: 'pantalla.png', contentType: 'image/png' },
    });
    expect(t.tieneCaptura).toBe(true);
    const [tenant, key, data, contentType] = (storage.putImage as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(tenant).toBe(T1);
    expect(key).toMatch(new RegExp(`^tenants/${T1}/soporte/${t.id}/[0-9a-f-]{36}\\.png$`));
    expect(Buffer.compare(data as Buffer, PNG)).toBe(0);
    expect(contentType).toBe('image/png');
    expect(db.tickets[0]).toMatchObject({
      capturaKey: (key as string).replace(/\.png$/, '.webp'),
      capturaContentType: 'image/webp',
      capturaNombre: 'pantalla.webp',
      capturaSize: PNG.length,
    });
  });

  it.each([
    ['vacío', '', 'SOPORTE_TEXTO_CORTO'],
    ['solo espacios', '      ', 'SOPORTE_TEXTO_CORTO'],
    ['de 4 caracteres', 'abcd', 'SOPORTE_TEXTO_CORTO'],
    ['de más de 4000', 'x'.repeat(4001), 'SOPORTE_TEXTO_LARGO'],
  ])('rechaza un texto %s con %s', async (_caso, texto, code) => {
    await expect(crear(ana, { texto })).rejects.toBeInstanceOf(TextoInvalidoError);
    await expect(crear(ana, { texto })).rejects.toMatchObject({ code });
    expect(db.tickets).toHaveLength(0);
  });

  it('rechaza un tipo que no existe con SOPORTE_TIPO_INVALIDO', async () => {
    await expect(crear(ana, { tipo: 'QUEJA' as never })).rejects.toMatchObject({
      code: 'SOPORTE_TIPO_INVALIDO',
    });
  });

  it('admite exactamente 5 y exactamente 4000 caracteres', async () => {
    await crear(ana, { texto: 'abcde' });
    await crear(ana, { texto: 'y'.repeat(4000) });
    expect(db.tickets).toHaveLength(2);
  });

  it.each([
    ['un tipo no admitido', { contentType: 'image/gif' }, 'SOPORTE_CAPTURA_TIPO'],
    ['un SVG (puede llevar código)', { contentType: 'image/svg+xml' }, 'SOPORTE_CAPTURA_TIPO'],
    [
      'bytes que no casan con el tipo',
      { data: Buffer.from('<html>hola</html>').toString('base64') },
      'SOPORTE_CAPTURA_NO_CASA',
    ],
    [
      'un JPEG que dice ser PNG',
      { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64') },
      'SOPORTE_CAPTURA_NO_CASA',
    ],
    ['un base64 roto', { data: '***no base64***' }, 'SOPORTE_CAPTURA_ILEGIBLE'],
    ['una imagen vacía', { data: '' }, 'SOPORTE_CAPTURA_VACIA'],
  ])('rechaza una captura con %s', async (_caso, cambio, code) => {
    const captura = {
      data: PNG.toString('base64'),
      filename: 'a.png',
      contentType: 'image/png',
      ...cambio,
    };
    await expect(crear(ana, { captura: captura as never })).rejects.toBeInstanceOf(
      CapturaInvalidaError,
    );
    await expect(crear(ana, { captura: captura as never })).rejects.toMatchObject({ code });
    expect(db.tickets).toHaveLength(0);
    expect(storage.putImage).not.toHaveBeenCalled();
  });

  it('rechaza una captura de más de 5 MB y admite una de 5 MB justos', async () => {
    const justo = Buffer.alloc(LIMITES.capturaBytes);
    PNG.copy(justo);
    const grande = Buffer.alloc(LIMITES.capturaBytes + 1);
    PNG.copy(grande);
    const img = (b: Buffer) => ({
      data: b.toString('base64'),
      filename: 'a.png',
      contentType: 'image/png' as const,
    });
    await expect(crear(ana, { captura: img(grande) })).rejects.toMatchObject({
      code: 'SOPORTE_CAPTURA_PESADA',
    });
    await expect(crear(ana, { captura: img(justo) })).resolves.toMatchObject({
      tieneCaptura: true,
    });
  });

  it('el nombre de la captura se sanea: sin ruta ni caracteres que den la vuelta al texto', async () => {
    await crear(ana, {
      captura: {
        data: PNG.toString('base64'),
        filename: 'C:\\Users\\ana\\cap\u202Egnp.exe',
        contentType: 'image/png',
      },
    });
    expect(db.tickets[0]!['capturaNombre']).toBe('capgnp.webp');
  });

  it('si el storage falla, el ticket se guarda sin captura y se avisa en el log', async () => {
    (storage.putImage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('S3 caído'));
    const t = await crear(ana, {
      captura: { data: PNG.toString('base64'), filename: 'a.png', contentType: 'image/png' },
    });
    expect(t.tieneCaptura).toBe(false);
    expect(db.tickets).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe('límite diario', () => {
  it('el 5.º ticket entra y el 6.º da SOPORTE_LIMITE_DIARIO', async () => {
    for (let i = 0; i < 5; i++) await crear(ana, {}, T1, mas(i));
    await expect(crear(ana, {}, T1, mas(5))).rejects.toBeInstanceOf(LimiteDiarioError);
    await expect(crear(ana, {}, T1, mas(5))).rejects.toMatchObject({
      code: 'SOPORTE_LIMITE_DIARIO',
    });
    expect(db.tickets).toHaveLength(5);
  });

  it('no afecta a otra persona ni a la misma persona en otra aula', async () => {
    for (let i = 0; i < 5; i++) await crear(ana);
    await expect(crear(beto)).resolves.toBeDefined();
    await expect(crear(ana, {}, T2)).resolves.toBeDefined();
  });

  it('cuenta solo las últimas 24 horas', async () => {
    for (let i = 0; i < 5; i++) await crear(ana, {}, T1, AHORA);
    // Justo a las 24 h el primero todavía cuenta; un instante después ya no.
    await expect(crear(ana, {}, T1, mas(24))).rejects.toBeInstanceOf(LimiteDiarioError);
    await expect(crear(ana, {}, T1, new Date(mas(24).getTime() + 1))).resolves.toBeDefined();
  });

  it('se comprueba antes de guardar la captura', async () => {
    for (let i = 0; i < 5; i++) await crear(ana);
    await expect(
      crear(ana, {
        captura: { data: PNG.toString('base64'), filename: 'a.png', contentType: 'image/png' },
      }),
    ).rejects.toBeInstanceOf(LimiteDiarioError);
    expect(storage.putImage).not.toHaveBeenCalled();
  });
});

describe('límite diario con peticiones a la vez (candado)', () => {
  it('toma el candado de aula + autor dentro de la transacción, antes de contar y crear', async () => {
    await crear();
    expect(db.ops.slice(0, 5)).toEqual(['begin', 'lock', 'count', 'create', 'commit']);
    expect(db.raws).toHaveLength(1);
    expect(db.raws[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1::text\)\)/);
    // Los valores van ligados, nunca pegados al SQL.
    expect(db.raws[0]!.sql).not.toContain(T1);
    expect(db.raws[0]!.values).toEqual([`${T1}:${ana.id}`]);
  });

  it('cada persona y aula tiene su propio candado', async () => {
    await crear(ana, {}, T1);
    await crear(beto, {}, T1);
    await crear(ana, {}, T2);
    expect(db.raws.map((r) => r.values[0])).toEqual([
      `${T1}:${ana.id}`,
      `${T1}:${beto.id}`,
      `${T2}:${ana.id}`,
    ]);
  });

  it('el 6.º sigue rechazado y no llega a crear nada', async () => {
    for (let i = 0; i < 5; i++) await crear(ana);
    db.ops.length = 0;
    await expect(crear(ana)).rejects.toBeInstanceOf(LimiteDiarioError);
    expect(db.ops).toEqual(['begin', 'lock', 'count']);
    expect(db.tickets).toHaveLength(5);
  });
});

describe('captura después de guardar el ticket', () => {
  const conCaptura = {
    captura: { data: PNG.toString('base64'), filename: 'pantalla.png', contentType: 'image/png' },
  };

  it('se sube solo cuando la fila ya existe y su clave se guarda en ella', async () => {
    let filasAlSubir = -1;
    let commitAntes = false;
    (storage.putImage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_t: string, key: string, data: Buffer) => {
        filasAlSubir = db.tickets.length;
        commitAntes = db.ops.includes('commit');
        const real = key.replace(/\.\w+$/, '.webp');
        guardadas.set(real, data);
        return { key: real, contentType: 'image/webp', size: data.length };
      },
    );
    const t = await crear(ana, conCaptura);
    expect(filasAlSubir).toBe(1);
    expect(commitAntes).toBe(true);
    expect(db.ops.indexOf('updateMany')).toBeGreaterThan(db.ops.indexOf('commit'));
    expect(db.tickets[0]).toMatchObject({
      id: t.id,
      capturaKey: expect.stringMatching(new RegExp(`^tenants/${T1}/soporte/${t.id}/.+\\.webp$`)),
      capturaContentType: 'image/webp',
      capturaNombre: 'pantalla.webp',
      capturaSize: PNG.length,
    });
    expect(t.tieneCaptura).toBe(true);
    expect(await svc.mios(T1, ana.id)).toMatchObject([{ id: t.id, tieneCaptura: true }]);
  });

  it('si la subida falla, el ticket queda guardado sin captura', async () => {
    (storage.putImage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('S3 caído'));
    const t = await crear(ana, conCaptura);
    expect(t.tieneCaptura).toBe(false);
    expect(db.tickets).toHaveLength(1);
    expect(db.tickets[0]).toMatchObject({ id: t.id, capturaKey: null });
    expect(db.ops).not.toContain('updateMany');
    expect(warn).toHaveBeenCalled();
  });

  it('una captura no válida se rechaza antes de abrir la transacción', async () => {
    await expect(
      crear(ana, { captura: { ...conCaptura.captura, contentType: 'image/gif' } }),
    ).rejects.toBeInstanceOf(CapturaInvalidaError);
    expect(db.ops).toEqual([]);
  });
});

describe('avisos al equipo del aula al crear', () => {
  it('avisa a cada administrador del aula en la campana y por correo', async () => {
    const t = await crearYAvisar();
    const nuevos = envios.filter((e) => e.templateKey === PLANTILLA_TICKET_NUEVO);
    expect(nuevos.map((e) => `${e.to}:${e.channel}`).sort()).toEqual(
      [
        `${ADMIN_ID}:email`,
        `${ADMIN_ID}:in-app`,
        `${ADMIN2_ID}:email`,
        `${ADMIN2_ID}:in-app`,
      ].sort(),
    );
    expect(nuevos.every((e) => e.tenantId === T1)).toBe(true);
    expect(nuevos[0]!.variables).toEqual({
      ticketId: t.id,
      autorNombre: 'Ana',
      extracto: 'El botón de guardar no hace nada.',
      esFallo: true,
      esProblema: false,
      esMejora: false,
      ticketUrl: `https://aula-uno.didacta.io/admin/support?ticket=${t.id}`,
    });
  });

  it('ni un texto en español ni un idioma fijo: el hub escribe a cada uno en el suyo', async () => {
    await crearYAvisar(ana, { tipo: 'MEJORA' });
    for (const e of envios) {
      expect(e).not.toHaveProperty('locale');
      expect(Object.values(e.variables)).not.toContain('Tengo una sugerencia');
    }
    expect(envios[0]!.variables).toMatchObject({ esMejora: true, esFallo: false });
  });

  it('sin dirección del aula el correo va sin enlace directo (la campana enlaza por ticketId)', async () => {
    admins[T2] = [ADMIN_ID];
    await crearYAvisar(ana, {}, T2);
    expect(envios[0]!.variables['ticketUrl']).toBe('');
    expect(envios[0]!.variables['ticketId']).toEqual(expect.any(String));
  });

  it('el extracto del aviso es corto', async () => {
    await crearYAvisar(ana, { texto: 'z'.repeat(1000) });
    const extracto = envios[0]!.variables['extracto'] as string;
    expect(extracto.length).toBeLessThanOrEqual(LIMITES.extracto + 1);
    expect(extracto.endsWith('…')).toBe(true);
  });

  it('no se avisa a sí mismo un administrador que abre un ticket', async () => {
    await crearYAvisar({ id: ADMIN_ID, nombre: 'Admin' });
    expect(new Set(envios.map((e) => e.to))).toEqual(new Set([ADMIN2_ID]));
  });

  it('solo avisa al equipo del aula del ticket', async () => {
    await crearYAvisar(ana, {}, T2);
    expect(envios).toHaveLength(0);
  });

  it('un fallo del hub o de la lista de administradores no impide crear el ticket', async () => {
    send.mockRejectedValue(new Error('SMTP caído'));
    await expect(crearYAvisar()).resolves.toMatchObject({ estado: 'NUEVO' });
    expect(warn).toHaveBeenCalled();

    const roto = construir({
      adminIds: async () => {
        throw new Error('BD caída');
      },
    });
    await expect(roto.crear(T1, beto, base, AHORA)).resolves.toBeDefined();
    await roto.esperarAvisos();
    expect(db.tickets).toHaveLength(2);
  });

  it('publica soporte.ticket.created sin el texto', async () => {
    const t = await crear();
    expect(eventos).toEqual([
      {
        name: 'soporte.ticket.created',
        tenantId: T1,
        data: { ticketId: t.id, autorId: ana.id, tipo: 'FALLO' },
      },
    ]);
  });
});

describe('en segundo plano: el miembro no espera al correo', () => {
  it('crear responde aunque el correo no haya salido todavía', async () => {
    let soltar!: () => void;
    const atascado = new Promise<void>((r) => {
      soltar = r;
    });
    send.mockImplementation(async (n: Envio) => {
      await atascado;
      envios.push(n);
    });
    avisarOperador.mockImplementation(async () => {
      await atascado;
    });
    const t = await crear();
    // El ticket ya está guardado y devuelto; los avisos siguen en vuelo.
    expect(db.tickets).toHaveLength(1);
    expect(t.estado).toBe('NUEVO');
    expect(envios).toHaveLength(0);
    soltar();
    await svc.esperarAvisos();
    expect(envios).toHaveLength(4);
  });

  it('los avisos corren con el contexto del aula (puerto enSegundoPlano)', async () => {
    await crearYAvisar(ana, {}, T1);
    expect(segundoPlano).toEqual([T1]);
  });

  it('si la tarea de fondo revienta entera, queda en el log de error y no llega a nadie', async () => {
    const roto = construir({
      enSegundoPlano: async () => {
        throw new Error('sin conexión');
      },
    });
    await expect(roto.crear(T1, ana, base, AHORA)).resolves.toMatchObject({ estado: 'NUEVO' });
    await roto.esperarAvisos();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('aviso de fondo'),
      expect.objectContaining({ tenantId: T1, error: 'sin conexión' }),
    );
  });

  it('esperarAvisos no se queda colgado más del tiempo dado', async () => {
    send.mockImplementation(() => new Promise<void>(() => undefined));
    await crear();
    const antes = Date.now();
    await svc.esperarAvisos(30);
    expect(Date.now() - antes).toBeLessThan(1000);
  });
});

describe('aviso inmediato al operador de la plataforma', () => {
  it('cada ticket nuevo le llega con el texto entero, el autor y si trae captura', async () => {
    const largo = `Empieza aquí. ${'detalle '.repeat(60)}y termina aquí.`;
    const t = await crearYAvisar(ana, {
      tipo: 'PROBLEMA',
      texto: largo,
      captura: { data: PNG.toString('base64'), filename: 'a.png', contentType: 'image/png' },
    });
    expect(operador).toEqual([
      {
        tenantId: T1,
        ticketId: t.id,
        tipo: 'PROBLEMA',
        texto: largo.trim(),
        autorId: ana.id,
        autorNombre: 'Ana',
        tieneCaptura: true,
        createdAt: AHORA,
      },
    ]);
  });

  it('también cuando el aula no tiene a nadie a quien avisar', async () => {
    await crearYAvisar(ana, {}, T2);
    expect(envios).toHaveLength(0);
    expect(operador).toHaveLength(1);
    expect(operador[0]).toMatchObject({ tenantId: T2, tieneCaptura: false });
  });

  it('sin puerto (Community sin operador) no se avisa a nadie de fuera', async () => {
    const sinOperador = construir({ avisarOperador: undefined });
    await sinOperador.crear(T1, ana, base, AHORA);
    await sinOperador.esperarAvisos();
    expect(operador).toHaveLength(0);
    expect(envios).toHaveLength(4);
  });

  it('si falla, queda en el log con nivel de error y el equipo sí recibe su aviso', async () => {
    avisarOperador.mockRejectedValue(new Error('SMTP de la plataforma caído'));
    const t = await crearYAvisar();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('operador'),
      expect.objectContaining({ ticketId: t.id, error: 'SMTP de la plataforma caído' }),
    );
    expect(envios.filter((e) => e.templateKey === PLANTILLA_TICKET_NUEVO)).toHaveLength(4);
    expect(db.tickets).toHaveLength(1);
  });

  it('un ticket rechazado (límite diario) no avisa al operador', async () => {
    for (let i = 0; i < 5; i++) await crear(ana);
    await svc.esperarAvisos();
    operador.length = 0;
    await expect(crear(ana)).rejects.toBeInstanceOf(LimiteDiarioError);
    await svc.esperarAvisos();
    expect(operador).toHaveLength(0);
  });
});

describe('mios', () => {
  it('solo los míos, del más nuevo al más antiguo, sin la nota interna', async () => {
    const a1 = await crear(ana, {}, T1, mas(0));
    await crear(beto, {}, T1, mas(1));
    const a2 = await crear(ana, { tipo: 'MEJORA' }, T1, mas(2));
    await crear(ana, {}, T2, mas(3));
    await svc.actualizarAdmin(T1, admin, a1.id, { notaInterna: 'Es un duplicado' }, mas(4));

    const lista = await svc.mios(T1, ana.id);
    expect(lista.map((t) => t.id)).toEqual([a2.id, a1.id]);
    for (const t of lista) {
      expect(t).not.toHaveProperty('notaInterna');
      expect(t).not.toHaveProperty('autorId');
      expect(t).not.toHaveProperty('contexto');
    }
    expect(JSON.stringify(lista)).not.toContain('duplicado');
  });
});

describe('bandeja del equipo', () => {
  it('quien no administra no puede listar, ver ni cambiar', async () => {
    const t = await crear();
    const miembro = comoMiembro(ana);
    await expect(svc.listarAdmin(T1, miembro, {})).rejects.toBeInstanceOf(SinPermisoError);
    await expect(svc.obtenerAdmin(T1, miembro, t.id)).rejects.toMatchObject({
      code: 'SOPORTE_SIN_PERMISO',
    });
    await expect(
      svc.actualizarAdmin(T1, miembro, t.id, { estado: 'RESUELTO' }, AHORA),
    ).rejects.toBeInstanceOf(SinPermisoError);
    expect(db.tickets[0]!['estado']).toBe('NUEVO');
  });

  it('lista con filtros, del más nuevo al más antiguo, y cuenta por estado sin filtros', async () => {
    const f1 = await crear(ana, { tipo: 'FALLO' }, T1, mas(0));
    const m1 = await crear(beto, { tipo: 'MEJORA' }, T1, mas(1));
    const f2 = await crear(beto, { tipo: 'FALLO' }, T1, mas(2));
    await crear(ana, {}, T2, mas(3));
    await svc.actualizarAdmin(T1, admin, f1.id, { estado: 'RESUELTO' }, mas(4));
    await svc.actualizarAdmin(T1, admin, m1.id, { estado: 'EN_CURSO' }, mas(4));

    const todo = await svc.listarAdmin(T1, admin, {});
    expect(todo.items.map((t) => t.id)).toEqual([f2.id, m1.id, f1.id]);
    expect(todo.counts).toEqual({ NUEVO: 1, EN_CURSO: 1, RESUELTO: 1, DESCARTADO: 0 });

    const fallos = await svc.listarAdmin(T1, admin, { tipo: 'FALLO' });
    expect(fallos.items.map((t) => t.id)).toEqual([f2.id, f1.id]);
    expect(fallos.counts).toEqual(todo.counts);

    const resueltos = await svc.listarAdmin(T1, admin, { estado: 'RESUELTO', tipo: 'FALLO' });
    expect(resueltos.items.map((t) => t.id)).toEqual([f1.id]);

    // Un filtro desconocido no filtra.
    const raro = await svc.listarAdmin(T1, admin, { estado: 'ROTO' as never });
    expect(raro.items).toHaveLength(3);
  });

  it('la lista se corta en 200', async () => {
    // Directo a la tabla: por la API el límite diario no deja crear tantos.
    for (let i = 0; i < 205; i++) {
      await db.modSoporteTicket.create({
        data: {
          tenantId: T1,
          autorId: ana.id,
          autorNombre: 'Ana',
          tipo: 'FALLO',
          texto: `Ticket ${i}`,
          createdAt: mas(i),
        },
      });
    }
    const r = await svc.listarAdmin(T1, admin, {});
    expect(r.items).toHaveLength(LIMITES.listaAdmin);
    expect(r.counts.NUEVO).toBe(205);
  });

  it('la vista del equipo trae autor, contexto y nota interna', async () => {
    const t = await crear();
    const v = await svc.obtenerAdmin(T1, admin, t.id);
    expect(v).toMatchObject({
      id: t.id,
      autorId: ana.id,
      autorNombre: 'Ana',
      contexto: {
        url: 'https://aula.example.test/courses/1',
        userAgent: 'Mozilla/5.0',
        viewport: '1280x720',
        at: '2026-11-12T09:59:00.000Z',
      },
      notaInterna: null,
    });
  });

  it('un administrador de otra aula no ve el ticket', async () => {
    const t = await crear();
    await expect(svc.obtenerAdmin(T2, admin, t.id)).rejects.toBeInstanceOf(TicketNoEncontradoError);
    await expect(
      svc.actualizarAdmin(T2, admin, t.id, { estado: 'RESUELTO' }, AHORA),
    ).rejects.toMatchObject({ code: 'SOPORTE_NO_ENCONTRADO' });
    expect((await svc.listarAdmin(T2, admin, {})).items).toHaveLength(0);
    expect(db.tickets[0]!['estado']).toBe('NUEVO');
  });
});

describe('contador del menú', () => {
  it('cuenta los tickets nuevos del aula; los cogidos o cerrados no', async () => {
    const a = await crear(ana, {}, T1, mas(0));
    const b = await crear(beto, {}, T1, mas(1));
    await crear(beto, {}, T1, mas(2));
    await crear(ana, {}, T2, mas(3));
    expect(await svc.menuAdmin(T1, admin)).toEqual({ allowed: true, badge: 3 });

    await svc.actualizarAdmin(T1, admin, a.id, { estado: 'EN_CURSO' }, mas(4));
    await svc.actualizarAdmin(T1, admin, b.id, { estado: 'DESCARTADO' }, mas(4));
    expect(await svc.menuAdmin(T1, admin)).toEqual({ allowed: true, badge: 1 });
  });

  it('a quien no administra no le enseña la entrada ni le cuenta nada', async () => {
    await crear();
    expect(await svc.menuAdmin(T1, comoMiembro(ana))).toEqual({ allowed: false });
  });
});

describe('actualizarAdmin', () => {
  it('cerrar pone closedAt, reabrir lo limpia', async () => {
    const t = await crear();
    const r = await svc.actualizarAdmin(T1, admin, t.id, { estado: 'RESUELTO' }, mas(1));
    expect(r.estado).toBe('RESUELTO');
    expect(r.closedAt).toBe(mas(1).toISOString());
    const d = await svc.actualizarAdmin(T1, admin, t.id, { estado: 'DESCARTADO' }, mas(2));
    expect(d.closedAt).toBe(mas(2).toISOString());
    const e = await svc.actualizarAdmin(T1, admin, t.id, { estado: 'EN_CURSO' }, mas(3));
    expect(e.closedAt).toBeNull();
    const n = await svc.actualizarAdmin(T1, admin, t.id, { estado: 'NUEVO' }, mas(4));
    expect(n.closedAt).toBeNull();
  });

  it('avisa al autor solo cuando el estado cambia de verdad, y nunca con la nota', async () => {
    const t = await crearYAvisar();
    envios = [];
    send.mockClear();
    await svc.actualizarAdmin(
      T1,
      admin,
      t.id,
      { estado: 'EN_CURSO', notaInterna: 'Es cosa del navegador' },
      mas(1),
    );
    await svc.esperarAvisos();
    const avisos = () => envios.filter((e) => e.templateKey === PLANTILLA_TICKET_ESTADO);
    expect(
      avisos()
        .map((e) => `${e.to}:${e.channel}`)
        .sort(),
    ).toEqual([`${ana.id}:email`, `${ana.id}:in-app`].sort());
    expect(avisos()[0]!.variables).toEqual({
      ticketId: t.id,
      extracto: 'El botón de guardar no hace nada.',
      ...marcasTipo('FALLO'),
      ...marcasEstado('EN_CURSO'),
      ticketUrl: `https://aula-uno.didacta.io/support?ticket=${t.id}`,
    });
    expect(avisos()[0]!.variables).toMatchObject({ estadoEnCurso: true, estadoResuelto: false });
    expect(JSON.stringify(avisos())).not.toContain('navegador');

    await svc.actualizarAdmin(T1, admin, t.id, { estado: 'EN_CURSO' }, mas(2));
    await svc.actualizarAdmin(T1, admin, t.id, { notaInterna: 'Mirando' }, mas(3));
    await svc.esperarAvisos();
    expect(avisos()).toHaveLength(2);
  });

  it('el administrador que cambia su propio ticket no se avisa a sí mismo', async () => {
    const t = await crear({ id: ADMIN_ID, nombre: 'Admin' });
    await svc.esperarAvisos();
    envios = [];
    await svc.actualizarAdmin(T1, admin, t.id, { estado: 'RESUELTO' }, mas(1));
    await svc.esperarAvisos();
    expect(envios.filter((e) => e.templateKey === PLANTILLA_TICKET_ESTADO)).toHaveLength(0);
  });

  it('publica soporte.ticket.status_changed solo al cambiar el estado', async () => {
    const t = await crear();
    eventos = [];
    await svc.actualizarAdmin(T1, admin, t.id, { estado: 'RESUELTO' }, mas(1));
    await svc.actualizarAdmin(T1, admin, t.id, { estado: 'RESUELTO' }, mas(2));
    expect(eventos).toEqual([
      {
        name: 'soporte.ticket.status_changed',
        tenantId: T1,
        data: { ticketId: t.id, autorId: ana.id, estadoAnterior: 'NUEVO', estado: 'RESUELTO' },
      },
    ]);
  });

  it('un fallo al avisar no deshace el cambio de estado', async () => {
    const t = await crear();
    send.mockRejectedValue(new Error('SMTP caído'));
    const r = await svc.actualizarAdmin(T1, admin, t.id, { estado: 'RESUELTO' }, mas(1));
    await svc.esperarAvisos();
    expect(r.estado).toBe('RESUELTO');
    expect(db.tickets[0]!['estado']).toBe('RESUELTO');
  });

  it('guarda la nota interna recortada; null o vacía la borra', async () => {
    const t = await crear();
    const a = await svc.actualizarAdmin(
      T1,
      admin,
      t.id,
      { notaInterna: '  Duplicado de #3 ' },
      AHORA,
    );
    expect(a.notaInterna).toBe('Duplicado de #3');
    expect(a.estado).toBe('NUEVO');
    const b = await svc.actualizarAdmin(T1, admin, t.id, { notaInterna: null }, AHORA);
    expect(b.notaInterna).toBeNull();
    await svc.actualizarAdmin(T1, admin, t.id, { notaInterna: 'otra' }, AHORA);
    const c = await svc.actualizarAdmin(T1, admin, t.id, { notaInterna: '   ' }, AHORA);
    expect(c.notaInterna).toBeNull();
  });

  it.each([
    ['una nota de más de 4000 caracteres', { notaInterna: 'n'.repeat(4001) }, 'SOPORTE_NOTA_LARGA'],
    ['un cambio sin estado ni nota', {}, 'SOPORTE_SIN_CAMBIOS'],
    ['un estado que no existe', { estado: 'CERRADO' as never }, 'SOPORTE_ESTADO_INVALIDO'],
  ])('rechaza %s', async (_caso, cambios, code) => {
    const t = await crear();
    await expect(svc.actualizarAdmin(T1, admin, t.id, cambios, AHORA)).rejects.toBeInstanceOf(
      TextoInvalidoError,
    );
    await expect(svc.actualizarAdmin(T1, admin, t.id, cambios, AHORA)).rejects.toMatchObject({
      code,
    });
  });
});

describe('captura', () => {
  async function conCaptura(autor = ana) {
    return crear(autor, {
      captura: { data: PNG.toString('base64'), filename: 'pantalla.png', contentType: 'image/png' },
    });
  }

  it('la ve su autor y quien administra el aula', async () => {
    const t = await conCaptura();
    const propia = await svc.captura(T1, comoMiembro(ana), t.id);
    expect(Buffer.compare(propia.data, PNG)).toBe(0);
    expect(propia).toMatchObject({ contentType: 'image/webp', nombre: 'pantalla.webp' });
    await expect(svc.captura(T1, admin, t.id)).resolves.toBeDefined();
  });

  it('otro miembro, otra aula o un ticket sin captura dan 404', async () => {
    const t = await conCaptura();
    await expect(svc.captura(T1, comoMiembro(beto), t.id)).rejects.toBeInstanceOf(
      TicketNoEncontradoError,
    );
    await expect(svc.captura(T2, admin, t.id)).rejects.toBeInstanceOf(TicketNoEncontradoError);
    const sin = await crear(beto);
    await expect(svc.captura(T1, comoMiembro(beto), sin.id)).rejects.toBeInstanceOf(
      TicketNoEncontradoError,
    );
  });

  it('un archivo que ya no está en el storage da 404', async () => {
    const t = await conCaptura();
    guardadas.clear();
    await expect(svc.captura(T1, admin, t.id)).rejects.toBeInstanceOf(TicketNoEncontradoError);
  });
});

describe('codes de error', () => {
  it('son únicos y todos empiezan por SOPORTE_', () => {
    expect(new Set(SOPORTE_ERROR_CODES).size).toBe(SOPORTE_ERROR_CODES.length);
    for (const c of SOPORTE_ERROR_CODES) expect(c).toMatch(/^SOPORTE_[A-Z_]+$/);
  });
});
