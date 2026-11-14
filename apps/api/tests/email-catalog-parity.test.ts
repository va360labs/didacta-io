/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * GUARDA DE PARIDAD de TODO el copy de correos y notificaciones por idioma.
 *
 * Recorre cada tabla del catálogo (plantillas del hub, transaccionales, copy
 * fijo, ping de SMTP, invitación y términos del hub) y falla si un idioma
 * tiene una clave de menos (o de más) que el español, o si una pieza no lleva
 * EXACTAMENTE los mismos marcadores: `{{var}}`, la apertura `{{#var}}` /
 * `{{^var}}` y el cierre `{{/var}}` de cada sección, contados uno a uno. Es lo
 * que pasó con el resumen semanal: el portugués venía de una rama vieja y le
 * faltaba la sección `{{#unsubUrl}}…{{/unsubUrl}}` del pie de baja que develop
 * añadió después; el correo brasileño salía sin enlace para darse de baja.
 *
 * Los tests de cada tabla (`email-template-catalog.test.ts`, `hub-values`)
 * comprueban además que el texto está traducido. Este fichero es la red común:
 * una tabla NUEVA se añade a `TABLAS` y queda vigilada igual.
 */

import { describe, expect, it } from 'vitest';
import {
  FIXED_EMAIL_COPY,
  HUB_TEMPLATE_DEFAULTS_BY_LOCALE,
  HUB_TEMPLATE_LANGS,
  INVITATION_EMAIL_COPY,
  SMTP_SETTINGS_PING,
  TRANSACTIONAL_EMAIL_DEFS,
  TRANSACTIONAL_TEMPLATE_DEFAULTS_EN,
  TRANSACTIONAL_TEMPLATE_DEFAULTS_PT,
  type HubTemplateLang,
  type TemplateDef,
} from '../src/modules/notifications/email-template-catalog';
import { HUB_TERMS } from '../src/modules/notifications/hub-values';

/** Una pieza de copy: un texto suelto o una plantilla con asunto y cuerpo. */
type Piece = string | TemplateDef;

/** Una tabla del catálogo, con su contenido por idioma. */
interface Tabla {
  readonly nombre: string;
  readonly porIdioma: Readonly<Record<HubTemplateLang, Readonly<Record<string, Piece>>>>;
}

const TRANSACCIONALES_ES: Record<string, TemplateDef> = Object.fromEntries(
  TRANSACTIONAL_EMAIL_DEFS.map((d) => [d.key, { subject: d.defaultSubject, body: d.defaultBody }]),
);

const TABLAS: readonly Tabla[] = [
  { nombre: 'plantillas del hub', porIdioma: HUB_TEMPLATE_DEFAULTS_BY_LOCALE },
  {
    nombre: 'transaccionales',
    porIdioma: {
      es: TRANSACCIONALES_ES,
      en: TRANSACTIONAL_TEMPLATE_DEFAULTS_EN,
      pt: TRANSACTIONAL_TEMPLATE_DEFAULTS_PT,
    },
  },
  { nombre: 'copy fijo', porIdioma: FIXED_EMAIL_COPY },
  {
    // Una sola plantilla por idioma: se envuelve en una tabla de una clave.
    nombre: 'ping de SMTP',
    porIdioma: {
      es: { ping: SMTP_SETTINGS_PING.es },
      en: { ping: SMTP_SETTINGS_PING.en },
      pt: { ping: SMTP_SETTINGS_PING.pt },
    },
  },
  { nombre: 'invitación al aula', porIdioma: INVITATION_EMAIL_COPY },
  { nombre: 'términos del hub', porIdioma: HUB_TERMS },
];

/** Los textos de una pieza, con nombre: `clave`, o `clave.subject` y `clave.body`. */
function textos(clave: string, pieza: Piece): Array<[string, string | null]> {
  if (typeof pieza === 'string') return [[clave, pieza]];
  return [
    [`${clave}.subject`, pieza.subject],
    [`${clave}.body`, pieza.body],
  ];
}

/**
 * Los marcadores de un texto, CON su forma: `{{x}}`, `{{#x}}`, `{{^x}}` y
 * `{{/x}}` son distintos. Ordenados para comparar como multiconjunto: el orden
 * de las frases puede cambiar entre idiomas, el número de marcadores no.
 */
function marcadores(texto: string | null): string[] {
  return [...(texto ?? '').matchAll(/\{\{\s*([#^/]?)\s*(\w+)\s*\}\}/g)]
    .map((m) => `{{${m[1]}${m[2]}}}`)
    .sort();
}

/** Etiquetas HTML (la maqueta de la invitación lleva `<strong>`). */
function etiquetas(texto: string | null): string[] {
  return [...(texto ?? '').matchAll(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi)].map((m) => m[0]).sort();
}

/**
 * Las secciones tienen que quedar bien anidadas: cada `{{#x}}`/`{{^x}}` se
 * cierra con su `{{/x}}`, y en orden. Con los mismos marcadores pero
 * cruzados, `interpolate` dejaría texto suelto o se comería el resto.
 */
function seccionesBienAnidadas(texto: string | null): boolean {
  const pila: string[] = [];
  for (const m of (texto ?? '').matchAll(/\{\{\s*([#^/])\s*(\w+)\s*\}\}/g)) {
    if (m[1] === '/') {
      if (pila.pop() !== m[2]) return false;
    } else {
      pila.push(m[2] as string);
    }
  }
  return pila.length === 0;
}

const TRADUCIDOS = HUB_TEMPLATE_LANGS.filter((l) => l !== 'es');

describe('paridad del catálogo de correos por idioma', () => {
  it('toda tabla tiene exactamente los idiomas del catálogo', () => {
    for (const tabla of TABLAS) {
      expect(Object.keys(tabla.porIdioma).sort(), tabla.nombre).toEqual(
        [...HUB_TEMPLATE_LANGS].sort(),
      );
    }
  });

  describe.each(TABLAS)('$nombre', (tabla) => {
    const es = tabla.porIdioma.es;

    it.each(TRADUCIDOS)(
      '%s tiene las mismas claves que el español, ni una más ni una menos',
      (lang) => {
        const otras = tabla.porIdioma[lang];
        const faltan = Object.keys(es).filter((k) => !(k in otras));
        const sobran = Object.keys(otras).filter((k) => !(k in es));
        expect(faltan, `${tabla.nombre}: faltan en ${lang}`).toEqual([]);
        expect(sobran, `${tabla.nombre}: sobran en ${lang}`).toEqual([]);
      },
    );

    it.each(TRADUCIDOS)(
      '%s lleva los mismos marcadores {{…}} y etiquetas en cada pieza',
      (lang) => {
        const otras = tabla.porIdioma[lang];
        for (const [clave, piezaEs] of Object.entries(es)) {
          const pieza = otras[clave];
          if (pieza === undefined) continue; // Lo reporta el test de claves.
          const textosEs = textos(clave, piezaEs);
          const textosOtro = textos(clave, pieza);
          for (let i = 0; i < textosEs.length; i += 1) {
            const [nombre, textoEs] = textosEs[i]!;
            const textoOtro = textosOtro[i]![1];
            const donde = `${tabla.nombre} · ${lang} · ${nombre}`;
            // Un asunto nulo (sin asunto) lo es en todos los idiomas.
            expect(textoOtro === null, `${donde}: difiere en si existe`).toBe(textoEs === null);
            if (textoEs === null) continue;
            expect(textoOtro!.trim().length, `${donde}: vacío`).toBeGreaterThan(0);
            expect(marcadores(textoOtro), `${donde}: marcadores`).toEqual(marcadores(textoEs));
            expect(etiquetas(textoOtro), `${donde}: etiquetas HTML`).toEqual(etiquetas(textoEs));
            expect(seccionesBienAnidadas(textoOtro), `${donde}: secciones cruzadas`).toBe(true);
          }
        }
      },
    );
  });

  it('la guarda discrimina: detecta la sección de baja que le faltaba al resumen portugués', () => {
    // Control: el texto que traía la rama vieja (sin el pie de baja) NO pasa.
    const viejo =
      'Esta semana na comunidade:\n\n· {{mentionsCount}} menção(ões) nova(s)\n· {{repliesCount}} resposta(s) em tópicos dos quais você participou\n\nVeja todas na sua seção de menções. Desde o resumo anterior: {{sinceIso}}.';
    const es = HUB_TEMPLATE_DEFAULTS_BY_LOCALE.es['community.digest.weekly']!.body;
    expect(marcadores(viejo)).not.toEqual(marcadores(es));
    // Y una sección convertida en variable suelta tampoco: `{{unsubUrl}}` ≠ `{{#unsubUrl}}`.
    expect(marcadores('{{#unsubUrl}}x{{/unsubUrl}}')).not.toEqual(
      marcadores('{{unsubUrl}}x{{unsubUrl}}'),
    );
    expect(seccionesBienAnidadas('{{#a}}{{#b}}x{{/a}}{{/b}}')).toBe(false);
    // El de hoy sí pasa.
    expect(marcadores(HUB_TEMPLATE_DEFAULTS_BY_LOCALE.pt['community.digest.weekly']!.body)).toEqual(
      marcadores(es),
    );
  });
});
