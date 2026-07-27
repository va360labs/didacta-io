/**
 * URL canónica de un post de la comunidad. Única fuente de verdad para
 * compartir/enlazar posts: la usan el feed (sync de URL al abrir el modal),
 * el botón "Copiar enlace" del detalle y los links de notificaciones.
 *
 * La ruta `/comunidad/<id>` renderiza el feed con ese post abierto en modal
 * (misma experiencia que abrirlo desde el feed).
 */

export function postPath(postId: string, opts: { commentId?: string } = {}): string {
  const base = `/comunidad/${encodeURIComponent(postId)}`;
  return opts.commentId ? `${base}?comment=${encodeURIComponent(opts.commentId)}` : base;
}

/** URL absoluta para compartir (origin del tenant actual). Solo en browser. */
export function postShareUrl(postId: string): string {
  return `${window.location.origin}${postPath(postId)}`;
}

/** Extrae el postId si el path es la URL canónica de un post; null si no lo es. */
export function parsePostPath(pathname: string): string | null {
  const m = pathname.match(/^\/comunidad\/([^/]+)$/);
  const id = m?.[1];
  if (!id || id === 'menciones') return null;
  return decodeURIComponent(id);
}
