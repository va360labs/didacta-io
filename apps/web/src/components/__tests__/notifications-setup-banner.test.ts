/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Aviso superior de «los correos no se pueden enviar» (`NotificationsSetupBanner`).
 *
 *  - Un aula de Cloud sin servidor propio cuyo correo sale por el de la
 *    plataforma (SMTP compartido del despliegue → `hasGlobalFallback`) no lo
 *    ve: no hay nada que arreglar.
 *  - El aula que tiene que conectar su propio servicio sí, y el texto va en
 *    lenguaje llano: sin «SMTP» ni «servidor», en es y en.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveSmtpStatus,
  isSmtpSettingsRoute,
  shouldShowSmtpBanner,
  type AdminSmtpDto,
} from '@/lib/admin-smtp';
import esSso from '@/i18n/messages/es/adminSso.json';
import enSso from '@/i18n/messages/en/adminSso.json';
import esShell from '@/i18n/messages/es/shell.json';
import enShell from '@/i18n/messages/en/shell.json';

const ADMIN = ['tenant_admin'];

function dto(over: Partial<AdminSmtpDto>): AdminSmtpDto {
  return {
    host: null,
    port: null,
    encryption: null,
    secure: null,
    username: null,
    hasPassword: false,
    fromEmail: null,
    fromName: null,
    verifiedAt: null,
    verifiedByUserId: null,
    hasTenantConfig: false,
    hasGlobalFallback: false,
    ...over,
  };
}

describe('NotificationsSetupBanner — a quién se le enseña', () => {
  it('aula de Cloud cuyo correo sale por el de la plataforma: no hay aviso', () => {
    expect(shouldShowSmtpBanner(ADMIN, deriveSmtpStatus(dto({ hasGlobalFallback: true })))).toBe(
      false,
    );
  });

  it('aula sin correo propio ni de la plataforma: aviso para conectarlo', () => {
    expect(shouldShowSmtpBanner(ADMIN, deriveSmtpStatus(dto({})))).toBe(true);
  });
});

describe('NotificationsSetupBanner — texto sin jerga', () => {
  it.each([
    ['es', esShell.smtpBanner],
    ['en', enShell.smtpBanner],
  ])('%s: ni «SMTP» ni «servidor»', (_lang, copy) => {
    const text = `${copy.title} ${copy.body} ${copy.cta}`;
    expect(text).not.toMatch(/smtp/i);
    expect(text).not.toMatch(/servidor|server/i);
  });
});

describe('un solo aviso en la pantalla del correo (con la tarjeta de beta.13)', () => {
  it('en Configuración no se pinta la cabecera: la tarjeta ya lo explica', () => {
    expect(isSmtpSettingsRoute('/admin/configuracion')).toBe(true);
    expect(isSmtpSettingsRoute('/admin/cobros')).toBe(false);
    expect(isSmtpSettingsRoute(null)).toBe(false);
  });

  it('los avisos de la tarjeta, en llano y sin «SMTP», «fallback» ni «tenant»', () => {
    for (const sso of [esSso, enSso]) {
      for (const text of [sso.smtp.bannerNone, sso.smtp.bannerFallback]) {
        expect(text).not.toMatch(/SMTP|fallback|tenant|host/i);
      }
    }
    // Coherente con la tarjeta de respuestas: los correos salen con el nombre de la academia.
    expect(esSso.smtp.bannerFallback).toMatch(/nombre de tu academia/);
  });
});
