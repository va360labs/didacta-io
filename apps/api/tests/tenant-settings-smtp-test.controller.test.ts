/**
 * `POST /tenant-settings/notifications/smtp/test` — el ping de diagnóstico que
 * un admin se manda a SÍ MISMO para comprobar que el SMTP del tenant funciona.
 *
 * Lo que cubre este fichero es el IDIOMA del correo: el destinatario es el
 * propio admin (`to: me.email`), así que el ping tiene que salir en su lengua.
 * Antes estaba cableado en español y un admin anglófono recibía un correo que
 * no podía leer para verificar una configuración técnica.
 *
 * El español se comprueba byte a byte: cambiarlo no era el objetivo.
 */

import { describe, expect, it, vi } from 'vitest';
import { TenantSettingsController } from '../src/modules/tenant-settings.controller';

const TENANT_A = 'tenant-a';
const ADMIN_USER = { sub: 'user-1', tenantId: TENANT_A, roles: ['tenant_admin'] };

const SMTP_RAW = { host: 'h', port: 587, username: 'u', password: 'p', fromEmail: 'f@x.test' };

/**
 * `actorLocale = null` simula que el admin no tiene fila en este tenant (el
 * controller responde 400 sin enviar nada, comportamiento previo).
 */
function makeHarness(actorLocale: string | null) {
  const send = vi.fn().mockResolvedValue({ ok: true, messageId: '<id>' });
  const modules = {
    getTenantConfig: () => ({ get: vi.fn().mockResolvedValue(SMTP_RAW) }),
    getSmtpAdapter: () => ({ parseConfig: (raw: unknown) => raw, send }),
  };
  const prisma = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          actorLocale === null
            ? null
            : { email: 'admin@test.com', tenantId: TENANT_A, locale: actorLocale },
        ),
    },
    tenant: { findUnique: vi.fn().mockResolvedValue({ slug: 'demo' }) },
  };
  const controller = new TenantSettingsController(modules as never, prisma as never);
  return { controller, send };
}

async function sent(actorLocale: string) {
  const { controller, send } = makeHarness(actorLocale);
  await controller.testSmtp(ADMIN_USER as never);
  return send.mock.calls[0]![1] as { subject: string; text: string };
}

describe('TenantSettingsController.testSmtp — idioma del ping', () => {
  it('es-ES sale byte a byte igual que antes', async () => {
    const msg = await sent('es-ES');
    expect(msg.subject).toBe('Prueba de SMTP — Didacta');
    expect(msg.text).toBe(
      `Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\nTenant: demo\nFecha: ${msg.text.split('Fecha: ')[1]}`,
    );
    expect(msg.text).toMatch(/Fecha: \d{4}-\d{2}-\d{2}T/);
  });

  it('en-US sale en inglés, asunto incluido', async () => {
    const msg = await sent('en-US');
    expect(msg.subject).toBe('SMTP test — Didacta');
    expect(msg.text).toContain(
      'If you received this email, the SMTP configuration of your tenant in Didacta is working correctly.',
    );
    expect(msg.text).toContain('Tenant: demo');
    expect(msg.text).toMatch(/Date: \d{4}-\d{2}-\d{2}T/);
    expect(msg.text).not.toContain('Fecha:');
    expect(msg.text).not.toContain('Prueba de SMTP');
  });

  it('CAMINO DEGRADADO: locale en blanco o sin traducir → español', async () => {
    for (const locale of ['', '   ', 'pt-BR', 'es-AR']) {
      const msg = await sent(locale);
      expect(msg.subject, locale).toBe('Prueba de SMTP — Didacta');
      expect(msg.text, locale).toContain('funciona correctamente');
    }
  });

  it('sin fila de admin en el tenant sigue siendo 400 y NO manda nada', async () => {
    const { controller, send } = makeHarness(null);
    await expect(controller.testSmtp(ADMIN_USER as never)).rejects.toThrow(
      /No se pudo resolver tu email/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
