/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Alta de un aula por aprovisionamiento (`POST /admin/tenants`, lo que hace
 * Didacta Cloud) contra Postgres REAL como `didacta_app` (RLS forzada): el
 * correo de bienvenida de la primera administradora enlaza al dominio del aula
 * NUEVA, no al del despliegue.
 *
 * Reproduce el fallo de producción del 13-nov-2026: el pool tiene
 * `WEB_PUBLIC_URL=https://pool.didacta.io`, el plano de control llama por ese
 * dominio con su credencial de provisioning y crea `aula-pruebas` con
 * `primaryHostname: aula-pruebas.didacta.io`. El correo salía con
 * `https://pool.didacta.io/reset-password?token=…`.
 *
 * Todo es real salvo el transporte SMTP (se capturan los correos en vez de
 * enviarlos) y la licencia (se da por concedida `multi_tenant`): controlador,
 * servicio del alta, resolvedor de dominios, servicio de restablecer y la
 * transacción que crea aula, dominio y administradora.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AdminTenantsController } from '../../src/admin/admin-tenants.controller';
import { AdminTenantsService } from '../../src/admin/admin-tenants.service';
import { PasswordResetService } from '../../src/auth/password-reset.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

/** Id de la credencial de provisioning del plano de control (va al audit log). */
const CREDENTIAL_ID = randomUUID();

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  log: () => undefined,
};

/** Enlace de definir contraseña del correo (el primero que aparezca). */
function resetLink(body: string): URL {
  const m = /https?:\/\/[^\s"'<>]+\/reset-password\?token=[^\s"'<>&]+/.exec(body);
  if (!m) throw new Error(`el correo no lleva enlace de reset:\n${body.slice(0, 400)}`);
  return new URL(m[0]);
}

describeWithDb('POST /admin/tenants · la bienvenida enlaza al aula nueva (Postgres real)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let controller: AdminTenantsController;
  const sent: Sent[] = [];
  const created: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

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

    await admin.role.upsert({
      where: { name: 'tenant_admin' },
      create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
      update: {},
    });

    const auditLog = new PrismaAuditLogService(prisma);
    // Transporte capturado: lo que se probaría enviando de verdad es el TEXTO
    // del correo, y ese sale entero de aquí.
    const smtp = {
      send: async (_config: unknown, input: Sent) => {
        sent.push(input);
        return { ok: true };
      },
    };
    const smtpResolver = {
      resolve: async () => ({
        config: { host: 'smtp.invalid', port: 587, from: 'no-reply@didacta.io' },
        source: 'global',
        verified: false,
      }),
    };
    const passwordReset = new PasswordResetService(
      prisma,
      new PasswordService(),
      auditLog,
      smtp as never,
      {} as never,
      silentLogger as never,
      smtpResolver as never,
    );
    // Licencia `multi_tenant` concedida: aquí se prueba el enlace, no el gate.
    const license = { requireCapability: () => undefined };
    const service = new AdminTenantsService(
      prisma,
      auditLog,
      passwordReset,
      license as never,
      silentLogger as never,
    );
    controller = new AdminTenantsController(
      service,
      {} as never,
      new TenantResolverService(prisma),
    );
  }, 120_000);

  afterAll(async () => {
    // El audit log es inmutable (trigger): las aulas creadas se quedan en la
    // base desechable del entorno de pruebas.
    await admin?.$disconnect();
    await closeModule?.();
  });

  beforeEach(() => {
    sent.length = 0;
    for (const k of ['WEB_PUBLIC_URL', 'WEB_PUBLIC_ALLOWED_HOSTS']) savedEnv[k] = process.env[k];
    // El pool tal como está en producción.
    process.env['WEB_PUBLIC_URL'] = 'https://pool.didacta.io';
    process.env['WEB_PUBLIC_ALLOWED_HOSTS'] = 'pool.didacta.io';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Así llama el plano de control: credencial de provisioning, por el dominio del pool. */
  async function crearDesdeCloud(primaryHostname: string, host = 'pool.didacta.io') {
    const slug = `enl-${randomUUID().slice(0, 8)}`;
    const adminEmail = `admin-${slug}@example.test`;
    const req = {
      headers: { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
      ip: '10.0.1.1',
      provisioningActor: { credentialId: CREDENTIAL_ID },
    };
    const tenant = (await controller.create(req as never, undefined, {
      slug,
      name: `Aula ${slug}`,
      adminEmail,
      primaryHostname,
    })) as { id: string };
    created.push(tenant.id);
    return { tenantId: tenant.id, slug, adminEmail };
  }

  it('subdominio de plataforma: el enlace va a <slug>.didacta.io y su token es del aula nueva', async () => {
    const hostname = `aula-${randomUUID().slice(0, 8)}.didacta.io`;
    const { tenantId, adminEmail } = await crearDesdeCloud(hostname);

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe(adminEmail);

    for (const body of [mail.html, mail.text]) {
      const link = resetLink(body);
      expect(link.origin).toBe(`https://${hostname}`);
      expect(body).not.toContain('pool.didacta.io/reset-password');
    }

    // El token del enlace es un token de restablecer del aula NUEVA, para su
    // administradora: el enlace sirve en ese dominio y en ningún otro.
    const raw = resetLink(mail.text).searchParams.get('token')!;
    const row = await admin.passwordResetToken.findUnique({
      where: { tokenHash: createHash('sha256').update(raw, 'utf8').digest('hex') },
      select: { tenantId: true, userId: true },
    });
    expect(row?.tenantId).toBe(tenantId);
    const owner = await admin.user.findUnique({
      where: { id: row!.userId },
      select: { email: true, tenantId: true },
    });
    expect(owner).toEqual({ email: adminEmail, tenantId });
  });

  it('el subdominio de plataforma nace primario y verificado (cuenta como dominio del aula)', async () => {
    const hostname = `aula-${randomUUID().slice(0, 8)}.didacta.io`;
    const { tenantId } = await crearDesdeCloud(hostname);
    const domains = await admin.tenantDomain.findMany({
      where: { tenantId },
      select: { hostname: true, isPrimary: true, isVerified: true },
    });
    expect(domains).toEqual([{ hostname, isPrimary: true, isVerified: true }]);
  });

  it('dominio propio como primario: el enlace va a ese dominio', async () => {
    const hostname = `aula.academia-${randomUUID().slice(0, 8)}.example`;
    await crearDesdeCloud(hostname);
    expect(sent).toHaveLength(1);
    expect(resetLink(sent[0]!.html).origin).toBe(`https://${hostname}`);
  });

  it('SEGURIDAD: la petición llega con un Host ajeno → el enlace sigue yendo al aula', async () => {
    const hostname = `aula-${randomUUID().slice(0, 8)}.didacta.io`;
    await crearDesdeCloud(hostname, 'atacante.example');
    expect(sent).toHaveLength(1);
    expect(resetLink(sent[0]!.html).origin).toBe(`https://${hostname}`);
    expect(sent[0]!.html).not.toContain('atacante.example');
  });
});
