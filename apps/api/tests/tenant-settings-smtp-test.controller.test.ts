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
function makeHarness(
  actorLocale: string | null,
  sendResult: { ok: boolean; messageId?: string; error?: string } = {
    ok: true,
    messageId: '<id>',
  },
) {
  const send = vi.fn().mockResolvedValue(sendResult);
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

/**
 * El MTA rechaza: `TENANT_SETTINGS_SMTP_TEST_FAILED`. El motivo del rechazo es
 * la información con la que el admin arregla la incidencia, y hasta ahora solo
 * viajaba incrustado en el `message` español — el front lo borraba al traducir
 * el code y el admin anglófono se quedaba con «SMTP failed.» a secas.
 */
describe('TenantSettingsController.testSmtp — diagnóstico del MTA', () => {
  async function rejectedBody(error?: string) {
    const { controller } = makeHarness('es-ES', { ok: false, ...(error ? { error } : {}) });
    try {
      await controller.testSmtp(ADMIN_USER as never);
    } catch (err) {
      return (err as { response: { message: string; code: string; detail?: string } }).response;
    }
    throw new Error('no lanzó');
  }

  it('el motivo del MTA viaja en `detail`, aparte del message (que no cambia)', async () => {
    const body = await rejectedBody('535 5.7.8 Username and Password not accepted');
    expect(body.code).toBe('TENANT_SETTINGS_SMTP_TEST_FAILED');
    expect(body.message).toBe('SMTP falló: 535 5.7.8 Username and Password not accepted');
    expect(body.detail).toBe('535 5.7.8 Username and Password not accepted');
  });

  it('CAMINO DEGRADADO: el MTA falla sin texto → NO se manda `detail`', async () => {
    // Sin `detail`, el front pinta el `message` crudo en vez de una frase
    // traducida con el hueco vacío. Es el único caso en que un admin anglófono
    // ve español aquí, y es deliberado: no hay diagnóstico que traducir.
    const body = await rejectedBody();
    expect(body.message).toBe('SMTP falló: sin detalle');
    expect(body.detail).toBeUndefined();
    expect('detail' in body).toBe(false);
  });
});
