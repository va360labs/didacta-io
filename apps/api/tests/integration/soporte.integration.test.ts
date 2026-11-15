/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * mod.soporte contra Postgres REAL conectando como `didacta_app` (NOSUPERUSER,
 * NOBYPASSRLS), con los puertos reales del host:
 *
 *  - la tabla tiene RLS forzada y un aula no ve ni toca los tickets de otra,
 *    ni pidiendo por id ni con una consulta sin filtro;
 *  - el tope de 5 tickets al día aguanta 8 envíos A LA VEZ de la misma
 *    persona (candado de verdad, `pg_advisory_xact_lock`): entran 5 justos;
 *  - el ticket de un alumno avisa en segundo plano, con el contexto del aula,
 *    a su equipo (lectura de `user` bajo RLS), no al operador ni a otra aula;
 *  - el de quien administra va al operador y no sale en la bandeja del aula;
 *  - la nota interna nunca llega a quien abrió el ticket.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  LimiteDiarioError,
  SoporteService,
  TicketNoEncontradoError,
  type AvisoOperadorTicket,
} from '@didacta/mod-soporte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaSoporteAdminIds } from '../../src/modules/soporte/soporte.ports';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('mod.soporte — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: SoporteService;
  const hub: Array<{ tenantId: string; to: string; channel: string; templateKey: string }> = [];
  const operador: AvisoOperadorTicket[] = [];
  const stamp = Date.now();
  const tenants: Record<'a' | 'b', string> = { a: '', b: '' };
  const users: Record<string, string> = {};

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    const previousUrl = process.env['DATABASE_URL'];
    const previousMode = process.env['RLS_ENFORCEMENT'];
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();
    } finally {
      process.env['DATABASE_URL'] = previousUrl;
      if (previousMode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previousMode;
    }

    for (const k of ['a', 'b'] as const) {
      tenants[k] = (
        await admin.tenant.create({
          data: { id: randomUUID(), slug: `sop-${k}-${stamp}`, name: `Aula ${k} ${stamp}` },
        })
      ).id;
    }
    const roles = Object.fromEntries(
      await Promise.all(
        ['tenant_admin', 'alumno'].map(async (name) => [
          name,
          (
            await admin.role.upsert({
              where: { name },
              create: { name, description: name, isSystem: true },
              update: {},
            })
          ).id,
        ]),
      ),
    ) as Record<string, string>;
    async function mkUser(key: string, tenantId: string, name: string, role: string) {
      const u = await admin.user.create({
        data: { tenantId, email: `${key}-${stamp}@example.com`, name, status: 'ACTIVE' },
      });
      users[key] = u.id;
      await admin.userRole.create({ data: { userId: u.id, roleId: roles[role]! } });
    }
    await mkUser('adminA', tenants.a, 'Lucía Admin', 'tenant_admin');
    await mkUser('anaA', tenants.a, 'Ana', 'alumno');
    await mkUser('adminB', tenants.b, 'Pablo Admin', 'tenant_admin');
    await mkUser('betoB', tenants.b, 'Beto', 'alumno');

    service = new SoporteService(
      prisma as never,
      {
        // El puerto REAL: lee `user` + roles, que bajo RLS solo devuelve algo
        // con el contexto del aula puesto.
        adminIds: prismaSoporteAdminIds(prisma as never),
        avisarOperador: async (a) => {
          operador.push(a);
        },
        webBaseUrl: async () => 'https://aula.didacta.test',
        enSegundoPlano: (tenantId, tarea) => runAsTenant(tenantId, tarea),
      },
      {
        notificationHub: {
          send: async (n: {
            tenantId: string;
            to: string;
            channel: string;
            templateKey: string;
          }) => {
            hub.push(n);
          },
        } as never,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        } as never,
      },
    );
  });

  afterAll(async () => {
    await service?.esperarAvisos();
    if (admin) {
      await admin.modSoporteTicket.deleteMany({
        where: { tenantId: { in: Object.values(tenants) } },
      });
      await admin.userRole.deleteMany({ where: { userId: { in: Object.values(users) } } });
      await admin.user.deleteMany({ where: { id: { in: Object.values(users) } } });
      await admin.tenant.deleteMany({ where: { id: { in: Object.values(tenants) } } });
      await admin.$disconnect();
    }
    await closeModule?.();
  });

  const ana = () => ({ id: users['anaA']!, nombre: 'Ana', esAdmin: false });
  const beto = () => ({ id: users['betoB']!, nombre: 'Beto', esAdmin: false });
  const adminA = () => ({ id: users['adminA']!, esAdmin: true });
  const adminB = () => ({ id: users['adminB']!, esAdmin: true });

  it('la tabla tiene RLS FORZADA (también para su dueño)', async () => {
    const rows = await admin.$queryRawUnsafe<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'mod_soporte_ticket'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('un aula no ve los tickets de otra: ni en la bandeja, ni por id, ni sin filtro', async () => {
    const t = await runAsTenant(tenants.a, () =>
      service.crear(tenants.a, ana(), { tipo: 'FALLO', texto: 'No carga el vídeo de la clase' }),
    );
    // Control: el equipo de A sí lo ve.
    const deA = await runAsTenant(tenants.a, () => service.listarAdmin(tenants.a, adminA(), {}));
    expect(deA.items.map((i) => i.id)).toContain(t.id);

    const deB = await runAsTenant(tenants.b, () => service.listarAdmin(tenants.b, adminB(), {}));
    expect(deB.items.map((i) => i.id)).not.toContain(t.id);
    // Pidiendo el id de A desde B, incluso diciendo que es de A: RLS lo esconde.
    await expect(
      runAsTenant(tenants.b, () => service.obtenerAdmin(tenants.a, adminB(), t.id)),
    ).rejects.toBeInstanceOf(TicketNoEncontradoError);
    // Una consulta SIN filtro de aula bajo el contexto de B no devuelve nada de A.
    const crudas = await runAsTenant(tenants.b, () =>
      prisma.modSoporteTicket.findMany({ where: { id: t.id } }),
    );
    expect(crudas).toHaveLength(0);
    // Ni puede tocarlo.
    const tocado = await runAsTenant(tenants.b, () =>
      prisma.modSoporteTicket.updateMany({ where: { id: t.id }, data: { estado: 'RESUELTO' } }),
    );
    expect(tocado.count).toBe(0);
    // Control desde fuera de RLS: la fila existe y sigue intacta, en A.
    const real = await admin.modSoporteTicket.findUnique({ where: { id: t.id } });
    expect(real).toMatchObject({ tenantId: tenants.a, estado: 'NUEVO', autorId: users['anaA'] });
  });

  it('8 envíos a la vez de la misma persona: entran 5 justos (candado real)', async () => {
    const intentos = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        runAsTenant(tenants.b, () =>
          service.crear(tenants.b, beto(), { tipo: 'MEJORA', texto: `Sugerencia número ${i}` }),
        ),
      ),
    );
    const ok = intentos.filter((r) => r.status === 'fulfilled');
    const no = intentos.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(5);
    expect(no).toHaveLength(3);
    for (const r of no) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LimiteDiarioError);
    }
    expect(
      await admin.modSoporteTicket.count({
        where: { tenantId: tenants.b, autorId: users['betoB'] },
      }),
    ).toBe(5);
  });

  it('ticket de un alumno: avisos de fondo con el contexto del aula a SU equipo, no al operador', async () => {
    await service.esperarAvisos();
    hub.length = 0;
    operador.length = 0;
    const t = await runAsTenant(tenants.a, () =>
      service.crear(tenants.a, ana(), { tipo: 'PROBLEMA', texto: 'No me llega el certificado' }),
    );
    await service.esperarAvisos();
    expect(t.destino).toBe('AULA');
    const nuevos = hub.filter((h) => h.templateKey === 'soporte.ticket.nuevo');
    expect(nuevos.map((h) => `${h.to}:${h.channel}`).sort()).toEqual(
      [`${users['adminA']}:email`, `${users['adminA']}:in-app`].sort(),
    );
    expect(hub.some((h) => h.to === users['adminB'])).toBe(false);
    expect(operador).toHaveLength(0);
    const fila = await admin.modSoporteTicket.findUnique({ where: { id: t.id } });
    expect(fila?.destino).toBe('AULA');
  });

  it('ticket de quien administra: a Didacta (operador), ni a su equipo ni a su bandeja', async () => {
    await service.esperarAvisos();
    hub.length = 0;
    operador.length = 0;
    const lucia = { id: users['adminA']!, nombre: 'Lucía Admin', esAdmin: true };
    const t = await runAsTenant(tenants.a, () =>
      service.crear(tenants.a, lucia, { tipo: 'FALLO', texto: 'No puedo cambiar el dominio' }),
    );
    await service.esperarAvisos();
    expect(t.destino).toBe('PLATAFORMA');
    expect((await admin.modSoporteTicket.findUnique({ where: { id: t.id } }))?.destino).toBe(
      'PLATAFORMA',
    );
    expect(operador).toEqual([
      expect.objectContaining({
        tenantId: tenants.a,
        ticketId: t.id,
        texto: 'No puedo cambiar el dominio',
        autorId: users['adminA'],
        captura: null,
      }),
    ]);
    expect(hub).toHaveLength(0);
    const bandeja = await runAsTenant(tenants.a, () =>
      service.listarAdmin(tenants.a, adminA(), {}),
    );
    expect(bandeja.items.map((i) => i.id)).not.toContain(t.id);
    await expect(
      runAsTenant(tenants.a, () => service.obtenerAdmin(tenants.a, adminA(), t.id)),
    ).rejects.toBeInstanceOf(TicketNoEncontradoError);
    const mios = await runAsTenant(tenants.a, () => service.mios(tenants.a, users['adminA']!));
    expect(mios.find((m) => m.id === t.id)?.destino).toBe('PLATAFORMA');
  });

  it('la nota interna nunca llega a quien abrió el ticket', async () => {
    const t = await runAsTenant(tenants.a, () =>
      service.crear(tenants.a, ana(), { tipo: 'FALLO', texto: 'El botón no responde' }),
    );
    await runAsTenant(tenants.a, () =>
      service.actualizarAdmin(tenants.a, adminA(), t.id, {
        estado: 'EN_CURSO',
        notaInterna: 'Parece cosa de su extensión del navegador',
      }),
    );
    await service.esperarAvisos();
    const mios = await runAsTenant(tenants.a, () => service.mios(tenants.a, users['anaA']!));
    const mio = mios.find((m) => m.id === t.id)!;
    expect(mio.estado).toBe('EN_CURSO');
    expect(JSON.stringify(mios)).not.toContain('extensión');
    const avisoAutor = hub.filter(
      (h) => h.templateKey === 'soporte.ticket.estado' && h.to === users['anaA'],
    );
    expect(avisoAutor).toHaveLength(2);
    expect(JSON.stringify(avisoAutor)).not.toContain('extensión');
  });
});
