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
import { deriveSmtpStatus, shouldShowSmtpBanner, type AdminSmtpDto } from '@/lib/admin-smtp';
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
