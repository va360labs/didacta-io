/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Rutas del aula que antes iban en español y ahora van en inglés.
 *
 * Valentín: «se ve raro que las URL estén en español; ponlas siempre todas en
 * inglés». Las páginas se movieron, pero lo que ya está fuera no se puede
 * reescribir: enlaces de venta compartidos (`/catalogo/<slug>?ref=…`), correos
 * y `.ics` ya enviados, notificaciones y publicaciones guardadas en la base,
 * marcadores, el `success_url` de un pago de Stripe en curso, la vuelta del
 * alta de cobros, los certificados con su enlace de verificación (`/verificar`
 * impreso en el PDF y en LinkedIn)… Todo eso sigue funcionando porque el
 * middleware contesta a la ruta vieja con un 308 a la nueva, conservando los
 * segmentos dinámicos y la query entera (`?ref=`, `?session_id=`, `?token=`).
 *
 * 308 y no 301: el 308 obliga a repetir el MISMO método con el mismo cuerpo,
 * y es permanente (navegadores y buscadores actualizan su copia).
 *
 * Esta tabla NO se borra: un certificado o un enlace de venta viven años.
 *
 * El prefijo interno del sitio público (`/sitio` → `/site`) no está: nunca fue
 * una URL pública (el middleware lo corta con un 404).
 */
export const LEGACY_ROUTES: ReadonlyArray<readonly [old: string, current: string]> = [
  ['/admin/auditoria', '/admin/audit'],
  ['/admin/avisos', '/admin/broadcasts'],
  ['/admin/cobros', '/admin/payments'],
  ['/admin/competencias', '/admin/competencies'],
  ['/admin/comunidad/espacios', '/admin/community/spaces'],
  ['/admin/comunidad/publicaciones-api', '/admin/community/api-posts'],
  ['/admin/comunidad', '/admin/community'],
  ['/admin/configuracion', '/admin/settings'],
  ['/admin/cursos/categorias', '/admin/courses/categories'],
  ['/admin/cursos/imagenes', '/admin/courses/images'],
  ['/admin/cursos', '/admin/courses'],
  ['/admin/dominios', '/admin/domains'],
  ['/admin/encuestas', '/admin/surveys'],
  ['/admin/fundae/empresas', '/admin/fundae/companies'],
  ['/admin/fundae/grupos', '/admin/fundae/groups'],
  ['/admin/gamificacion', '/admin/gamification'],
  ['/admin/grupos-acceso', '/admin/access-groups'],
  ['/admin/ia', '/admin/ai'],
  ['/admin/imagenes', '/admin/images'],
  ['/admin/impagos', '/admin/delinquents'],
  ['/admin/integraciones', '/admin/integrations'],
  ['/admin/invitaciones', '/admin/invitations'],
  ['/admin/licencia', '/admin/license'],
  ['/admin/membresia', '/admin/membership'],
  ['/admin/metricas', '/admin/metrics'],
  ['/admin/referidos', '/admin/referrals'],
  ['/admin/seguridad', '/admin/security'],
  ['/admin/solicitudes-miembros', '/admin/member-requests'],
  ['/admin/tenants/nuevo', '/admin/tenants/new'],
  ['/admin/usuarios/importar', '/admin/users/import'],
  ['/admin/usuarios/invitar', '/admin/users/invite'],
  ['/admin/usuarios', '/admin/users'],
  ['/formador/cursos/nuevo', '/studio/courses/new'],
  ['/formador/cursos', '/studio/courses'],
  ['/formador/aula-virtual', '/studio/live'],
  ['/formador/certificados', '/studio/certificates'],
  ['/formador/correcciones', '/studio/grading'],
  ['/formador/rutas/nueva', '/studio/paths/new'],
  ['/formador/rutas', '/studio/paths'],
  ['/formador', '/studio'],
  ['/calendario', '/calendar'],
  ['/clase', '/live'],
  ['/comunidad/menciones', '/community/mentions'],
  ['/comunidad', '/community'],
  ['/cuenta/suscripciones', '/account/subscriptions'],
  ['/cuenta', '/account'],
  ['/cursos', '/courses'],
  ['/empieza', '/start'],
  ['/espacios', '/spaces'],
  ['/eventos', '/events'],
  ['/grupos', '/groups'],
  ['/inicio/mi-panel', '/home/dashboard'],
  ['/inicio', '/home'],
  ['/mensajes', '/messages'],
  ['/miembros', '/members'],
  ['/mis-certificados', '/my-certificates'],
  ['/notificaciones', '/notifications'],
  ['/recursos', '/resources'],
  ['/referidos', '/referrals'],
  ['/retos', '/challenges'],
  ['/rutas', '/paths'],
  ['/seguimiento', '/inspection'],
  ['/soporte/acceso', '/support/access'],
  ['/soporte', '/support'],
  ['/inscripcion-miembros', '/member-registration'],
  ['/verificar', '/verify'],
  ['/catalogo', '/catalog'],
  ['/condiciones-referidos', '/referral-terms'],
  ['/unete', '/join'],
  ['/bienvenida', '/welcome'],
];

/** De más largo a más corto: `/formador/cursos/nuevo` antes que `/formador`. */
const BY_LENGTH = [...LEGACY_ROUTES].sort((a, b) => b[0].length - a[0].length);

/** Segmento en español debajo de uno dinámico: `/formador/cursos/<id>/alumnos`. */
const NESTED = /^(\/studio\/courses\/[^/]+)\/alumnos(?=\/|$)/;

/**
 * Ruta nueva para una ruta vieja del aula, o `null` si `pathname` no es una
 * ruta vieja. Solo cambia los segmentos fijos: los dinámicos (slug, id) y lo
 * que haya detrás se conservan tal cual. La query no entra aquí: el llamante
 * la conserva entera.
 */
export function legacyRedirectPath(pathname: string): string | null {
  for (const [old, current] of BY_LENGTH) {
    if (pathname === old || pathname.startsWith(`${old}/`)) {
      return (current + pathname.slice(old.length)).replace(NESTED, '$1/students');
    }
  }
  return null;
}

/**
 * Parámetros de query que antes iban en español. Las páginas leen el nombre
 * en inglés y, si no viene, el de antes: hay enlaces ya enviados con el viejo
 * (la vuelta del alta de cobros de Stripe trae `?vuelta=1`, un correo puede
 * llevar `?vista=eventos`). Los enlaces nuevos se escriben en inglés.
 */
export const LEGACY_QUERY_KEYS = {
  add: 'anadir',
  full: 'completo',
  return: 'vuelta',
  refresh: 'renovar',
  group: 'grupo',
  view: 'vista',
} as const;

export type QueryKey = keyof typeof LEGACY_QUERY_KEYS;

/** Valor del parámetro `key`, o el de su nombre de antes. `null` si no viene ninguno. */
export function queryParam(
  params: { get(name: string): string | null } | null | undefined,
  key: QueryKey,
): string | null {
  if (!params) return null;
  return params.get(key) ?? params.get(LEGACY_QUERY_KEYS[key]);
}

/**
 * Valores de `?tab=` que antes iban en español. Un solo mapa para todas las
 * pantallas: ninguna palabra vieja va a dos valores nuevos distintos
 * (`actividad` es `activity` en el panel y en el expediente; `compras`,
 * `purchases` en la cuenta y en el expediente). El valor nuevo es el nombre
 * inglés de la pestaña.
 *
 * Hay enlaces ya fuera con el valor viejo: la vuelta del portal de facturación
 * de Stripe de una sesión abierta antes del cambio (`/account?tab=suscripcion`),
 * correos, marcadores. Cada pantalla los acepta (`modernTab`) y cambia la URL
 * por la nueva sin entrada nueva en el historial (`useModernUrl`).
 *
 * Las pestañas que aporta un módulo declaran sus valores de antes en su propia
 * extensión (`legacyKeys`), no aquí.
 */
export const LEGACY_TAB_VALUES: Readonly<Record<string, string>> = {
  // /account
  datos: 'details',
  notificaciones: 'notifications',
  suscripcion: 'subscription',
  compras: 'purchases',
  seguridad: 'security',
  // /admin (panel)
  actividad: 'activity',
  negocio: 'business',
  // /admin/settings
  registro: 'registration',
  pagos: 'payments',
  // /admin/api-keys
  claves: 'keys',
  // /admin/webhooks
  salientes: 'outbound',
  // /u/<id> (expediente)
  resumen: 'overview',
  formacion: 'training',
  mensajes: 'messages',
  acceso: 'access',
  sanciones: 'sanctions',
};

/** Otros valores de query que antes iban en español, por clave (la nueva). */
export const LEGACY_QUERY_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  view: { eventos: 'events' },
};

/** Anclas que antes iban en español (sin `#`). */
export const LEGACY_HASHES: Readonly<Record<string, string>> = {
  referidos: 'referrals',
  enlace: 'sale-link',
};

function own(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Valor de pestaña de ahora para lo que trae la URL: el de antes traducido
 * (de la tabla del core o de `extra`, los que declaran los módulos), o el
 * mismo si ya es de los de ahora. `null` si no viene.
 */
export function modernTab(
  value: string | null | undefined,
  extra: Readonly<Record<string, string>> = {},
): string | null {
  const v = value?.trim();
  if (!v) return null;
  return own(LEGACY_TAB_VALUES, v) ?? own(extra, v) ?? v;
}

/**
 * La misma URL con todo lo de antes cambiado por lo de ahora, o `null` si no
 * hay nada que cambiar:
 *
 *  - claves de query de antes (`?vista=` → `?view=`), salvo que ya venga la nueva;
 *  - el valor de `?tab=` (`seguridad` → `security`; `extra`: los de los módulos);
 *  - otros valores (`?view=eventos` → `?view=events`);
 *  - el ancla (`#referidos` → `#referrals`).
 *
 * El resto de la query (`?ref=`, `?status=`…) se conserva tal cual.
 */
export function modernizeUrl(
  pathname: string,
  search: string,
  hash: string,
  extra: Readonly<Record<string, string>> = {},
): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  for (const [key, old] of Object.entries(LEGACY_QUERY_KEYS)) {
    if (!params.has(old)) continue;
    const value = params.get(old)!;
    params.delete(old);
    if (!params.has(key)) params.set(key, value);
    changed = true;
  }
  const tab = params.get('tab');
  const tabNow = modernTab(tab, extra);
  if (tab !== null && tabNow !== null && tabNow !== tab) {
    params.set('tab', tabNow);
    changed = true;
  }
  for (const [key, values] of Object.entries(LEGACY_QUERY_VALUES)) {
    const value = params.get(key);
    const now = value === null ? undefined : own(values, value);
    if (now) {
      params.set(key, now);
      changed = true;
    }
  }
  const anchor = hash.replace(/^#/, '');
  const anchorNow = own(LEGACY_HASHES, anchor) ?? anchor;
  if (anchorNow !== anchor) changed = true;
  if (!changed) return null;
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ''}${anchorNow ? `#${anchorNow}` : ''}`;
}
