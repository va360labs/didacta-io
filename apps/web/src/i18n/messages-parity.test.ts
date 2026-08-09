/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Guarda de paridad es ↔ en de TODOS los namespaces del catálogo.
 *
 * Antes de este test solo `nav.json` tenía guarda (`lib/i18n/nav-catalog.test.ts`):
 * renombrar una key en `es/` y olvidarla en `en/` pasaba la CI sin que nadie se
 * enterase, y el síntoma en producción es una key cruda —o el idioma
 * equivocado— en una pantalla que nadie mira en inglés.
 *
 * Los ficheros se leen del DISCO, no del `index.ts`: así un namespace nuevo
 * entra en la guarda el día que se crea el JSON, sin acordarse de registrarlo
 * en ningún sitio.
 *
 * ── Las dos reglas ────────────────────────────────────────────────────────────
 *
 *  1. Una key en ES sin gemela en EN es SIEMPRE un fallo. No hay excepciones y
 *     no hay lista: el catálogo español es el canónico y todo lo que dice se
 *     tiene que poder decir en inglés.
 *
 *  2. Una key en EN sin gemela en ES es un fallo SALVO que esté declarada abajo,
 *     en `EN_ONLY_BY_DESIGN`, y solo en los namespaces `errorsApi*`.
 *
 * ── Por qué la asimetría de `errorsApi*` es deliberada ────────────────────────
 *
 * El backend NO traduce (decisión D6): manda un `code` estable y un `message` en
 * español. `apiErrorMessage()` (`lib/i18n/api-error.ts`) traduce por `code` SOLO
 * si la key existe en el catálogo activo; si no existe, cae al `message` crudo
 * del backend. La regla vigente aprovecha ese fallback:
 *
 *   · Mensaje FIJO en el backend  → el ES lleva key (traducción literal) y el EN
 *     también. Paridad normal.
 *   · Mensaje INTERPOLADO en el backend (lleva dentro un diagnóstico real: el
 *     nombre del curso, el error del MTA, la respuesta de Stripe…) → el ES NO
 *     lleva key a propósito, para que `apiErrorMessage` degrade al `message`
 *     crudo y el admin español conserve el detalle. El EN sí lleva una redacción
 *     genérica, porque sin key el anglófono vería el mensaje en español.
 *
 * Son los 68 codes declarados abajo. Van uno a uno y no como un `skip`
 * sobre `errorsApi*`: un code nuevo que aparezca solo en EN por descuido rompe
 * la CI igual que cualquier otra huérfana, y un code que se declare aquí y luego
 * se arregle (o se borre) también, porque la lista se valida contra los
 * catálogos en los dos sentidos.
 *
 * ── Por qué esa regla ERA un bug y qué la sustituye ───────────────────────────
 *
 * La asimetría dejaba al usuario inglés SIN el dato que el español sí veía: la
 * pantalla inglesa prometía un diagnóstico («Stripe rejected the key.») y luego
 * no lo enseñaba. El arreglo NO es borrar la key inglesa (eso pinta el mensaje
 * crudo del backend, que está en español): es sacar el dato del copy y mandarlo
 * como campo `detail` aparte, de modo que CADA catálogo escriba su frase e
 * interpole `{detail}` — incluido el ES, que así rinde byte a byte el `message`
 * que el backend ya mandaba.
 *
 * Ese es el patrón `CODES_WITH_DETAIL` (`lib/i18n/api-error.ts`). Los codes que
 * ya lo usan NO están en la lista de abajo: tienen key en los dos idiomas y este
 * test los trata como cualquier par simétrico. Si alguien vuelve a borrar la
 * key ES de uno de ellos, el test de «entrada declarada» no lo tapa: se cae por
 * la regla 1.
 *
 * ── Lo que este test NO valida (y sigue pendiente) ────────────────────────────
 *
 * La CALIDAD de la redacción genérica inglesa de los 68 que quedan.
 *
 * Historia de los dos barridos, porque la lista solo se entiende con ella:
 *
 *   · Sesión I / `apps/api/src` (shape `code: 'X'`): 31 codes con `message`
 *     interpolado, 26 cerrados con `{detail}`.
 *   · Este barrido / `modules/<mod>/src/errors.ts` (shape `super(msg, CODE)`,
 *     que ningún barrido anterior miraba porque solo buscaban `code: 'X'`): 98
 *     `super()` con interpolación, 96 con key EN. **75 cerrados** con
 *     `{detail}` — los 11 que perdían un diagnóstico EXTERNO (Stripe, Zoom, el
 *     proveedor de IA, el paquete SCORM) y 64 que perdían un dato del producto.
 *
 * Los que siguen declarados abajo NO son «pendientes de traducir»: son los que
 * el patrón `{detail}` NO puede cerrar, y por un motivo concreto cada uno.
 *
 * ① El backend manda DOS frases españolas distintas para el mismo code. Una
 *    sola key ES no puede rendir las dos byte a byte; unificar el copy del
 *    backend primero es un cambio de producto que además toca tests vivos.
 *      `ADMIN_ROLE_NOT_FOUND` (`admin-users.service` 262 vs 553/596)
 *      `ADMIN_TENANT_HOSTNAME_EXISTS` (`admin-tenants.service` 217 vs 394)
 *      `COURSE_NOT_FOUND` (`modules/courses/src/errors.ts:18` «Curso no
 *        encontrado: <id>» vs `courses.controller.ts:244` «Curso no encontrado»)
 *      `ZOOM_SESSION_NOT_FOUND` (`modules/zoom-live/src/errors.ts:18` vs
 *        `zoom-live.controller.ts:67` «Sesión no encontrada.»)
 *      `LESSON_LOCKED` (`modules/learning/src/errors.ts:46` — ternario entre
 *        «se libera el <fecha>» y «aún no está disponible»)
 *
 * ② Interpolan DOS o más valores CON COPY ESPAÑOL ENTRE MEDIAS. `detail` es un
 *    campo único; colapsarlos en uno dejaría el conector español dentro del
 *    inglés («The AI provider failed: openai falló: timeout»), que mueve el bug
 *    en vez de arreglarlo.
 *
 *    **Los 5 con diagnóstico EXTERNO ya NO están aquí**: son los que cerró la
 *    ampliación del contrato a placeholders CON NOMBRE (`params`), que es la
 *    decisión de arquitectura que los PR #39 y #42 dejaron declarada. Viven en
 *    `CODES_WITH_PARAMS` (`lib/i18n/api-error.ts`) con key en los DOS idiomas, y
 *    este test los trata como cualquier par simétrico:
 *      `AI_GRADER_PROVIDER_ERROR`, `AI_TUTOR_CHAT_PROVIDER_ERROR`,
 *      `AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR`, `AI_PROVIDER_UNAVAILABLE` (TRES
 *      valores: provider, status y body) y `AI_CONTENT_INVALID_JSON`.
 *
 *    Los que siguen declarados abajo interpolan varios valores pero el dato es
 *    del PROPIO producto (un límite, un slug, un id que el usuario acaba de
 *    escribir), no un diagnóstico externo: la frase genérica inglesa no le
 *    esconde a nadie la causa de la incidencia. Pasarlos a `params` es mecánico
 *    y está disponible; no entra aquí para que la ampliación del contrato se
 *    revise sobre los 5 que la motivaron y no sobre 21.
 *      Con dato del producto:
 *        `AI_GRADER_QUESTION_NOT_GRADABLE`, `AI_PROVIDERS_PURPOSE_NOT_SUPPORTED`,
 *        `AI_PROVIDER_AUTH`, `AI_PROVIDER_NOT_CONFIGURED`,
 *        `AI_PROVIDER_RATE_LIMIT`, `AI_PROVIDER_UNSUPPORTED_CAPABILITY`,
 *        `AI_TUTOR_DAILY_QUESTION_QUOTA`, `AI_TUTOR_TOKEN_QUOTA_EXCEEDED`,
 *        `AI_CONTENT_DRAFT_NOT_IN_DRAFT`, `COMMUNITY_SPACE_UNKNOWN`,
 *        `FUNDAE_BLOCK_HOURS_EXCEED`, `FUNDAE_COMPANY_TIENE_GRUPOS_ACTIVOS`,
 *        `FUNDAE_CREDITO_INSUFICIENTE`, `FUNDAE_GROUP_PARTICIPANT_DUPLICADO`,
 *        `FUNDAE_GROUP_PARTICIPANT_NOT_IN_COURSE`,
 *        `FUNDAE_GROUP_TRANSICION_INVALIDA`, `FUNDAE_RLPT_PLAZO_NO_CUMPLIDO`,
 *        `GRADE_EXCEEDS_QUESTION_POINTS`, `THEMING_SIGNIN_COPY_TOO_LONG`,
 *        `THEMING_UNSUPPORTED_FONT`, `THEMING_UNSUPPORTED_LOGO_TYPE`
 *
 * ③ El valor interpolado ES COPY ESPAÑOL, no un dato: mandarlo como `detail`
 *    metería español dentro de la frase inglesa. Cerrarlos pide convertir ese
 *    valor en un enum con frase por idioma: decisión de producto.
 *      `ZOOM_LIVE_STAFF_ONLY` (`zoom-live.controller.ts:193,206,223,315`)
 *      `COURSE_PUBLISH_VALIDATION_FAILED` (`modules/courses/src/errors.ts:42` —
 *        `reasons.join('; ')`, frases del validador en español; el body ya manda
 *        el array `reasons` aparte)
 *      `ZOOM_ATTENDANCE_NOT_AVAILABLE` (`modules/zoom-live/src/errors.ts:77` —
 *        el `message` ENTERO lo pone el caller)
 *      `GAMIFICATION_*`, `REFERRALS_COMMISSION_STATE`, `REFERRALS_CONFIG_INVALID`,
 *        `REFERRALS_PAYOUT_INVALID`, `RESOURCES_VALIDATION`,
 *        `SURVEYS_INVALID_ANSWER`, `SPACE_NOT_DELETABLE` (ídem: la clase base
 *        recibe el `message` ya compuesto por el servicio)
 *
 * ④ Sin interpolación: el EN es una traducción libre de un `message` fijo que
 *    todavía no tiene gemelo ES. Es deuda de traducción normal, no este bug.
 *      los `errorsApiResto` y `CORE_MODULE_NOT_DISABLEABLE`, `MODULE_NOT_FOUND`,
 *      `MODULE_HAS_ACTIVE_DEPENDENTS`, `AUDIT_EXPORT_SIGNING_UNAVAILABLE`
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODES_WITH_DETAIL, CODES_WITH_PARAMS } from '@/lib/i18n/api-error';

const MESSAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');
const LOCALES = ['es', 'en'] as const;

/** Namespaces con permiso para declarar keys solo-EN (ver cabecera). */
const ASYMMETRY_ALLOWED_PREFIX = 'errorsApi';

/**
 * Codes con key SOLO en EN a propósito: el backend manda un `message` español
 * interpolado y el catálogo ES se calla para que `apiErrorMessage` lo deje
 * pasar entero. Ordenados alfabéticamente por namespace para que el diff de un
 * PR que añada o quite uno sea de una línea.
 *
 * Esta lista, `CODES_WITH_DETAIL` y `CODES_WITH_PARAMS` son DISJUNTAS entre sí
 * por construcción (hay test): un code o degrada al `message` crudo (aquí), o
 * interpola `{detail}` en los dos idiomas, o interpola placeholders con nombre.
 * Estar en dos de ellas significa que alguien arregló el code y se olvidó de
 * sacarlo de aquí.
 */
const EN_ONLY_BY_DESIGN: Readonly<Record<string, readonly string[]>> = {
  errorsApiAdmin: ['ADMIN_ROLE_NOT_FOUND', 'ADMIN_TENANT_HOSTNAME_EXISTS'],
  errorsApiModulesA: [
    'AI_PROVIDERS_PURPOSE_NOT_SUPPORTED',
    'CORE_MODULE_NOT_DISABLEABLE',
    'COURSE_NOT_FOUND',
    'COURSE_PUBLISH_VALIDATION_FAILED',
    'LESSON_LOCKED',
    'MODULE_HAS_ACTIVE_DEPENDENTS',
    'MODULE_NOT_FOUND',
    'THEMING_SIGNIN_COPY_TOO_LONG',
    'THEMING_UNSUPPORTED_FONT',
    'THEMING_UNSUPPORTED_LOGO_TYPE',
    'ZOOM_ATTENDANCE_NOT_AVAILABLE',
    'ZOOM_LIVE_STAFF_ONLY',
    'ZOOM_SESSION_NOT_FOUND',
  ],
  errorsApiModulesB: [
    'AI_CONTENT_DRAFT_NOT_IN_DRAFT',
    'AI_GRADER_QUESTION_NOT_GRADABLE',
    'AI_PROVIDER_AUTH',
    'AI_PROVIDER_NOT_CONFIGURED',
    'AI_PROVIDER_RATE_LIMIT',
    'AI_PROVIDER_UNSUPPORTED_CAPABILITY',
    'AI_TUTOR_DAILY_QUESTION_QUOTA',
    'AI_TUTOR_TOKEN_QUOTA_EXCEEDED',
    'AUDIT_EXPORT_SIGNING_UNAVAILABLE',
    'COMMUNITY_SPACE_UNKNOWN',
    'FUNDAE_BLOCK_HOURS_EXCEED',
    'FUNDAE_COMPANY_TIENE_GRUPOS_ACTIVOS',
    'FUNDAE_CREDITO_INSUFICIENTE',
    'FUNDAE_GROUP_PARTICIPANT_DUPLICADO',
    'FUNDAE_GROUP_PARTICIPANT_NOT_IN_COURSE',
    'FUNDAE_GROUP_TRANSICION_INVALIDA',
    'FUNDAE_RLPT_PLAZO_NO_CUMPLIDO',
    'GAMIFICATION_CHALLENGE_CLOSED',
    'GAMIFICATION_CONFLICT',
    'GAMIFICATION_NOT_FOUND',
    'GAMIFICATION_PERK_UNAVAILABLE',
    'GAMIFICATION_VALIDATION',
    'GRADE_EXCEEDS_QUESTION_POINTS',
    'REFERRALS_COMMISSION_STATE',
    'REFERRALS_CONFIG_INVALID',
    'REFERRALS_PAYOUT_INVALID',
    'RESOURCES_VALIDATION',
    'SPACE_NOT_DELETABLE',
    'SURVEYS_INVALID_ANSWER',
  ],
  errorsApiResto: [
    'ALREADY_INSTALLED',
    'CORE_VERSION_INCOMPATIBLE',
    'MANIFEST_CONSISTENCY_INVALID',
    'MANIFEST_INVALID_JSON',
    'MANIFEST_SCHEMA_INVALID',
    'MARKETPLACE_MODULE_HANDLER_ERROR',
    'MARKETPLACE_MODULE_NOT_AVAILABLE',
    'MARKETPLACE_MODULE_NOT_INSTALLED',
    'MARKETPLACE_PACKAGE_DOWNLOAD_FAILED',
    'MARKETPLACE_SURFACE_UI_MISSING',
    'MODULE_BOOT_FAILED',
    'MODULE_LINT_FAILED',
    'NAME_RESERVED',
    'NOT_FOUND',
    'PACKAGE_INVALID_ZIP',
    'PACKAGE_MISSING_FILE',
    'PACKAGE_TOO_LARGE',
    'SIGNATURE_INVALID',
    'SIGNATURE_VERIFY_FAILED',
    'STORAGE_FAILED',
    'SURFACE_BUNDLE_MISSING',
    'VENDOR_NOT_TRUSTED',
    'webhook_limit_exceeded',
    'webhook_url_duplicate',
  ],
};

type Json = { [k: string]: Json | string };

/** Hojas del catálogo en notación de punto, con su valor. */
function flatEntries(obj: Json, prefix = '', out: Array<[string, unknown]> = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flatEntries(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

function namespacesOf(locale: string): string[] {
  return readdirSync(path.join(MESSAGES_DIR, locale))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function entriesOf(locale: string, ns: string): Array<[string, unknown]> {
  const raw = readFileSync(path.join(MESSAGES_DIR, locale, `${ns}.json`), 'utf8');
  return flatEntries(JSON.parse(raw) as Json);
}

function keysOf(locale: string, ns: string): Set<string> {
  return new Set(entriesOf(locale, ns).map(([k]) => k));
}

const NAMESPACES = namespacesOf('es');

function declaredEnOnly(ns: string): ReadonlySet<string> {
  return new Set(EN_ONLY_BY_DESIGN[ns] ?? []);
}

describe('catálogo i18n · paridad es ↔ en', () => {
  it('los dos idiomas declaran exactamente los mismos namespaces', () => {
    expect(namespacesOf('en')).toEqual(NAMESPACES);
  });

  it('el barrido cubre todos los namespaces del disco (no está vacío)', () => {
    // Si alguien mueve la carpeta, el resto de tests pasaría en verde sobre
    // una lista vacía. Esto lo convierte en fallo.
    expect(NAMESPACES.length).toBeGreaterThan(30);
  });

  it('ninguna key existe solo en ES (regla sin excepciones)', () => {
    const huerfanas: string[] = [];
    for (const ns of NAMESPACES) {
      const en = keysOf('en', ns);
      for (const k of keysOf('es', ns)) if (!en.has(k)) huerfanas.push(`${ns}.${k}`);
    }
    expect(
      huerfanas,
      `keys en es/ sin gemela en en/ (traducir o borrar):\n  ${huerfanas.join('\n  ')}`,
    ).toEqual([]);
  });

  it('toda key solo-EN está declarada como deliberada', () => {
    const inesperadas: string[] = [];
    for (const ns of NAMESPACES) {
      const es = keysOf('es', ns);
      const declared = declaredEnOnly(ns);
      for (const k of keysOf('en', ns)) {
        if (!es.has(k) && !declared.has(k)) inesperadas.push(`${ns}.${k}`);
      }
    }
    expect(
      inesperadas,
      `keys en en/ sin gemela en es/ y SIN declarar en EN_ONLY_BY_DESIGN.\n` +
        `Si es deliberado (mensaje del backend interpolado) decláralo con motivo;\n` +
        `si no, falta la traducción española:\n  ${inesperadas.join('\n  ')}`,
    ).toEqual([]);
  });

  it('toda entrada declarada sigue siendo realmente asimétrica (la lista no se pudre)', () => {
    const obsoletas: string[] = [];
    for (const ns of NAMESPACES) {
      const es = keysOf('es', ns);
      const en = keysOf('en', ns);
      for (const k of declaredEnOnly(ns)) {
        if (!en.has(k)) obsoletas.push(`${ns}.${k} (ya no existe en en/)`);
        else if (es.has(k)) obsoletas.push(`${ns}.${k} (ya tiene gemela en es/)`);
      }
    }
    expect(
      obsoletas,
      `entradas de EN_ONLY_BY_DESIGN que ya no son asimétricas.\n` +
        `La declaración se pudrió: bórralas de la lista:\n  ${obsoletas.join('\n  ')}`,
    ).toEqual([]);
  });

  it('solo los namespaces errorsApi* pueden declarar asimetría', () => {
    const fuera = Object.keys(EN_ONLY_BY_DESIGN).filter(
      (ns) => !ns.startsWith(ASYMMETRY_ALLOWED_PREFIX),
    );
    expect(
      fuera,
      `la excusa del fallback al message crudo solo vale para codes de la API:\n  ${fuera.join('\n  ')}`,
    ).toEqual([]);
  });

  it('todo namespace declarado existe en el disco', () => {
    const fantasma = Object.keys(EN_ONLY_BY_DESIGN).filter((ns) => !NAMESPACES.includes(ns));
    expect(fantasma, `namespaces declarados que ya no existen: ${fantasma.join(', ')}`).toEqual([]);
  });

  it('ningún code está a la vez declarado asimétrico y en CODES_WITH_DETAIL', () => {
    // Los dos mecanismos se excluyen: o el ES se calla y degrada al `message`
    // crudo, o los dos catálogos interpolan `{detail}`. Un code en ambos sitios
    // es un arreglo a medias que este test no debe dejar pasar.
    const enLasDos = Object.entries(EN_ONLY_BY_DESIGN).flatMap(([ns, codes]) =>
      codes.filter((c) => CODES_WITH_DETAIL.has(c)).map((c) => `${ns}.${c}`),
    );
    expect(
      enLasDos,
      `codes que ya interpolan {detail} pero siguen declarados como asimétricos.\n` +
        `Bórralos de EN_ONLY_BY_DESIGN:\n  ${enLasDos.join('\n  ')}`,
    ).toEqual([]);
  });

  it('ningún code está a la vez declarado asimétrico y en CODES_WITH_PARAMS', () => {
    // Mismo razonamiento con la ampliación a placeholders con nombre: un code
    // que ya escribe su frase en los dos idiomas no puede seguir declarado como
    // «el ES se calla a propósito».
    const enLasDos = Object.entries(EN_ONLY_BY_DESIGN).flatMap(([ns, codes]) =>
      codes.filter((c) => CODES_WITH_PARAMS.has(c)).map((c) => `${ns}.${c}`),
    );
    expect(
      enLasDos,
      `codes que ya interpolan placeholders con nombre pero siguen declarados\n` +
        `como asimétricos. Bórralos de EN_ONLY_BY_DESIGN:\n  ${enLasDos.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CODES_WITH_DETAIL y CODES_WITH_PARAMS son disjuntas', () => {
    // El body manda UN dato anónimo (`detail`) o VARIOS con nombre (`params`),
    // nunca los dos: `apiErrorMessage` mira `params` primero, así que un code en
    // ambas listas dejaría su `{detail}` sin rellenar en silencio.
    const enLasDos = [...CODES_WITH_PARAMS.keys()].filter((c) => CODES_WITH_DETAIL.has(c)).sort();
    expect(
      enLasDos,
      `codes declarados a la vez con {detail} y con placeholders con nombre:\n  ${enLasDos.join('\n  ')}`,
    ).toEqual([]);
  });

  it('cada code de CODES_WITH_PARAMS interpola SUS placeholders en los DOS idiomas', () => {
    // La mitad de catálogo del contrato. Si el ES escribe `{provider}` y el EN
    // se olvida (o lo llama de otra forma), el anglófono ve la frase con el
    // hueco crudo — y a ojo no se ve.
    const fallos: string[] = [];
    for (const locale of LOCALES) {
      const porCode = new Map<string, string>();
      for (const ns of NAMESPACES.filter((n) => n.startsWith(ASYMMETRY_ALLOWED_PREFIX))) {
        for (const [k, v] of entriesOf(locale, ns)) {
          if (typeof v === 'string') porCode.set(k, v);
        }
      }
      for (const [code, names] of CODES_WITH_PARAMS) {
        const text = porCode.get(code);
        if (text === undefined) {
          fallos.push(`${locale}: ${code} no existe en ningún errorsApi*`);
          continue;
        }
        for (const name of names) {
          if (!text.includes(`{${name}}`)) fallos.push(`${locale}: ${code} no interpola {${name}}`);
        }
      }
    }
    expect(
      fallos,
      `catálogos que no cumplen el contrato de params:\n  ${fallos.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('catálogo i18n · integridad', () => {
  it('ningún valor está vacío en ninguno de los dos idiomas', () => {
    const vacias: string[] = [];
    for (const locale of LOCALES) {
      for (const ns of NAMESPACES) {
        for (const [k, v] of entriesOf(locale, ns)) {
          if (typeof v !== 'string' || v.trim() === '') vacias.push(`${locale}/${ns}.${k}`);
        }
      }
    }
    expect(vacias, `valores vacíos o no-string:\n  ${vacias.join('\n  ')}`).toEqual([]);
  });

  it('ningún valor lleva espacios load-bearing al principio o al final', () => {
    // Un valor como " · validado {date}" depende de un espacio INVISIBLE para
    // que la frase quede bien pegada a la anterior. Cualquier traductor (o
    // cualquier herramienta de traducción) que recorte el valor rompe la frase
    // y nadie lo ve hasta producción. La separación de maquetación va en el
    // call-site (` · ${t(...)}`), nunca dentro del catálogo.
    const conEspacios: string[] = [];
    for (const locale of LOCALES) {
      for (const ns of NAMESPACES) {
        for (const [k, v] of entriesOf(locale, ns)) {
          if (typeof v === 'string' && v !== v.trim()) {
            conEspacios.push(`${locale}/${ns}.${k} = ${JSON.stringify(v)}`);
          }
        }
      }
    }
    expect(
      conEspacios,
      `valores con espacio inicial o final (mueve la separación al call-site):\n  ${conEspacios.join('\n  ')}`,
    ).toEqual([]);
  });

  it('ningún code de error se define en dos errorsApi* a la vez', () => {
    // Los cinco `errorsApi*.json` se funden bajo el namespace `errors` en
    // `messages/<locale>/index.ts`: un code duplicado hace que gane el último
    // import, en silencio y distinto por idioma.
    const colisiones: string[] = [];
    for (const locale of LOCALES) {
      const origen = new Map<string, string>();
      const errorNs = NAMESPACES.filter((ns) => ns.startsWith(ASYMMETRY_ALLOWED_PREFIX));
      for (const ns of [...errorNs, 'errors']) {
        for (const k of keysOf(locale, ns)) {
          const previo = origen.get(k);
          if (previo) colisiones.push(`${locale}: ${k} en ${previo} y en ${ns}`);
          else origen.set(k, ns);
        }
      }
    }
    expect(colisiones, `codes duplicados:\n  ${colisiones.join('\n  ')}`).toEqual([]);
  });
});
