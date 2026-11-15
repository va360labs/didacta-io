/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { HttpStatus } from '@nestjs/common';
import {
  CapturaInvalidaError,
  LimiteDiarioError,
  SinPermisoError,
  SOPORTE_ERROR_CODES,
  TextoInvalidoError,
  TicketNoEncontradoError,
} from '@didacta/mod-soporte';
import { describe, expect, it, vi } from 'vitest';
import type { SessionClaims } from '../src/auth/token.service';
import { NEVER_BLOCKED } from '../src/moderation/restriction-scopes';
import { SoporteErrorFilter, STATUS_BY_CODE } from '../src/modules/soporte/soporte-error.filter';
import {
  actualizarTicketSchema,
  crearTicketSchema,
} from '../src/modules/soporte/soporte.controller';
import {
  buildCapturaStorage,
  callerDe,
  capturaDisposition,
  CAPTURA_RESPONSE_HEADERS,
  prismaSoporteAdminIds,
  resolverAutorTicket,
} from '../src/modules/soporte/soporte.ports';

const claims = (roles: string[]): SessionClaims =>
  ({ sub: 'u1', tenantId: 't1', roles }) as unknown as SessionClaims;

describe('callerDe: solo super_admin y tenant_admin administran el soporte', () => {
  it.each([
    [['super_admin'], true],
    [['tenant_admin'], true],
    [['formador'], false],
    [['moderador'], false],
    [['alumno'], false],
    [[], false],
  ])('roles %j → esAdmin %s', (roles, esAdmin) => {
    expect(callerDe(claims(roles))).toEqual({ id: 'u1', esAdmin });
  });
});

describe('prismaSoporteAdminIds', () => {
  it('pide las cuentas activas y no borradas del aula con rol de administración', async () => {
    const findMany = vi.fn(async () => [{ id: 'a1' }, { id: 'a2' }]);
    const ids = await prismaSoporteAdminIds({ user: { findMany } } as never)('t1');
    expect(ids).toEqual(['a1', 'a2']);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 't1',
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: ['super_admin', 'tenant_admin'] } } } },
      },
      select: { id: true },
    });
  });
});

describe('resolverAutorTicket', () => {
  it('usa el nombre de la cuenta del aula, nunca el email', async () => {
    const findFirst = vi.fn(async () => ({ name: '  Ana López ' }));
    const autor = await resolverAutorTicket({ user: { findFirst } } as never, 't1', 'u1');
    expect(autor).toEqual({ id: 'u1', nombre: 'Ana López' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'u1', tenantId: 't1', deletedAt: null },
      select: { name: true },
    });
  });

  it('sin nombre lo deja vacío (la palabra «miembro» la pone cada idioma)', async () => {
    const findFirst = vi.fn(async () => ({ name: null }));
    expect(await resolverAutorTicket({ user: { findFirst } } as never, 't1', 'u1')).toEqual({
      id: 'u1',
      nombre: '',
    });
  });
});

describe('buildCapturaStorage', () => {
  it('sube con uploadImage y devuelve la clave y el tipo reales del storage del aula', async () => {
    const uploadImage = vi.fn(async () => ({
      key: 'k.webp',
      contentType: 'image/webp',
      size: 3,
      optimized: true,
      previousSize: 9,
    }));
    const download = vi.fn(async () => Buffer.from('abc'));
    const storageFor = vi.fn(async () => ({ uploadImage, download }) as never);
    const storage = buildCapturaStorage(storageFor);
    expect(await storage.putImage('t1', 'k.png', Buffer.from('x'), 'image/png')).toEqual({
      key: 'k.webp',
      contentType: 'image/webp',
      size: 3,
    });
    expect(storageFor).toHaveBeenCalledWith('t1');
    expect((await storage.get('t1', 'k.webp')).toString()).toBe('abc');
  });
});

describe('respuesta de la captura', () => {
  it('inline, con nombre ASCII de respaldo y UTF-8', () => {
    expect(capturaDisposition('pantallá 1.webp')).toBe(
      'inline; filename="pantall__1.webp"; filename*=UTF-8\'\'pantall%C3%A1%201.webp',
    );
  });

  it('nosniff, sin caché compartida y en sandbox si se abre suelta', () => {
    expect(CAPTURA_RESPONSE_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
    });
  });
});

describe('SoporteErrorFilter', () => {
  function responder(error: Error) {
    const send = vi.fn();
    const reply = { status: vi.fn(() => ({ send })) };
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => reply }),
    };
    new SoporteErrorFilter().catch(error as never, host as never);
    return { status: reply.status.mock.calls[0]![0], body: send.mock.calls[0]![0] };
  }

  it.each([
    [new LimiteDiarioError(5), HttpStatus.TOO_MANY_REQUESTS, 'SOPORTE_LIMITE_DIARIO'],
    [new TextoInvalidoError('TEXTO_CORTO'), HttpStatus.BAD_REQUEST, 'SOPORTE_TEXTO_CORTO'],
    [new TextoInvalidoError('SIN_CAMBIOS'), HttpStatus.BAD_REQUEST, 'SOPORTE_SIN_CAMBIOS'],
    [new CapturaInvalidaError('NO_CASA'), HttpStatus.BAD_REQUEST, 'SOPORTE_CAPTURA_NO_CASA'],
    [new CapturaInvalidaError('PESADA'), HttpStatus.BAD_REQUEST, 'SOPORTE_CAPTURA_PESADA'],
    [new TicketNoEncontradoError(), HttpStatus.NOT_FOUND, 'SOPORTE_NO_ENCONTRADO'],
    [new SinPermisoError(), HttpStatus.FORBIDDEN, 'SOPORTE_SIN_PERMISO'],
  ])('%s → %i con { statusCode, code, message }', (error, status, code) => {
    const r = responder(error);
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ statusCode: status, code, message: error.message });
  });

  it('todo code que puede dar el módulo tiene su status (y ninguno sobra)', () => {
    expect(Object.keys(STATUS_BY_CODE).sort()).toEqual([...SOPORTE_ERROR_CODES].sort());
  });
});

describe('forma del cuerpo', () => {
  it('crear: solo los tres tipos; texto corto lo deja pasar para que lo rechace el servicio', () => {
    expect(crearTicketSchema.safeParse({ tipo: 'OTRO', texto: 'hola hola' }).success).toBe(false);
    expect(crearTicketSchema.safeParse({ tipo: 'MEJORA', texto: 'ab' }).success).toBe(true);
  });

  it('crear: una captura enorme se corta antes de decodificarla', () => {
    const enorme = 'A'.repeat(9 * 1024 * 1024);
    expect(
      crearTicketSchema.safeParse({
        tipo: 'FALLO',
        texto: 'hola hola',
        captura: { data: enorme, filename: 'a.png', contentType: 'image/png' },
      }).success,
    ).toBe(false);
  });

  it('actualizar: hace falta el estado o la nota, y el estado es uno de los cuatro', () => {
    expect(actualizarTicketSchema.safeParse({}).success).toBe(false);
    expect(actualizarTicketSchema.safeParse({ estado: 'CERRADO' }).success).toBe(false);
    expect(actualizarTicketSchema.safeParse({ estado: 'EN_CURSO' }).success).toBe(true);
    expect(actualizarTicketSchema.safeParse({ notaInterna: null }).success).toBe(true);
  });
});

describe('sanciones', () => {
  it('abrir un ticket nunca se bloquea por una sanción', () => {
    expect(NEVER_BLOCKED.some((r) => r.pattern.test('/modules/soporte/tickets'))).toBe(true);
  });
});
