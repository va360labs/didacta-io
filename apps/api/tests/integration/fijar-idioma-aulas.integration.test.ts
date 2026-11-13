/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `scripts/fijar-idioma-aulas.ts` contra Postgres REAL conectando como
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS): con la RLS forzada lee el alta
 * sencilla y el perfil de quien administra aula por aula, propone el idioma de
 * siempre y, al aplicar, solo inserta el ajuste donde falta.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aplicar, decidir, revisar } from '../../scripts/fijar-idioma-aulas';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('fijar-idioma-aulas — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let app: PrismaClient;
  const tenants: string[] = [];
  const t = {} as Record<'sencilla' | 'perfil' | 'nada' | 'yaTiene', string>;

  async function aula(nombre: string, adminLocale?: string): Promise<string> {
    const id = randomUUID();
    const stamp = `${nombre}-${Date.now()}-${id.slice(0, 8)}`;
    await admin.tenant.create({ data: { id, slug: stamp, name: stamp } });
    tenants.push(id);
    if (adminLocale) {
      const rol = await admin.role.upsert({
        where: { name: 'tenant_admin' },
        create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
        update: {},
      });
      const u = await admin.user.create({
        data: {
          tenantId: id,
          email: `a-${stamp}@example.test`,
          status: 'ACTIVE',
          locale: adminLocale,
        },
      });
      await admin.userRole.create({ data: { userId: u.id, roleId: rol.id } });
    }
    return id;
  }

  const ajuste = async (tenantId: string) =>
    (
      await admin.tenantSetting.findMany({
        where: { tenantId, moduleName: 'academy', key: 'locale' },
        select: { valueJson: true },
      })
    ).map((r) => r.valueJson);

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    app = new PrismaClient({ datasources: { db: { url: prepared.appUrl } } });
    await app.$connect();

    t.sencilla = await aula('idioma-sencilla', 'es-ES');
    await admin.tenantSetting.create({
      data: {
        tenantId: t.sencilla,
        moduleName: 'simple-mode',
        key: 'state',
        valueJson: { locale: 'en' },
      },
    });
    t.perfil = await aula('idioma-perfil', 'en-US');
    t.nada = await aula('idioma-nada');
    t.yaTiene = await aula('idioma-ya-tiene', 'en-US');
    await admin.tenantSetting.create({
      data: { tenantId: t.yaTiene, moduleName: 'academy', key: 'locale', valueJson: 'es' },
    });
  }, 120_000);

  afterAll(async () => {
    if (admin && tenants.length > 0) {
      await admin.tenantSetting
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await admin.user.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => undefined);
      await admin.tenant.deleteMany({ where: { id: { in: tenants } } }).catch(() => undefined);
    }
    await app?.$disconnect();
    await admin?.$disconnect();
  });

  it('ensayo: propone el idioma de siempre y no escribe nada', async () => {
    const aulas = (await revisar(app, null)).filter((a) => tenants.includes(a.id));
    const por = Object.fromEntries(aulas.map((a) => [a.id, a]));
    expect(por[t.sencilla]).toMatchObject({ actual: null, deducido: 'en', origen: 'simple-mode' });
    expect(por[t.perfil]).toMatchObject({ actual: null, deducido: 'en', origen: 'admin' });
    expect(por[t.nada]).toMatchObject({ actual: null, deducido: 'es', origen: 'default' });
    expect(decidir(por[t.yaTiene]!)).toEqual({ accion: 'ya-tiene', locale: 'es' });
    for (const id of [t.sencilla, t.perfil, t.nada]) expect(await ajuste(id)).toEqual([]);
  });

  it('--apply: inserta donde falta, no toca el que ya lo tiene, y repetirlo no cambia nada', async () => {
    const mias = async () => (await revisar(app, null)).filter((a) => tenants.includes(a.id));
    const primera = await aplicar(app, await mias(), () => undefined);
    expect(primera).toEqual({ escritas: 3, fallos: 0 });
    expect(await ajuste(t.sencilla)).toEqual(['en']);
    expect(await ajuste(t.perfil)).toEqual(['en']);
    expect(await ajuste(t.nada)).toEqual(['es']);
    expect(await ajuste(t.yaTiene)).toEqual(['es']);
    expect(await aplicar(app, await mias(), () => undefined)).toEqual({ escritas: 0, fallos: 0 });
  });

  it('nunca pisa un ajuste que aparece entre la revisión y la escritura', async () => {
    const otra = await aula('idioma-carrera', 'en-US');
    const revisadas = await revisar(app, otra);
    expect(decidir(revisadas[0]!)).toEqual({ accion: 'fijar', locale: 'en' });
    // Alguien lo fija en Ajustes mientras tanto.
    await admin.tenantSetting.create({
      data: { tenantId: otra, moduleName: 'academy', key: 'locale', valueJson: 'es' },
    });
    expect(await aplicar(app, revisadas, () => undefined)).toEqual({ escritas: 0, fallos: 0 });
    expect(await ajuste(otra)).toEqual(['es']);
  });
});
