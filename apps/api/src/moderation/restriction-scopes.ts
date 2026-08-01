/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Mapa de áreas sancionables → rutas que se bloquean.
 *
 * Este fichero es el corazón de la sanción y el sitio donde un error se paga
 * caro en las dos direcciones:
 *
 * - Si sobra una regla, un sancionado deja de poder pagar, matricularse o
 *   marcar una lección como vista. Eso es peor que el problema que arregla.
 * - Si falta una regla, se cuela un hueco por el que sigue publicando.
 *
 * Por eso las reglas son patrones explícitos sobre método + ruta, y no un
 * "bloquea todo lo que no sea GET": el catálogo de lo que se bloquea se lee
 * de un vistazo y se revisa en code review.
 *
 * Las rutas llegan aquí SIN el prefijo global `/api/v1` (lo quita
 * `normalizePath`), así que los patrones empiezan en `/modules/...`.
 */

/** Métodos que pueden crear o alterar contenido. GET/HEAD/OPTIONS nunca se tocan. */
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface RouteMatcher {
  methods: readonly string[];
  pattern: RegExp;
}

export interface ScopeRule {
  /** Etiqueta en español para la UI y para el mensaje del 403. */
  label: string;
  /** Si la petición matchea aquí, se bloquea… */
  deny: readonly RouteMatcher[];
  /** …salvo que también matchee aquí. `allow` gana siempre sobre `deny`. */
  allow: readonly RouteMatcher[];
}

/**
 * Áreas concretas. `all` no está aquí: es un comodín que aplica todas las
 * reglas de este objeto más `ALL_ONLY`.
 */
export const SCOPE_RULES = {
  community: {
    label: 'Comunidad',
    deny: [
      { methods: MUTATING, pattern: /^\/modules\/community\// },
      // La API externa (API keys, n8n/Zapier) publica posts REALES en el feed
      // saltándose JwtAuthGuard. Si no estuviera aquí, un admin sancionado
      // seguiría publicando con su API key.
      { methods: MUTATING, pattern: /^\/community-api\// },
    ],
    allow: [
      // Darse de baja del digest o de los broadcasts es una preferencia
      // personal, no una aportación. Bloquearla solo sirve para que el
      // sancionado siga recibiendo correos que no quiere.
      { methods: ['PUT'], pattern: /^\/modules\/community\/me\/preferences$/ },
    ],
  },

  messaging: {
    label: 'Mensajes',
    deny: [{ methods: MUTATING, pattern: /^\/modules\/messaging\// }],
    allow: [
      // Un silenciado sigue leyendo sus conversaciones: marcar leído y pedir
      // el ticket del SSE son parte de LEER, no de escribir.
      { methods: ['POST'], pattern: /^\/modules\/messaging\/conversations\/[^/]+\/read$/ },
      { methods: ['POST'], pattern: /^\/modules\/messaging\/stream-ticket$/ },
      // `typing` sí se bloquea a propósito: no aporta contenido, pero anunciar
      // "está escribiendo" a alguien que no puede escribir es ruido y confunde
      // al que está al otro lado.
    ],
  },

  uploads: {
    label: 'Subidas de archivos',
    deny: [
      { methods: ['POST'], pattern: /^\/storage\/(upload|optimize)$/ },
      { methods: MUTATING, pattern: /^\/modules\/resources/ },
      // Cambiar el logo del tenant es subir un fichero visible por todos.
      { methods: ['POST'], pattern: /^\/modules\/theming\/me\/logo$/ },
    ],
    allow: [
      // Registrar una descarga es telemetría de lectura.
      { methods: ['POST'], pattern: /^\/modules\/resources\/[^/]+\/download$/ },
    ],
  },

  ai: {
    label: 'Tutor IA',
    // Solo `/modules/ai-tutor/*`. Las rutas de admin cuelgan de
    // `/admin/ai-tutor/*` y no matchean, que es lo que queremos: sancionar a
    // un formador no debe dejarle sin reindexar sus cursos.
    deny: [{ methods: MUTATING, pattern: /^\/modules\/ai-tutor\// }],
    allow: [],
  },
} as const satisfies Record<string, ScopeRule>;

export type ContentScope = keyof typeof SCOPE_RULES;

export const CONTENT_SCOPES = Object.keys(SCOPE_RULES) as ContentScope[];

/** Comodín. Se guarda literal en BD para que cubra áreas futuras. */
export const SCOPE_ALL = 'all';

export type RestrictionScope = ContentScope | typeof SCOPE_ALL;

export const ALL_SCOPES: readonly string[] = [...CONTENT_SCOPES, SCOPE_ALL];

/**
 * Reglas que SOLO aplican con el comodín `all` — superficies donde se puede
 * aportar contenido pero que no encajan en ninguna de las áreas de arriba.
 *
 * Nada de esto se bloquea con una sanción de área concreta.
 */
export const ALL_ONLY: ScopeRule = {
  label: 'Toda la plataforma',
  deny: [
    // El nombre y la bio se ven en cada post y en el directorio: es el sitio
    // obvio al que se muda el spam cuando le cierras el feed.
    { methods: ['PATCH'], pattern: /^\/me\/profile$/ },
    // Comentarios de lección (nacen PENDING, pero saturan la cola de moderación).
    { methods: ['POST'], pattern: /^\/modules\/learning\/lessons\/[^/]+\/comments$/ },
    // Entregas de retos: llevan texto y URL de prueba que revisa el staff.
    { methods: ['POST'], pattern: /^\/modules\/gamification\/challenges\/[^/]+\/submit$/ },
    { methods: ['POST'], pattern: /^\/modules\/gamification\/perks\/[^/]+\/request$/ },
    // Respuestas de encuesta: son anónimas, pero el texto libre se lee en admin.
    { methods: ['POST'], pattern: /^\/modules\/surveys\/[^/]+\/responses$/ },
    // Crear grupos y eventos (staff): un formador sancionado no crea espacios.
    { methods: ['POST'], pattern: /^\/modules\/groups$/ },
    { methods: ['POST'], pattern: /^\/modules\/events$/ },
  ],
  allow: [],
};

/**
 * Rutas que NUNCA se bloquean, ni siquiera con `all`.
 *
 * Es la red de seguridad del fichero: aunque un patrón de arriba se pase de
 * ancho por accidente, un sancionado conserva la capacidad de pagar, de
 * acceder a lo que compró y de gestionar su propia cuenta. Sin esto, una
 * sanción de moderación se convertiría en un problema de facturación.
 */
export const NEVER_BLOCKED: readonly RouteMatcher[] = [
  // Autenticación y cuenta propia.
  { methods: MUTATING, pattern: /^\/auth\// },
  { methods: MUTATING, pattern: /^\/me\/(security|notification-preferences|onboarding)/ },
  // Dinero. Bajo ningún concepto.
  {
    methods: MUTATING,
    pattern: /^\/modules\/(billing|subscriptions|payment-connections|member-registration)\//,
  },
  { methods: MUTATING, pattern: /^\/(inscribe|enrollment)/ },
  // Consumir lo que ya tiene: progreso, matrículas, intentos de quiz y SCORM.
  { methods: MUTATING, pattern: /^\/modules\/learning\/(progress|enrollments)/ },
  { methods: MUTATING, pattern: /^\/modules\/learning\/lessons\/[^/]+\/scorm/ },
  { methods: MUTATING, pattern: /^\/modules\/assessments\/attempts/ },
  // Marcar notificaciones leídas.
  { methods: MUTATING, pattern: /^\/modules\/notifications\// },
  // Apuntarse o borrarse de una clase en directo o un evento ya publicado.
  { methods: ['POST'], pattern: /^\/modules\/zoom-live\/.*\/(register|unregister|join)$/ },
  { methods: ['POST'], pattern: /^\/modules\/events\/[^/]+\/(register|unregister)$/ },
];

const GLOBAL_PREFIX = /^\/api\/v\d+/;

/** Quita querystring y prefijo global, y normaliza la barra final. */
export function normalizePath(rawUrl: string): string {
  const path = (rawUrl.split('?', 1)[0] ?? '').replace(GLOBAL_PREFIX, '');
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path || '/';
}

function matches(list: readonly RouteMatcher[], method: string, path: string): boolean {
  return list.some((m) => m.methods.includes(method) && m.pattern.test(path));
}

/** Expande el comodín a las reglas que hay que evaluar. */
function rulesFor(scopes: readonly string[]): ScopeRule[] {
  if (scopes.includes(SCOPE_ALL)) return [...Object.values(SCOPE_RULES), ALL_ONLY];
  return CONTENT_SCOPES.filter((s) => scopes.includes(s)).map((s) => SCOPE_RULES[s]);
}

/**
 * Decide si una petición queda bloqueada por las áreas sancionadas.
 *
 * Devuelve la etiqueta del área que la bloquea (para el mensaje de error), o
 * null si pasa. El orden es: red de seguridad → allow del área → deny del área.
 */
export function blockedBy(
  scopes: readonly string[],
  method: string,
  rawUrl: string,
): string | null {
  const upper = method.toUpperCase();
  if (!MUTATING.includes(upper)) return null;

  const path = normalizePath(rawUrl);
  if (matches(NEVER_BLOCKED, upper, path)) return null;

  for (const rule of rulesFor(scopes)) {
    if (matches(rule.allow, upper, path)) continue;
    if (matches(rule.deny, upper, path)) return rule.label;
  }
  return null;
}

/** Etiquetas legibles de un conjunto de áreas, para mensajes y UI. */
export function scopeLabels(scopes: readonly string[]): string[] {
  if (scopes.includes(SCOPE_ALL)) return [ALL_ONLY.label];
  return CONTENT_SCOPES.filter((s) => scopes.includes(s)).map((s) => SCOPE_RULES[s].label);
}
