/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Idioma de la academia» desde Ajustes: `GET/PUT /admin/tenant-settings/academy`
 * devuelve y fija el idioma del aula (ajuste `academy/locale`), siempre sobre el
 * tenant del token y solo para quien administra.
 */

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AcademyUpdateSchema, AdminAcademyController } from '../src/admin/admin-academy.controller';
import type { SessionClaims } from '../src/auth/token.service';

interface Setting {
  tenantId: string;
  moduleName: string;
  key: string;
  valueJson: unknown;
  updatedById: string | null;
}

function fakePrisma(
  opts: { adminLocale?: string; simpleLocale?: string; simpleMode?: boolean } = {},
) {
  const settings: Setting[] = [];
  let name = 'Taller';
  const find = (tenantId: string, moduleName: string, key: string) =>
    settings.find((s) => s.tenantId === tenantId && s.moduleName === moduleName && s.key === key);
  const prisma = {
    settings,
    tenant: {
      findUnique: async () => ({ name, slug: 'taller', simpleMode: opts.simpleMode ?? false }),
      update: async (args: { data: { name: string } }) => {
        name = args.data.name;
        return { name };
      },
    },
    tenantDomain: { findFirst: async () => ({ hostname: 'taller.didacta.io' }) },
    tenantSetting: {
      findUnique: async (args: {
        where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      }) => {
        const { tenantId, moduleName, key } = args.where.tenantId_moduleName_key;
        if (moduleName === 'simple-mode' && key === 'state' && opts.simpleLocale) {
          return { valueJson: { locale: opts.simpleLocale } };
        }
        const row = find(tenantId, moduleName, key);
        return row ? { valueJson: row.valueJson } : null;
      },
      upsert: async (args: {
        where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
        create: Setting;
        update: { valueJson: unknown; updatedById: string | null };
      }) => {
        const { tenantId, moduleName, key } = args.where.tenantId_moduleName_key;
        const row = find(tenantId, moduleName, key);
        if (row) Object.assign(row, args.update);
        else settings.push({ ...args.create });
        return null;
      },
    },
    user: {
      findMany: async () =>
        opts.adminLocale ? [{ locale: opts.adminLocale, timezone: 'UTC' }] : [],
    },
  };
  return prisma;
}

const admin = { sub: 'u-admin', tenantId: 't1', roles: ['tenant_admin'] } as SessionClaims;
const alumno = { sub: 'u-alumno', tenantId: 't1', roles: ['alumno'] } as SessionClaims;

describe('AdminAcademyController — idioma del aula', () => {
  it('sin ajuste: devuelve la deducción y dice de dónde sale', async () => {
    const ctl = new AdminAcademyController(fakePrisma({ simpleLocale: 'en' }) as never);
    const dto = await ctl.getMine(admin);
    expect(dto).toMatchObject({ name: 'Taller', locale: 'en', localeSource: 'simple-mode' });
  });

  it('fijar el idioma lo guarda como ajuste del aula y manda sobre la deducción', async () => {
    const prisma = fakePrisma({ adminLocale: 'en-US' });
    const ctl = new AdminAcademyController(prisma as never);
    expect((await ctl.getMine(admin)).locale).toBe('en');
    const dto = await ctl.rename(admin, { locale: 'es' });
    expect(dto).toMatchObject({ name: 'Taller', locale: 'es', localeSource: 'setting' });
    expect(prisma.settings).toEqual([
      {
        tenantId: 't1',
        moduleName: 'academy',
        key: 'locale',
        valueJson: 'es',
        isSecret: false,
        updatedById: 'u-admin',
      },
    ]);
    // Cambiarlo otra vez actualiza la misma fila.
    await ctl.rename(admin, { locale: 'en' });
    expect(prisma.settings).toHaveLength(1);
    expect((await ctl.getMine(admin)).locale).toBe('en');
  });

  it('renombrar sin `locale` no toca el idioma', async () => {
    const prisma = fakePrisma();
    const ctl = new AdminAcademyController(prisma as never);
    const dto = await ctl.rename(admin, { name: 'Taller de Acuarela' });
    expect(dto).toMatchObject({
      name: 'Taller de Acuarela',
      locale: 'es',
      localeSource: 'default',
    });
    expect(prisma.settings).toHaveLength(0);
  });

  it('solo quien administra', async () => {
    const ctl = new AdminAcademyController(fakePrisma() as never);
    await expect(ctl.rename(alumno, { locale: 'en' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el cuerpo: es | en, y al menos un cambio', () => {
    expect(AcademyUpdateSchema.safeParse({ locale: 'en' }).success).toBe(true);
    expect(AcademyUpdateSchema.safeParse({ locale: 'pt-BR' }).success).toBe(false);
    expect(AcademyUpdateSchema.safeParse({ locale: 'en-US' }).success).toBe(false);
    expect(AcademyUpdateSchema.safeParse({}).success).toBe(false);
    expect(AcademyUpdateSchema.safeParse({ name: 'X' }).success).toBe(true);
    expect(AcademyUpdateSchema.safeParse({ publicHome: false }).success).toBe(true);
    expect(AcademyUpdateSchema.safeParse({ publicHome: 'si' }).success).toBe(false);
  });
});

describe('AdminAcademyController — página pública de la academia', () => {
  it('sin ajuste: activada en el modo sencillo y desactivada en el completo', async () => {
    const sencilla = new AdminAcademyController(fakePrisma({ simpleMode: true }) as never);
    expect(await sencilla.getMine(admin)).toMatchObject({
      publicHome: true,
      publicHomeSource: 'default',
    });
    const completa = new AdminAcademyController(fakePrisma({ simpleMode: false }) as never);
    expect(await completa.getMine(admin)).toMatchObject({
      publicHome: false,
      publicHomeSource: 'default',
    });
  });

  it('apagarla en un aula sencilla la guarda como ajuste y manda sobre el modo', async () => {
    const prisma = fakePrisma({ simpleMode: true });
    const ctl = new AdminAcademyController(prisma as never);
    const dto = await ctl.rename(admin, { publicHome: false });
    expect(dto).toMatchObject({ publicHome: false, publicHomeSource: 'setting' });
    expect(prisma.settings).toEqual([
      {
        tenantId: 't1',
        moduleName: 'academy',
        key: 'public-home',
        valueJson: { enabled: false },
        isSecret: false,
        updatedById: 'u-admin',
      },
    ]);
    // Encenderla de nuevo actualiza la misma fila.
    expect((await ctl.rename(admin, { publicHome: true })).publicHome).toBe(true);
    expect(prisma.settings).toHaveLength(1);
  });

  it('cambiar el nombre o el idioma no toca la página pública', async () => {
    const prisma = fakePrisma({ simpleMode: false });
    const ctl = new AdminAcademyController(prisma as never);
    await ctl.rename(admin, { name: 'Otra', locale: 'en' });
    expect(prisma.settings.map((s) => s.key)).toEqual(['locale']);
    expect((await ctl.getMine(admin)).publicHomeSource).toBe('default');
  });

  it('solo quien administra puede cambiarla', async () => {
    const ctl = new AdminAcademyController(fakePrisma() as never);
    await expect(ctl.rename(alumno, { publicHome: true })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
