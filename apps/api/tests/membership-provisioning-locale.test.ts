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

function montar(createdLocale?: string, existente?: { id: string } | null) {
  const tx = {
    user: { create: vi.fn().mockResolvedValue({ id: 'user-nuevo', locale: createdLocale }) },
    userRole: { create: vi.fn() },
  };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(existente ?? null) },
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
  return { svc, smtp, tx };
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

/**
 * La pieza de AGUAS ARRIBA: hasta ahora nadie escribía un locale distinto del
 * default en la fila del comprador, así que la fontanería de arriba estaba
 * completa pero un anglófono acababa con `es-ES` guardado igualmente.
 */
describe('MembershipProvisioningService · captura del idioma de la compra', () => {
  beforeEach(() => vi.clearAllMocks());

  it('el locale del checkout se persiste en la fila del comprador nuevo', async () => {
    const { svc, tx } = montar('en-US');
    await svc.provision({ ...args, locale: 'en-US' });
    expect(tx.user.create.mock.calls[0]![0].data.locale).toBe('en-US');
  });

  it('a un comprador que YA existe no se le pisa su idioma', async () => {
    // Comprar otra vez desde la web en inglés no puede cambiarle a alguien la
    // preferencia que guardó en su perfil.
    const { svc, tx, smtp } = montar(undefined, { id: 'user-viejo' });
    const out = await svc.provision({ ...args, locale: 'en-US' });
    expect(out).toEqual({ userId: 'user-viejo', created: false });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect((smtp as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('CAMINO DEGRADADO: sin locale o con uno que la API no persiste, el campo se OMITE', async () => {
    // Omitirlo (en vez de escribir el de referencia a mano) deja que la columna
    // tome su default de BD, que es exactamente `HUB_DEFAULT_LOCALE`.
    for (const locale of [undefined, '', '   ', 'pt-BR', 'en', 'zz-ZZ', '../etc']) {
      vi.clearAllMocks();
      const { svc, tx } = montar();
      await svc.provision({ ...args, locale });
      expect(tx.user.create.mock.calls[0]![0].data, String(locale)).not.toHaveProperty('locale');
    }
  });

  it('los tres locales que la API persiste llegan enteros', async () => {
    for (const locale of ['es-ES', 'es-AR', 'en-US']) {
      vi.clearAllMocks();
      const { svc, tx } = montar();
      await svc.provision({ ...args, locale });
      expect(tx.user.create.mock.calls[0]![0].data.locale, locale).toBe(locale);
    }
  });
});
