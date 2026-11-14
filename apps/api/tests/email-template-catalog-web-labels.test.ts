/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * CONTRATO entre el catálogo de plantillas de la API y su traducción en la web.
 *
 * `buildEmailTemplateCatalog()` manda el nombre, la descripción, la nota
 * estructural y la descripción de cada variable de cada plantilla SOLO en
 * español: la API no traduce textos de UI (decisión D6). La pantalla
 * `/admin/emails` (`apps/web/src/modules/notifications/admin-templates-card.tsx`)
 * los traduce por clave estable desde `modNotifications.templates.<key>`, con
 * los puntos de la key cambiados por `_` (next-intl usa el punto para anidar).
 *
 * Si la web no encuentra la clave, pinta el texto de la API: un aula en inglés
 * o en portugués vería esa plantilla en español sin que falle nada. Este test
 * lo convierte en fallo, en los dos sentidos:
 *
 *  - CADA entrada y CADA variable del catálogo de la API tiene su clave en los
 *    tres idiomas, y el `es` es byte a byte el texto de la API (cambiar el
 *    texto en la API sin tocar la web también falla);
 *  - la web no guarda claves de plantillas o variables que la API ya no tiene.
 *
 * Los JSON se leen del disco (mismo patrón que `api-error-detail-contract`):
 * la web no puede importar el catálogo de la API.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildEmailTemplateCatalog,
  HUB_TEMPLATE_LANGS,
  type EmailTemplateCatalogEntry,
  type HubTemplateLang,
} from '../src/modules/notifications/email-template-catalog';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.join(TESTS_DIR, '..', '..', 'web', 'src');
const MESSAGES = path.join(WEB_SRC, 'i18n', 'messages');
const COMPONENT = path.join(WEB_SRC, 'modules', 'notifications', 'admin-templates-card.tsx');

interface TemplateLabels {
  name?: unknown;
  description?: unknown;
  structuralNote?: unknown;
  vars?: Record<string, unknown>;
}

/** Misma transformación que `templateLabelKey` del componente (sin el prefijo). */
function slug(key: string): string {
  return key.replace(/\./g, '_');
}

function templatesOf(lang: HubTemplateLang): Record<string, TemplateLabels> {
  const json = JSON.parse(
    readFileSync(path.join(MESSAGES, lang, 'modNotifications.json'), 'utf8'),
  ) as { templates?: Record<string, TemplateLabels> };
  return json.templates ?? {};
}

const CATALOG: EmailTemplateCatalogEntry[] = buildEmailTemplateCatalog();
const LABELS = Object.fromEntries(HUB_TEMPLATE_LANGS.map((l) => [l, templatesOf(l)])) as Record<
  HubTemplateLang,
  Record<string, TemplateLabels>
>;

describe('textos de /admin/emails: catálogo de la API ↔ catálogo de la web', () => {
  it('el componente busca las claves con la misma transformación que este test', () => {
    // Si alguien cambia la forma de la clave en la web, este test seguiría
    // comprobando la vieja y la pantalla caería al español sin avisar.
    const source = readFileSync(COMPONENT, 'utf8');
    expect(source).toContain("`templates.${key.replace(/\\./g, '_')}`");
  });

  it('la transformación de la key no junta dos plantillas en la misma clave', () => {
    const slugs = CATALOG.map((e) => slug(e.key));
    expect(new Set(slugs).size).toBe(CATALOG.length);
  });

  it('ningún texto de la API lleva caracteres que ICU interpretaría ({ } <)', () => {
    // La web pinta estos textos con `t(key)`: una llave o una etiqueta se
    // leerían como argumento o rich text, y el `es` ya no podría ser el texto
    // de la API byte a byte.
    for (const e of CATALOG) {
      const textos = [
        e.name,
        e.description,
        e.structuralNote ?? '',
        ...e.variables.map((v) => v.description),
      ];
      for (const texto of textos) expect(texto, e.key).not.toMatch(/[{}<]/);
    }
  });

  for (const lang of HUB_TEMPLATE_LANGS) {
    describe(`idioma ${lang}`, () => {
      it('tiene EXACTAMENTE las plantillas del catálogo de la API', () => {
        expect(Object.keys(LABELS[lang]).sort()).toEqual(CATALOG.map((e) => slug(e.key)).sort());
      });

      it('cada plantilla tiene nombre, descripción, nota estructural y variables', () => {
        for (const e of CATALOG) {
          const l = LABELS[lang][slug(e.key)];
          expect(l, e.key).toBeDefined();
          expect(typeof l!.name === 'string' && l!.name.length > 0, `${e.key}.name`).toBe(true);
          expect(
            typeof l!.description === 'string' && l!.description.length > 0,
            `${e.key}.description`,
          ).toBe(true);
          // La nota solo existe si la API la manda (la web solo la pinta entonces).
          if (e.structuralNote) {
            expect(typeof l!.structuralNote, `${e.key}.structuralNote`).toBe('string');
          } else {
            expect(l!.structuralNote, `${e.key}.structuralNote sobra`).toBeUndefined();
          }
          expect(Object.keys(l!.vars ?? {}).sort(), `${e.key}.vars`).toEqual(
            e.variables.map((v) => v.name).sort(),
          );
          for (const v of e.variables) {
            const d = l!.vars?.[v.name];
            expect(typeof d === 'string' && d.length > 0, `${e.key}.vars.${v.name}`).toBe(true);
          }
        }
      });
    });
  }

  it('el español es byte a byte el texto que manda la API', () => {
    for (const e of CATALOG) {
      const l = LABELS.es[slug(e.key)]!;
      expect(l.name, `${e.key}.name`).toBe(e.name);
      expect(l.description, `${e.key}.description`).toBe(e.description);
      if (e.structuralNote)
        expect(l.structuralNote, `${e.key}.structuralNote`).toBe(e.structuralNote);
      for (const v of e.variables) {
        expect(l.vars?.[v.name], `${e.key}.vars.${v.name}`).toBe(v.description);
      }
    }
  });

  it('inglés y portugués están traducidos, no copiados del español', () => {
    // La descripción es siempre una frase entera: si coincide con la española,
    // es que se copió. (El nombre puede coincidir: «Certificado emitido».)
    for (const lang of HUB_TEMPLATE_LANGS.filter((l) => l !== 'es')) {
      for (const e of CATALOG) {
        expect(LABELS[lang][slug(e.key)]!.description, `${lang} ${e.key}`).not.toBe(e.description);
      }
    }
  });

  it('muestras concretas en inglés y en portugués de Brasil', () => {
    // «Clase» de una lección es «aula» en portugués; la de Zoom, «aula ao vivo».
    expect(LABELS.en.lesson_unlocked!.name).toBe('Lesson unlocked');
    expect(LABELS.pt.lesson_unlocked!.name).toBe('Aula desbloqueada');
    expect(LABELS.pt.zoom_class_cancelled!.name).toBe('Aula ao vivo cancelada');
    // La membresía es «assinatura» y el botón citado es el del correo en pt.
    expect(LABELS.pt.membership_welcome!.name).toBe('Boas-vindas da assinatura');
    expect(LABELS.pt.membership_welcome!.structuralNote).toContain('“Definir minha senha”');
    // Variables: el saludo cita el que de verdad escribe `emailGreeting`.
    expect(LABELS.en.auth_password_reset!.vars?.greeting).toBe('Greeting (“Hi Name,” or “Hi,”)');
    expect(LABELS.pt.auth_password_reset!.vars?.greeting).toBe('Saudação (“Olá, Nome!” ou “Olá!”)');
    expect(LABELS.pt.enrollment_created!.vars?.tenantName).toBe('Nome da plataforma');
  });
});
