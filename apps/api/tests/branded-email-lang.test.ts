/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Idioma del ENVOLTORIO de marca de los emails.
 *
 * `renderBrandedEmail` emitía `<html lang="es">` fijo para los 23 emisores del
 * producto. Un email en inglés salía marcado como español: un lector de
 * pantalla lo lee con la voz equivocada y Gmail ofrece «¿traducir este
 * mensaje?» sobre un texto que ya está en el idioma del lector.
 *
 * En el mismo envoltorio viajan dos piezas ESTRUCTURALES (un override de tenant
 * no las puede quitar) que también estaban cableadas en español: el botón CTA y
 * la nota del footer del NotificationHub. El cuerpo ya salía traducido, así que
 * un miembro con `locale = en-US` recibía un email inglés con el botón en
 * español.
 *
 * El español se comprueba byte a byte: no cambia nada de lo que recibe hoy.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderBrandedEmail, type EmailBranding } from '../src/common/branded-email';
import {
  HUB_TEMPLATE_LANGS,
  type HubTemplateLang,
} from '../src/modules/notifications/email-template-catalog';
import { PrismaNotificationHubService } from '../src/modules/prisma-notification-hub.service';
import { SmtpAdapterService } from '../src/modules/smtp-adapter.service';

const BRANDING: EmailBranding = {
  tenantName: 'Academia Demo',
  logoUrl: null,
  brandColor: '#123456',
};

describe('renderBrandedEmail · atributo lang', () => {
  it('el <html> sale en el idioma del contenido, no siempre en español', () => {
    const es = renderBrandedEmail(BRANDING, {
      lang: 'es',
      title: 'Hola',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
    });
    const en = renderBrandedEmail(BRANDING, {
      lang: 'en',
      title: 'Hello',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
    });
    expect(es.html).toContain('<html lang="es">');
    expect(en.html).toContain('<html lang="en">');
    expect(en.html).not.toContain('lang="es"');
  });

  it('`EmailLang` declara los MISMOS idiomas que el catálogo del hub', () => {
    // `branded-email.ts` redeclara la lista para seguir siendo un fichero hoja
    // sin dependencias. Este test es lo que impide que las dos se separen.
    const declarados: HubTemplateLang[] = ['es', 'en'];
    expect([...HUB_TEMPLATE_LANGS].sort()).toEqual([...declarados].sort());
  });
});

// ---------------------------------------------------------------------------
// NotificationHub: envoltorio en el idioma del destinatario
// ---------------------------------------------------------------------------

const VALID_SMTP = {
  host: 'smtp.brevo.com',
  port: 587,
  user: 'foo',
  password: 'p4ss',
  from: 'noreply@x.com',
};

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function makePrisma(locale: string) {
  const rows: Array<Record<string, unknown>> = [];
  let next = 1;
  return {
    _rows: rows,
    userNotificationPreference: { findUnique: async () => null },
    user: {
      findUnique: async (args: { where: { id?: string } }) =>
        args.where.id === 'u1' ? { id: 'u1', tenantId: 't1', email: 'a@b.com', locale } : null,
      findFirst: async () => ({ id: 'u1', tenantId: 't1', email: 'a@b.com', locale }),
    },
    notification: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `n${next++}`, ...args.data };
        rows.push(row);
        return row;
      },
      update: async () => ({}),
    },
    notificationTemplate: { findUnique: async () => null },
    tenant: { findUnique: async () => ({ name: 'Academia Demo' }) },
    modThemingTenantTheme: { findUnique: async () => null },
  };
}

function makeTenantConfig() {
  return {
    get: async (_tenantId: string, moduleName: string, key: string) =>
      moduleName === 'notifications' && key === 'smtp' ? VALID_SMTP : undefined,
  } as never;
}

/** Manda `enrollment.created` por email y devuelve el HTML que salió al MTA. */
async function sentHtml(locale: string): Promise<string> {
  // El CTA solo se añade si hay URL pública: sin ella no habría botón que
  // comprobar.
  process.env['WEB_PUBLIC_URL'] = 'https://demo.test';
  const prisma = makePrisma(locale);
  const send = vi.fn(async (_config: unknown, _message: { html: string }) => ({
    ok: true,
    messageId: '<id>',
  }));
  const smtp = {
    parseConfig: (raw: unknown) => raw,
    isConfigValid: () => true,
    send,
    verify: vi.fn(),
  } as unknown as SmtpAdapterService;
  const svc = new PrismaNotificationHubService(
    prisma as never,
    noopLogger,
    makeTenantConfig(),
    smtp,
  );
  await svc.send({
    tenantId: 't1',
    channel: 'email',
    templateKey: 'enrollment.created',
    to: 'u1',
    variables: { course: 'Curso A' },
  });
  expect(send, `no se llegó a enviar nada para locale=${locale}`).toHaveBeenCalled();
  return (send.mock.calls[0]![1] as { html: string }).html;
}

describe('NotificationHub · el envoltorio sale en el idioma del destinatario', () => {
  it('destinatario en-US: <html lang="en">, botón y footer en inglés', async () => {
    const html = await sentHtml('en-US');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Go to Academia Demo');
    expect(html).toContain('You received this email as a member of Academia Demo.');
    // El síntoma del bug: botón español dentro de un email inglés.
    expect(html).not.toContain('Entrar a Academia Demo');
    expect(html).not.toContain('Recibiste este correo');
  });

  it('destinatario es-ES: byte a byte lo que ya recibía', async () => {
    const html = await sentHtml('es-ES');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('Entrar a Academia Demo');
    expect(html).toContain('Recibiste este correo como miembro de Academia Demo.');
  });

  it('CAMINO DEGRADADO: locale sin catálogo (pt-BR) cae al español, no a un hueco', async () => {
    // `pt-BR` es alcanzable HOY (lo admite `ALLOWED_LOCALES` de me.controller).
    const html = await sentHtml('pt-BR');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('Entrar a Academia Demo');
  });
});
