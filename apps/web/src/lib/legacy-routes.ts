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
