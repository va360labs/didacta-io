/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Idioma del comprador en la bienvenida de la MEMBRESÍA (`membership.welcome`).
 *
 * Salía entera en español —asunto, cuerpo, botón «Definir mi contraseña» y la
 * nota del pie con la URL de acceso— aunque la fila del comprador dijera
 * `locale = 'en-US'`. Es el gemelo de `billing.welcome`, con su propio copy.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipProvisioningService } from '../src/modules/subscriptions/membership-provisioning.service';

const TENANT = 'tenant-1';
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' } as never;

function montar(createdLocale?: string) {
  const tx = {
    user: { create: vi.fn().mockResolvedValue({ id: 'user-nuevo', locale: createdLocale }) },
    userRole: { create: vi.fn() },
  };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-alumno' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Academia Demo' }) },
    modThemingTenantTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    notificationTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
  } as never;
  const passwords = { hash: vi.fn().mockResolvedValue('$argon2$hash') } as never;
  const passwordReset = {
    request: vi.fn().mockResolvedValue({ rawToken: 'tok-123' }),
  } as never;
  const smtpResolver = {
    resolve: vi.fn().mockResolvedValue({ config: { host: 'smtp.example.com' } }),
  } as never;
  const smtp = { send: vi.fn().mockResolvedValue({ ok: true }) } as never;
  const auditLog = { record: vi.fn() } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  const svc = new MembershipProvisioningService(
    prisma,
    passwords,
    passwordReset,
    smtpResolver,
    smtp,
    auditLog,
    logger,
  );
  return { svc, smtp };
}

const args = {
  tenantId: TENANT,
  email: 'compradora@example.com',
  name: 'Ana',
  webBaseUrl: 'https://academia.example.com',
  ctx: CTX,
};

async function enviar(createdLocale?: string) {
  const { svc, smtp } = montar(createdLocale);
  await svc.provision(args);
  return (smtp as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]![1] as {
    subject: string;
    text: string;
    html: string;
  };
}

describe('MembershipProvisioningService · idioma del comprador', () => {
  beforeEach(() => vi.clearAllMocks());

  it('comprador en-US: asunto, cuerpo, botón y pie en inglés', async () => {
    const mail = await enviar('en-US');
    expect(mail.subject).toBe('Your membership at Academia Demo');
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.text).toContain('Hi Ana,');
    expect(mail.text).toContain('Your membership at Academia Demo is active!');
    expect(mail.html).toContain('Set my password');
    expect(mail.html).toContain('you can sign in at');
    // El síntoma del bug: español dentro de un email inglés.
    expect(mail.html).not.toContain('Definir mi contraseña');
    expect(mail.html).not.toContain('Después podrás iniciar sesión');
  });

  it('comprador es-ES: byte a byte lo que ya recibía', async () => {
    const mail = await enviar('es-ES');
    expect(mail.subject).toBe('Tu membresía en Academia Demo');
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.text).toContain('Hola Ana,');
    expect(mail.text).toContain(
      '¡Tu membresía en Academia Demo está activa! Ya tienes acceso a todos los cursos incluidos.',
    );
    expect(mail.html).toContain('Definir mi contraseña');
    expect(mail.html).toContain(
      'Después podrás iniciar sesión desde https://academia.example.com/signin con tu email.',
    );
  });

  it('CAMINO DEGRADADO: fila sin locale o con uno sin catálogo → español', async () => {
    for (const locale of [undefined, '', '   ', 'pt-BR']) {
      vi.clearAllMocks();
      const mail = await enviar(locale);
      expect(mail.subject, String(locale)).toBe('Tu membresía en Academia Demo');
      expect(mail.html, String(locale)).toContain('<html lang="es">');
    }
  });
});
