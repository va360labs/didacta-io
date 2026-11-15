/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  marcasEstado,
  marcasTipo,
  PLANTILLA_TICKET_ESTADO,
  PLANTILLA_TICKET_NUEVO,
  type EstadoTicket,
  type TipoTicket,
} from '@didacta/mod-soporte';
import { describe, expect, it } from 'vitest';
import {
  buildEmailTemplateCatalog,
  HUB_TEMPLATE_DEFAULTS_BY_LOCALE,
  interpolate,
  resolveHubDefault,
  type HubTemplateLang,
} from '../src/modules/notifications/email-template-catalog';

/**
 * Los avisos de «Ayuda y sugerencias» los envía el servicio del módulo con las
 * claves `PLANTILLA_TICKET_*` y SIN texto en español dentro: el tipo y el
 * estado llegan como marcas y cada idioma pone su frase. Aquí se renderiza
 * cada plantilla en es, en y pt con las marcas REALES del módulo
 * (`marcasTipo`, `marcasEstado`): si una marca cambia de nombre, la frase
 * desaparecería del correo y esto lo caza.
 */

function render(lang: HubTemplateLang, key: string, vars: Record<string, unknown>) {
  const def = HUB_TEMPLATE_DEFAULTS_BY_LOCALE[lang][key]!;
  return { subject: interpolate(def.subject!, vars), body: interpolate(def.body, vars) };
}

const nuevo = (tipo: TipoTicket, extra: Record<string, unknown> = {}) => ({
  ticketId: 't-1',
  autorNombre: 'Ana López',
  extracto: 'No carga el vídeo de la clase 3',
  ...marcasTipo(tipo),
  ticketUrl: 'https://aula.didacta.io/admin/support?ticket=t-1',
  ...extra,
});

const estado = (e: EstadoTicket, tipo: TipoTicket = 'PROBLEMA') => ({
  ticketId: 't-1',
  extracto: 'No puedo entrar',
  ...marcasTipo(tipo),
  ...marcasEstado(e),
  ticketUrl: 'https://aula.didacta.io/support?ticket=t-1',
});

describe('plantillas de mod.soporte', () => {
  it.each([PLANTILLA_TICKET_NUEVO, PLANTILLA_TICKET_ESTADO])(
    '%s existe en el catálogo del hub, en la campana y por correo, en los tres idiomas',
    (key) => {
      const entry = buildEmailTemplateCatalog().find((e) => e.key === key);
      expect(entry).toMatchObject({ source: 'hub', category: 'system' });
      expect([...entry!.channels].sort()).toEqual(['EMAIL', 'IN_APP']);
      for (const lang of ['es', 'en', 'pt'] as const) {
        expect(HUB_TEMPLATE_DEFAULTS_BY_LOCALE[lang][key], `${lang} ${key}`).toBeDefined();
      }
    },
  );

  it('ticket nuevo en español: quién, de qué tipo, el principio del texto y el enlace', () => {
    const r = render('es', PLANTILLA_TICKET_NUEVO, nuevo('FALLO'));
    expect(r.subject).toBe('Ticket de soporte: Ana López avisa de que algo no funciona');
    expect(r.body).toContain(
      'Ana López ha abierto un ticket en «Ayuda y sugerencias» (algo no funciona)',
    );
    expect(r.body).toContain('«No carga el vídeo de la clase 3»');
    expect(r.body).toContain('https://aula.didacta.io/admin/support?ticket=t-1');
  });

  it('ticket nuevo en inglés y en portugués (escola, no academia)', () => {
    const en = render('en', PLANTILLA_TICKET_NUEVO, nuevo('MEJORA'));
    expect(en.subject).toBe('Support ticket: Ana López left you a suggestion');
    expect(en.body).toContain('opened a ticket in "Help & feedback" (a suggestion)');
    const pt = render('pt', PLANTILLA_TICKET_NUEVO, nuevo('PROBLEMA'));
    expect(pt.subject).toBe('Ticket de suporte: Ana López está com um problema');
    expect(pt.body).toContain('abriu um ticket em "Ajuda e sugestões" (um problema)');
    expect(`${pt.subject} ${pt.body}`).not.toMatch(/academia/i);
  });

  it('sin nombre de cuenta, cada idioma dice «un miembro» a su manera', () => {
    const sin = nuevo('FALLO', { autorNombre: '' });
    expect(render('es', PLANTILLA_TICKET_NUEVO, sin).body).toMatch(/^Un miembro ha abierto/);
    expect(render('en', PLANTILLA_TICKET_NUEVO, sin).body).toMatch(/^A member opened/);
    expect(render('pt', PLANTILLA_TICKET_NUEVO, sin).body).toMatch(/^Um membro abriu/);
  });

  it('sin dirección del aula, el correo dice dónde encontrarlo en vez del enlace', () => {
    const sin = nuevo('FALLO', { ticketUrl: '' });
    expect(render('es', PLANTILLA_TICKET_NUEVO, sin).body).toContain(
      'Lo tienes en Administración → Tickets de soporte.',
    );
    expect(render('en', PLANTILLA_TICKET_NUEVO, sin).body).toContain('Admin → Support tickets');
  });

  it.each([
    ['es', 'EN_CURSO', 'Tu ticket de soporte está en curso', '«En curso»'],
    ['es', 'RESUELTO', 'Tu ticket de soporte está resuelto', '«Resuelto»'],
    ['en', 'RESUELTO', 'Your support ticket is resolved', '"Resolved"'],
    ['en', 'DESCARTADO', 'Your support ticket is dismissed', '"Dismissed"'],
    ['pt', 'EN_CURSO', 'Seu ticket de suporte está em andamento', '"Em andamento"'],
    ['pt', 'NUEVO', 'Seu ticket de suporte está aberto de novo', '"Novo"'],
  ] as const)('cambio de estado en %s a %s', (lang, e, subject, enCuerpo) => {
    const r = render(lang, PLANTILLA_TICKET_ESTADO, estado(e));
    expect(r.subject).toBe(subject);
    expect(r.body).toContain(enCuerpo);
    expect(r.body).not.toContain('{{');
  });

  it('el cambio de estado nunca menciona la nota interna, en ningún idioma', () => {
    for (const lang of ['es', 'en', 'pt'] as const) {
      const def = resolveHubDefault(PLANTILLA_TICKET_ESTADO, lang)!;
      expect(`${def.subject} ${def.body}`).not.toMatch(/nota|note/i);
    }
  });

  it('con las marcas reales, ninguna plantilla deja un hueco ni un {{ sin resolver', () => {
    for (const lang of ['es', 'en', 'pt'] as const) {
      for (const tipo of ['FALLO', 'PROBLEMA', 'MEJORA'] as const) {
        const r = render(lang, PLANTILLA_TICKET_NUEVO, nuevo(tipo));
        expect(r.subject).not.toMatch(/\{\{|: $| $|\(\)/);
        expect(r.body).not.toMatch(/\{\{|\(\)/);
        for (const e of ['NUEVO', 'EN_CURSO', 'RESUELTO', 'DESCARTADO'] as const) {
          const s = render(lang, PLANTILLA_TICKET_ESTADO, estado(e, tipo));
          expect(s.subject).not.toMatch(/\{\{| $/);
          expect(s.body).not.toMatch(/\{\{|\(\)|«»|""/);
        }
      }
    }
  });
});
