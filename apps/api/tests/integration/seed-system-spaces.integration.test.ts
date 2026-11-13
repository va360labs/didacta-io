/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `packages/database/prisma/seed.sql` contra Postgres REAL, aplicado con psql
 * como lo hace el entrypoint en cada arranque del contenedor.
 *
 * El fallo: el seed sembraba los espacios de sistema siempre en español, así
 * que un aula en inglés montada con el alta sencilla (que crea General,
 * Announcements y Questions) recibía «Recursos compartidos» en el primer
 * reinicio. Ahora los crea en el idioma del aula, con la misma regla que
 * `academyLocale()`, y sin duplicar ni tocar lo que ya existe.
 *
 * Se aplica dos veces como `didacta_app` (NOSUPERUSER, NOBYPASSRLS: la RLS
 * forzada aplica de verdad, como en un Postgres gestionado) y una tercera como
 * el superusuario del compose: tres reinicios, cero duplicados.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { academyLocale } from '../../src/common/academy-defaults';
import {
  ADMIN_DATABASE_URL,
  applySqlFileViaPsql,
  prepareDidactaAppRole,
} from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const SEED = 'packages/database/prisma/seed.sql';

interface SpaceRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  isSystem: boolean;
  updatedAt: Date;
}

describeWithDb('seed.sql — espacios de sistema en el idioma del aula', () => {
  let admin: PrismaClient;
  let adminRoleId: string;
  const tenants: string[] = [];
  const t = {} as Record<
    | 'enSencilla'
    | 'enPerfil'
    | 'es'
    | 'enConEspanol'
    | 'enManual'
    | 'sinNada'
    | 'ajusteEn'
    | 'ajusteEs',
    string
  >;
  let antesEs: SpaceRow[] = [];
  let antesEnConEspanol: SpaceRow[] = [];

  const spaces = (tenantId: string): Promise<SpaceRow[]> =>
    admin.modCommunitySpace.findMany({
      where: { tenantId },
      orderBy: { slug: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        isSystem: true,
        updatedAt: true,
      },
    });

  async function aula(nombre: string, adminLocale?: string): Promise<string> {
    const id = randomUUID();
    const stamp = `${nombre}-${Date.now()}-${id.slice(0, 8)}`;
    await admin.tenant.create({ data: { id, slug: stamp, name: stamp } });
    tenants.push(id);
    if (adminLocale) {
      const user = await admin.user.create({
        data: {
          tenantId: id,
          email: `admin-${stamp}@example.test`,
          status: 'ACTIVE',
          locale: adminLocale,
        },
      });
      await admin.userRole.create({ data: { userId: user.id, roleId: adminRoleId } });
    }
    return id;
  }

  async function espacio(
    tenantId: string,
    slug: string,
    title: string,
    isSystem = false,
  ): Promise<void> {
    await admin.modCommunitySpace.create({
      data: { tenantId, slug, title, description: `${title}.`, isSystem },
    });
  }

  beforeAll(async () => {
    ({ admin } = await prepareDidactaAppRole());
    adminRoleId = (
      await admin.role.upsert({
        where: { name: 'tenant_admin' },
        create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
        update: {},
      })
    ).id;

    // Aula en inglés montada con el alta sencilla: el idioma está en el ajuste
    // y la creadora conserva el perfil en español (el ajuste manda). Tiene los
    // tres espacios que crea el alta, en inglés.
    t.enSencilla = await aula('seed-en-sencilla', 'es-ES');
    await admin.tenantSetting.create({
      data: {
        tenantId: t.enSencilla,
        moduleName: 'simple-mode',
        key: 'state',
        valueJson: { locale: 'en', completedAt: new Date().toISOString() },
      },
    });
    await espacio(t.enSencilla, 'general', 'General');
    await espacio(t.enSencilla, 'anuncios', 'Announcements');
    await espacio(t.enSencilla, 'preguntas', 'Questions');

    // Aula sin alta sencilla: el idioma sale del perfil de quien la administra.
    t.enPerfil = await aula('seed-en-perfil', 'en-GB');

    // Aula española que ya existía con sus cuatro espacios.
    t.es = await aula('seed-es', 'es-ES');
    await espacio(t.es, 'general', 'General', true);
    await espacio(t.es, 'anuncios', 'Anuncios', true);
    await espacio(t.es, 'preguntas', 'Preguntas y dudas', true);
    await espacio(t.es, 'recursos', 'Recursos compartidos', true);
    antesEs = await spaces(t.es);

    // Aula inglesa que ya recibió «Recursos compartidos» del seed anterior: se
    // queda como está (ni se traduce ni se añade la versión inglesa).
    t.enConEspanol = await aula('seed-en-con-espanol', 'en-US');
    await espacio(t.enConEspanol, 'general', 'General');
    await espacio(t.enConEspanol, 'anuncios', 'Announcements');
    await espacio(t.enConEspanol, 'preguntas', 'Questions');
    await espacio(t.enConEspanol, 'recursos', 'Recursos compartidos', true);
    antesEnConEspanol = await spaces(t.enConEspanol);

    // Aula inglesa con «Shared resources» creado a mano (otro slug).
    t.enManual = await aula('seed-en-manual', 'en-US');
    await espacio(t.enManual, 'general', 'General');
    await espacio(t.enManual, 'anuncios', 'Announcements');
    await espacio(t.enManual, 'preguntas', 'Questions');
    await espacio(t.enManual, 'shared-resources', '  shared RESOURCES ');

    // Aula sin ajuste ni administradora: español, como siempre.
    t.sinNada = await aula('seed-sin-nada');

    // El ajuste del aula manda sobre la deducción: alta sencilla y perfil en
    // español, pero el aula está en inglés (y al revés).
    t.ajusteEn = await aula('seed-ajuste-en', 'es-ES');
    await admin.tenantSetting.createMany({
      data: [
        { tenantId: t.ajusteEn, moduleName: 'academy', key: 'locale', valueJson: 'en' },
        {
          tenantId: t.ajusteEn,
          moduleName: 'simple-mode',
          key: 'state',
          valueJson: { locale: 'es' },
        },
      ],
    });
    t.ajusteEs = await aula('seed-ajuste-es', 'en-US');
    await admin.tenantSetting.create({
      data: { tenantId: t.ajusteEs, moduleName: 'academy', key: 'locale', valueJson: 'es' },
    });

    // Tres reinicios: dos con RLS forzada y uno como superusuario.
    applySqlFileViaPsql(SEED, { user: 'didacta_app' });
    applySqlFileViaPsql(SEED, { user: 'didacta_app' });
    applySqlFileViaPsql(SEED);
  }, 120_000);

  afterAll(async () => {
    if (admin && tenants.length > 0) {
      await admin.modCommunitySpace
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await admin.tenantSetting
        .deleteMany({ where: { tenantId: { in: tenants } } })
        .catch(() => undefined);
      await admin.userRole
        .deleteMany({ where: { user: { tenantId: { in: tenants } } } })
        .catch(() => undefined);
      await admin.user.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => undefined);
      await admin.tenant.deleteMany({ where: { id: { in: tenants } } }).catch(() => undefined);
    }
    await admin?.$disconnect();
  });

  it('aula en inglés del alta sencilla: «Shared resources» en inglés, una sola vez', async () => {
    const rows = await spaces(t.enSencilla);
    expect(rows.map((r) => r.slug)).toEqual(['anuncios', 'general', 'preguntas', 'recursos']);
    const recursos = rows.find((r) => r.slug === 'recursos');
    expect(recursos).toMatchObject({
      title: 'Shared resources',
      description: 'Templates, notes and supporting materials.',
      isSystem: true,
    });
    expect(rows.some((r) => /recursos compartidos/i.test(r.title))).toBe(false);
    // Los tres del alta siguen como estaban.
    expect(rows.filter((r) => r.slug !== 'recursos').map((r) => r.title)).toEqual([
      'Announcements',
      'General',
      'Questions',
    ]);
  });

  it('aula sin alta sencilla con la administradora en inglés: los cuatro en inglés', async () => {
    const rows = await spaces(t.enPerfil);
    expect(rows.map((r) => [r.slug, r.title])).toEqual([
      ['anuncios', 'Announcements'],
      ['general', 'General'],
      ['preguntas', 'Questions'],
      ['recursos', 'Shared resources'],
    ]);
    expect(rows.every((r) => r.isSystem)).toBe(true);
  });

  it('aula española existente: intacta (mismos ids, títulos y fecha de cambio)', async () => {
    expect(await spaces(t.es)).toEqual(antesEs);
  });

  it('aula inglesa que ya tenía «Recursos compartidos»: ni se traduce ni se duplica', async () => {
    expect(await spaces(t.enConEspanol)).toEqual(antesEnConEspanol);
  });

  it('aula inglesa con «Shared resources» creado a mano: no se añade otro', async () => {
    const rows = await spaces(t.enManual);
    expect(rows.map((r) => r.slug)).toEqual([
      'anuncios',
      'general',
      'preguntas',
      'shared-resources',
    ]);
  });

  it('aula sin ajuste ni administradora: los cuatro en español, como siempre', async () => {
    const rows = await spaces(t.sinNada);
    expect(rows.map((r) => [r.slug, r.title])).toEqual([
      ['anuncios', 'Anuncios'],
      ['general', 'General'],
      ['preguntas', 'Preguntas y dudas'],
      ['recursos', 'Recursos compartidos'],
    ]);
  });

  it('el ajuste del aula manda sobre la deducción, en los dos sentidos', async () => {
    expect((await spaces(t.ajusteEn)).map((r) => r.title)).toEqual([
      'Announcements',
      'General',
      'Questions',
      'Shared resources',
    ]);
    expect((await spaces(t.ajusteEs)).map((r) => r.title)).toEqual([
      'Anuncios',
      'General',
      'Preguntas y dudas',
      'Recursos compartidos',
    ]);
  });

  it('el seed deduce el mismo idioma que academyLocale() para cada aula', async () => {
    const esperado: Array<[string, 'es' | 'en', string]> = [
      [t.enSencilla, 'en', 'Shared resources'],
      [t.enPerfil, 'en', 'Shared resources'],
      [t.sinNada, 'es', 'Recursos compartidos'],
      [t.ajusteEn, 'en', 'Shared resources'],
      [t.ajusteEs, 'es', 'Recursos compartidos'],
    ];
    for (const [tenantId, idioma, titulo] of esperado) {
      expect(await academyLocale(admin as never, tenantId)).toBe(idioma);
      const recursos = (await spaces(tenantId)).find((r) => r.slug === 'recursos');
      expect(recursos?.title).toBe(titulo);
    }
  });
});
