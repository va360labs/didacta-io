/**
 * Helpers para detectar y embeber URLs de video de proveedores externos
 * (YouTube por ahora; Vimeo y otros pueden añadirse acá).
 *
 * El builder permite pegar la URL pública (watch?v=, youtu.be/...) y el
 * player la convierte a embed URL al renderizarla. Así evitamos pedir al
 * formador que copie un iframe entero o que conozca la URL de embed.
 */

const YOUTUBE_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);

/**
 * Devuelve el videoId de YouTube si la URL es válida, null si no es de
 * YouTube. Reconoce los formatos `youtube.com/watch?v=...`, `youtu.be/...`
 * y `youtube.com/shorts/...`.
 */
export function parseYouTubeId(url: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(parsed.host.toLowerCase())) return null;

  // youtu.be/<id>
  if (parsed.host.toLowerCase().endsWith('youtu.be')) {
    const id = parsed.pathname.replace(/^\//, '').split('/')[0] ?? '';
    return id || null;
  }
  // youtube.com/watch?v=<id>
  const v = parsed.searchParams.get('v');
  if (v) return v;
  // youtube.com/shorts/<id> · /embed/<id>
  const m = parsed.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
  if (m) return m[1] ?? null;
  return null;
}

/**
 * Construye la URL de embed de YouTube respetando el dominio
 * privacy-enhanced (youtube-nocookie.com) por defecto y convirtiendo el
 * parámetro `t=` o `start=` que el formador pueda haber pegado al hacer
 * click en "compartir desde el segundo X".
 */
export function youTubeEmbedUrl(videoId: string, opts: { startSeconds?: number } = {}): string {
  const params = new URLSearchParams();
  if (opts.startSeconds && opts.startSeconds > 0) {
    params.set('start', String(Math.floor(opts.startSeconds)));
  }
  params.set('rel', '0');
  const qs = params.toString();
  return `https://www.youtube-nocookie.com/embed/${videoId}${qs ? `?${qs}` : ''}`;
}

/**
 * Si la URL apunta a YouTube y trae un timestamp (`t=42s`, `t=1m30s`,
 * `start=90`), devuelve los segundos. Sirve para arrancar el embed
 * desde el momento que el formador eligió.
 */
export function parseYouTubeStartSeconds(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const t = parsed.searchParams.get('t') ?? parsed.searchParams.get('start');
    if (!t) return undefined;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (!m) return undefined;
    const h = Number(m[1] ?? 0);
    const min = Number(m[2] ?? 0);
    const s = Number(m[3] ?? 0);
    const total = h * 3600 + min * 60 + s;
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}
