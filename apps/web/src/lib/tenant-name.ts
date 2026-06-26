/**
 * Nombre legible del tenant a partir de su slug.
 *
 * El producto no guarda un "display name" del tenant: la convención de la app
 * es derivarlo del slug (title-case). Esta función es la fuente única de esa
 * derivación — la usan el sidebar (footer de perfil) y el `<title>` del
 * documento, para que ambos muestren exactamente el mismo nombre.
 *
 *   "mi-academia" → "Mi Academia"
 */
export function formatTenantName(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
