/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Dirección de tu academia» contra Postgres REAL como `didacta_app` (RLS
 * forzada), que es como corre el pool: el aula solo ve SUS dominios, así que
 * aquí se prueba de verdad que «ocupada por otra academia» mira a todas sin
 * enseñar ninguna, que la dirección vieja se queda en el aula y redirige, y que
 * el límite aguanta peticiones a la vez.
 *
 * Todo es real: servicio, audit log (con su cadena de hashes), resolvedor de
 * dominios y la transacción del cambio.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AcademyAddressService } from '../../src/admin/academy-address/academy-address.service';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const SUFFIX = 'aulas-integ.test';

describeWithDb('Dirección de la academia (Postgres real, RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: AcademyAddressService;
  let resolver: TenantResolverService;
  let auditLog: PrismaAuditLogService;
  let savedSuffix: string | undefined;

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
    auditLog = new PrismaAuditLogService(prisma);
    service = new AcademyAddressService(prisma, auditLog);
    resolver = new TenantResolverService(prisma);
  }, 120_000);

  afterAll(async () => {
    // El audit log es append-only (trigger): las aulas se quedan en la base
    // desechable de pruebas, con nombres únicos por pasada.
    await admin?.$disconnect();
    await closeModule?.();
  });

  beforeEach(() => {
    savedSuffix = process.env['TENANT_SUBDOMAIN_SUFFIX'];
    process.env['TENANT_SUBDOMAIN_SUFFIX'] = SUFFIX;
  });

  afterEach(() => {
    if (savedSuffix === undefined) delete process.env['TENANT_SUBDOMAIN_SUFFIX'];
    else process.env['TENANT_SUBDOMAIN_SUFFIX'] = savedSuffix;
  });

  const rand = () => randomUUID().slice(0, 8);

  /** Un aula como la deja el aprovisionamiento: `<slug>.<sufijo>` primario y verificado. */
  async function aula(hostname?: string): Promise<{ id: string; slug: string; host: string }> {
    const slug = `dir-${rand()}`;
    const host = hostname ?? `${slug}.${SUFFIX}`;
    const t = await admin.tenant.create({ data: { slug, name: `Aula ${slug}`, status: 'ACTIVE' } });
    await admin.tenantDomain.create({
      data: { tenantId: t.id, hostname: host, isPrimary: true, isVerified: true },
    });
    return { id: t.id, slug, host };
  }

  /** Como en una petición: el contexto del aula del token ya está puesto. */
  const as = <T>(tenantId: string, fn: () => Promise<T>) => runAsTenant(tenantId, fn);

  async function domainsOf(tenantId: string) {
    return admin.tenantDomain.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: { hostname: true, isPrimary: true, isVerified: true, redirectToPrimary: true },
    });
  }

  it('el estado: dirección actual, sufijo y 3 cambios', async () => {
    const a = await aula();
    const state = await as(a.id, () => service.getState(a.id));
    expect(state).toMatchObject({
      suffix: SUFFIX,
      hostname: a.host,
      label: a.slug,
      canChange: true,
      blockedReason: null,
      maxChanges: 3,
      windowDays: 30,
      changesLeft: 3,
      nextChangeAt: null,
    });
  });

  it('disponibilidad: mira TODAS las aulas aunque RLS solo deje ver la propia, sin decir de quién es', async () => {
    const a = await aula();
    const b = await aula();
    const check = (label: string) => as(a.id, () => service.checkAvailability(a.id, label));

    expect(await check(b.slug)).toEqual({
      label: b.slug,
      hostname: `${b.slug}.${SUFFIX}`,
      status: 'taken',
    });
    expect(await check(a.slug)).toMatchObject({ status: 'current' });
    expect(await check('support')).toMatchObject({ status: 'reserved' });
    expect(await check('a')).toEqual({ label: 'a', hostname: null, status: 'invalid' });
    expect(await check(`  Libre-${rand()} `)).toMatchObject({ status: 'available' });

    // El slug de otra aula cuenta como ocupado aunque su dirección sea otra.
    const c = await aula(`otra-${rand()}.${SUFFIX}`);
    expect(await check(c.slug)).toMatchObject({ status: 'taken' });
  });

  it('cambio: la nueva pasa a principal y la vieja se queda en el aula, redirigiendo', async () => {
    const a = await aula();
    const nueva = `nueva-${rand()}`;
    const actor = randomUUID();
    const res = await as(a.id, () =>
      service.change(a.id, actor, nueva, { ip: '10.0.0.7', userAgent: 'vitest' }),
    );
    const nuevoHost = `${nueva}.${SUFFIX}`;
    expect(res.previousHostname).toBe(a.host);
    expect(res.hostname).toBe(nuevoHost);
    expect(res.state).toMatchObject({ hostname: nuevoHost, label: nueva, changesLeft: 2 });

    expect(await domainsOf(a.id)).toEqual([
      { hostname: a.host, isPrimary: false, isVerified: true, redirectToPrimary: true },
      { hostname: nuevoHost, isPrimary: true, isVerified: true, redirectToPrimary: false },
    ]);

    // Queda en el audit log, que además es lo que cuenta para el límite.
    const audit = await admin.auditLog.findMany({
      where: { tenantId: a.id, action: 'academy.address.changed' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: actor,
      resourceType: 'tenant',
      resourceId: a.id,
      ip: '10.0.0.7',
      metadata: { previousHostname: a.host, hostname: nuevoHost },
    });
    // La entrada escrita dentro de la transacción del cambio sigue la cadena.
    expect(await as(a.id, () => auditLog.verifyChain(a.id))).toMatchObject({
      valid: true,
      totalEntries: 1,
    });

    // La vieja sigue siendo del aula y dice adónde ir; la nueva, no redirige.
    const vieja = await resolver.resolveByHost(a.host);
    expect(vieja).toMatchObject({ id: a.id, redirectToPrimary: true });
    expect(await resolver.resolveAliasRedirect(vieja!)).toBe(nuevoHost);
    const actual = await resolver.resolveByHost(nuevoHost);
    expect(actual).toMatchObject({ id: a.id, redirectToPrimary: false });
    expect(await resolver.resolveAliasRedirect(actual!)).toBeNull();
    // Correos y enlaces salen ya con la nueva.
    expect(await resolver.resolvePrimaryDomain(a.id)).toBe(nuevoHost);
  });

  it('nadie puede quedarse la dirección vieja de otra aula (sin suplantación de enlaces viejos)', async () => {
    const a = await aula();
    const b = await aula();
    // Dos mudanzas: `primera` deja de ser el slug de nadie y se queda como
    // dirección anterior de A. Solo la consulta de dominios a TODAS las aulas
    // puede saber que es de A: con RLS, B no ve ni una fila de A.
    const primera = `mudada-${rand()}`;
    const segunda = `remudada-${rand()}`;
    await as(a.id, () => service.change(a.id, null, primera));
    await as(a.id, () => service.change(a.id, null, segunda));

    for (const label of [a.slug, primera, segunda]) {
      expect(await as(b.id, () => service.checkAvailability(b.id, label))).toMatchObject({
        status: 'taken',
      });
    }
    await expect(as(b.id, () => service.change(b.id, null, primera))).rejects.toMatchObject({
      response: { code: 'ACADEMY_ADDRESS_TAKEN' },
    });
    expect(await resolver.resolveByHost(`${primera}.${SUFFIX}`)).toMatchObject({
      id: a.id,
      redirectToPrimary: true,
    });
    expect(await domainsOf(b.id)).toHaveLength(1);
  });

  it('volver a una dirección anterior propia la reactiva (sin filas nuevas)', async () => {
    const a = await aula();
    const intermedia = `intermedia-${rand()}`;
    await as(a.id, () => service.change(a.id, null, intermedia));
    expect(await as(a.id, () => service.checkAvailability(a.id, a.slug))).toMatchObject({
      status: 'available',
    });
    const res = await as(a.id, () => service.change(a.id, null, a.slug));
    expect(res.hostname).toBe(a.host);
    expect(res.state.changesLeft).toBe(1);
    expect(await domainsOf(a.id)).toEqual([
      { hostname: a.host, isPrimary: true, isVerified: true, redirectToPrimary: false },
      {
        hostname: `${intermedia}.${SUFFIX}`,
        isPrimary: false,
        isVerified: true,
        redirectToPrimary: true,
      },
    ]);
  });

  it('reservada, inválida o la misma: no cambia nada ni cuenta', async () => {
    const a = await aula();
    await expect(as(a.id, () => service.change(a.id, null, 'www'))).rejects.toMatchObject({
      response: { code: 'ACADEMY_ADDRESS_RESERVED' },
    });
    await expect(as(a.id, () => service.change(a.id, null, 'no vale'))).rejects.toMatchObject({
      response: { code: 'ACADEMY_ADDRESS_INVALID' },
    });
    await expect(as(a.id, () => service.change(a.id, null, a.slug))).rejects.toMatchObject({
      response: { code: 'ACADEMY_ADDRESS_UNCHANGED' },
    });
    expect(await domainsOf(a.id)).toHaveLength(1);
    expect((await as(a.id, () => service.getState(a.id))).changesLeft).toBe(3);
  });

  it('límite: 3 cambios en 30 días; el cuarto se rechaza y el estado dice cuándo', async () => {
    const a = await aula();
    for (let i = 0; i < 3; i++) {
      await as(a.id, () => service.change(a.id, null, `paso${i}-${rand()}`));
    }
    const state = await as(a.id, () => service.getState(a.id));
    expect(state).toMatchObject({ canChange: false, blockedReason: 'limit', changesLeft: 0 });
    expect(new Date(state.nextChangeAt!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await expect(
      as(a.id, () => service.change(a.id, null, `cuarto-${rand()}`)),
    ).rejects.toMatchObject({ response: { code: 'ACADEMY_ADDRESS_CHANGE_LIMIT' } });
    expect(await domainsOf(a.id)).toHaveLength(4);
  });

  it('límite con peticiones A LA VEZ: entran 3 y ni una más, y queda un solo principal', async () => {
    const a = await aula();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        as(a.id, () => service.change(a.id, null, `carrera${i}-${rand()}`)),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    for (const r of ko) {
      expect((r.reason as { response?: { code?: string } }).response?.code).toBe(
        'ACADEMY_ADDRESS_CHANGE_LIMIT',
      );
    }
    const domains = await domainsOf(a.id);
    expect(domains.filter((d) => d.isPrimary)).toHaveLength(1);
    expect(domains).toHaveLength(4);
    expect(
      await admin.auditLog.count({ where: { tenantId: a.id, action: 'academy.address.changed' } }),
    ).toBe(3);
    expect(await as(a.id, () => auditLog.verifyChain(a.id))).toMatchObject({
      valid: true,
      totalEntries: 3,
    });
  });

  it('un aula con dominio propio no cambia su dirección desde aquí', async () => {
    const a = await aula(`aula.academia-${rand()}.example`);
    const state = await as(a.id, () => service.getState(a.id));
    expect(state).toMatchObject({ label: null, canChange: false, blockedReason: 'own_domain' });
    await expect(as(a.id, () => service.change(a.id, null, `x-${rand()}`))).rejects.toMatchObject({
      response: { code: 'ACADEMY_ADDRESS_OWN_DOMAIN' },
    });
  });

  it('sin TENANT_SUBDOMAIN_SUFFIX la función no existe (404) y no toca la base', async () => {
    const a = await aula();
    delete process.env['TENANT_SUBDOMAIN_SUFFIX'];
    const calls: Array<() => Promise<unknown>> = [
      () => service.getState(a.id),
      () => service.checkAvailability(a.id, 'libre-del-todo'),
      () => service.change(a.id, null, 'libre-del-todo'),
    ];
    for (const call of calls) {
      await expect(as(a.id, call)).rejects.toMatchObject({
        status: 404,
        response: { code: 'ACADEMY_ADDRESS_DISABLED' },
      });
    }
    expect(await domainsOf(a.id)).toHaveLength(1);
  });
});
