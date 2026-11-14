/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Idioma del evento de calendario de una clase en directo (`.ics`, Google y
 * Outlook). Los enlaces son públicos (se abren desde el correo, sin token), así
 * que el idioma sale de la cookie de idioma de la web (`didacta_locale`) de
 * quien lo abre y, si no la manda, del aula dueña de la clase. En español el
 * texto no cambia ni un byte.
 */

import { describe, expect, it, vi } from 'vitest';
import { ZoomCalendarController } from '../src/modules/zoom-live/zoom-calendar.controller';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';
const AULA = 'https://escola.example.test';

function makeController(aula: { setting?: string } = {}) {
  const zoom = {
    getCalendarInfo: vi.fn().mockResolvedValue({
      id: SESSION,
      tenantId: TENANT,
      topic: 'Café especial',
      startTime: new Date('2026-12-01T16:00:00.000Z'),
      durationMinutes: 60,
      timezone: 'America/Sao_Paulo',
      status: 'SCHEDULED',
      organizerName: 'Escola do Café',
    }),
  };
  const registry = { getZoomLiveService: () => zoom } as never;
  const tenantResolver = {
    resolveTenantWebBaseUrlForBackground: vi.fn(async () => AULA),
  } as never;
  // Lo justo de Prisma para `academyLocale`: el ajuste del aula y nada más.
  const prisma = {
    tenantSetting: {
      findUnique: vi.fn(
        async (q: { where: { tenantId_moduleName_key: { moduleName: string; key: string } } }) =>
          q.where.tenantId_moduleName_key.moduleName === 'academy' && aula.setting
            ? { valueJson: aula.setting }
            : null,
      ),
    },
    user: { findMany: vi.fn(async () => []) },
  } as never;
  return new ZoomCalendarController(registry, tenantResolver, prisma);
}

function makeReply() {
  const sent: { body?: string; headers: Record<string, string>; code?: number } = { headers: {} };
  const reply = {
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    code(n: number) {
      sent.code = n;
      return reply;
    },
    send(body?: string) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as never, sent };
}

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as never;

/** Deshace el plegado RFC 5545 y el escapado de TEXT para leer la descripción. */
function description(ics: string): string {
  const line = ics
    .replace(/\r\n /g, '')
    .split('\r\n')
    .find((l) => l.startsWith('DESCRIPTION:'))!;
  return line
    .slice('DESCRIPTION:'.length)
    .replace(/\\n/g, '\n')
    .replace(/\\([,;\\])/g, '$1');
}

describe('ZoomCalendarController · idioma del evento', () => {
  it('cookie pt-BR: descripción y nombre del fichero en portugués', async () => {
    const { reply, sent } = makeReply();
    await makeController().ics(SESSION, reply, req('didacta_locale=pt-BR'));
    expect(description(sent.body!)).toBe(
      `Aula ao vivo — Escola do Café.\n\nEntre pela página da aula: ${AULA}/live/${SESSION}`,
    );
    expect(sent.headers['Content-Disposition']).toBe(`attachment; filename="aula-${SESSION}.ics"`);
    // El título es el de la clase: no se traduce.
    expect(sent.body).toContain('SUMMARY:Café especial');
  });

  it('sin cookie: el idioma del aula (aquí, portugués)', async () => {
    const { reply, sent } = makeReply();
    await makeController({ setting: 'pt' }).google(SESSION, reply, req());
    expect(sent.code).toBe(302);
    const details = new URL(sent.headers['Location']!).searchParams.get('details');
    expect(details).toBe(
      `Aula ao vivo — Escola do Café.\n\nEntre pela página da aula: ${AULA}/live/${SESSION}`,
    );
  });

  it('la cookie de quien lo abre manda sobre el idioma del aula', async () => {
    const { reply, sent } = makeReply();
    await makeController({ setting: 'pt' }).outlook(SESSION, reply, req('didacta_locale=en-US'));
    expect(new URL(sent.headers['Location']!).searchParams.get('body')).toBe(
      `Live class by Escola do Café. Join from: ${AULA}/live/${SESSION}`,
    );
  });

  it('una cookie sin catálogo (fr-FR) no cuenta: queda el idioma del aula', async () => {
    const { reply, sent } = makeReply();
    await makeController({ setting: 'pt' }).office365(SESSION, reply, req('didacta_locale=fr-FR'));
    expect(new URL(sent.headers['Location']!).searchParams.get('body')).toBe(
      `Aula ao vivo — Escola do Café. Entre por: ${AULA}/live/${SESSION}`,
    );
  });

  it('sin cookie ni ajuste: el español de siempre, byte a byte', async () => {
    const { reply, sent } = makeReply();
    await makeController().ics(SESSION, reply, req());
    expect(description(sent.body!)).toBe(
      `Clase en directo de Escola do Café.\n\nEntra desde la página de la clase: ${AULA}/live/${SESSION}`,
    );
    expect(sent.headers['Content-Disposition']).toBe(`attachment; filename="clase-${SESSION}.ics"`);
  });
});
