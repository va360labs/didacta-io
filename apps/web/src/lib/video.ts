/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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

// ──────────────────────────────────────────────────────────────────────────
// Bunny Stream
// ──────────────────────────────────────────────────────────────────────────

export interface BunnyRef {
  libraryId: string;
  guid: string;
}

/**
 * Detecta una URL de Bunny Stream. Acepta la URL de embed/play que da el
 * panel de Bunny: `https://iframe.mediadelivery.net/embed/{libraryId}/{guid}`
 * (o `/play/...`). Devuelve `{ libraryId, guid }` o null si no es Bunny.
 */
export function parseBunny(url: string): BunnyRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host.toLowerCase() !== 'iframe.mediadelivery.net') return null;
  const m = parsed.pathname.match(/^\/(?:embed|play)\/(\d+)\/([0-9a-fA-F-]{8,})/);
  if (!m) return null;
  return { libraryId: m[1] ?? '', guid: m[2] ?? '' };
}

export interface BunnyPlayerOptions {
  startSeconds?: number;
  autoplay?: boolean;
}

/**
 * Añade los parámetros del reproductor (`autoplay`, `preload`, `responsive`,
 * `t`) a una URL de embed de Bunny. Respeta lo que ya traiga la URL: la firma
 * que devuelve la API (`token` + `expires`) va en la query y NO se toca, porque
 * Bunny valida el hash contra esos dos valores exactos.
 *
 * `t` arranca el vídeo en ese segundo (soportado por el player de Bunny);
 * `autoplay` lo reproduce solo (lo usamos al saltar a un capítulo).
 */
export function withBunnyPlayerParams(embedUrl: string, opts: BunnyPlayerOptions = {}): string {
  const url = new URL(embedUrl);
  url.searchParams.set('autoplay', opts.autoplay ? 'true' : 'false');
  url.searchParams.set('preload', 'true');
  url.searchParams.set('responsive', 'true');
  if (opts.startSeconds && opts.startSeconds > 0) {
    url.searchParams.set('t', String(Math.floor(opts.startSeconds)));
  } else {
    url.searchParams.delete('t');
  }
  return url.toString();
}

/** URL de embed de Bunny SIN firmar (la permanente que guarda el contenido). */
export function bunnyBaseEmbedUrl(ref: BunnyRef): string {
  return `https://iframe.mediadelivery.net/embed/${ref.libraryId}/${ref.guid}`;
}

/**
 * Construye la URL de embed de Bunny Stream SIN firmar. Ojo: si la academia
 * protege sus vídeos (autenticación por token activa en la librería de Bunny),
 * esta URL no carga; el reproductor debe usar la que da la API
 * (`useBunnyPlayUrl` + `withBunnyPlayerParams`).
 */
export function bunnyEmbedUrl(ref: BunnyRef, opts: BunnyPlayerOptions = {}): string {
  return withBunnyPlayerParams(bunnyBaseEmbedUrl(ref), opts);
}

/** Parámetros de la firma: los pone la API, nunca el contenido de una lección. */
const BUNNY_SIGNATURE_PARAMS = new Set(['token', 'expires']);

/**
 * Para un `<iframe>` de Bunny incrustado a mano en una lección HTML: pasa los
 * parámetros de reproductor que eligió quien escribió la lección (`autoplay`,
 * `loop`, `muted`…) a la URL de reproducción que da la API. Así el vídeo se
 * comporta como el autor lo dejó, pero cargando con la firma vigente.
 *
 * Un `token`/`expires` pegado en el HTML se descarta: sería una firma vieja (o
 * de otro vídeo) y pisaría la buena.
 */
export function withOriginalBunnyParams(playUrl: string, originalSrc: string): string {
  const url = new URL(playUrl);
  let original: URL;
  try {
    original = new URL(originalSrc);
  } catch {
    return url.toString();
  }
  for (const [name, value] of original.searchParams) {
    if (BUNNY_SIGNATURE_PARAMS.has(name.toLowerCase())) continue;
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  return url.toString();
}

// ──────────────────────────────────────────────────────────────────────────
// URL de reproducción (Bunny con protección de vídeo)
//
// Si la academia protege sus vídeos, la API firma la URL de embed (`token` +
// `expires`) por vídeo y por alumno, con caducidad corta: una URL copiada o
// recolectada por un script deja de servir en minutos. Estos helpers deciden
// cuándo una URL ya pedida sigue valiendo y cuándo hay que volver a pedirla.
// ──────────────────────────────────────────────────────────────────────────

export interface BunnyPlayUrlEntry {
  url: string;
  /** Caducidad de la firma (epoch ms), o null si la URL no va firmada. */
  expiresAtMs: number | null;
  /** Cuándo se obtuvo (epoch ms). */
  fetchedAtMs: number;
  /** El reproductor debe pintar la marca de agua con la identidad del alumno. */
  watermark: boolean;
}

/** Margen antes de la caducidad: no montar un iframe con una firma a punto de morir. */
export const PLAY_URL_EXPIRY_MARGIN_MS = 60_000;
/**
 * Vida de una URL SIN firma en la caché. Si el admin activa la protección a
 * mitad de sesión, a los pocos minutos el reproductor pasa a pedir la firmada.
 */
export const UNSIGNED_PLAY_URL_TTL_MS = 5 * 60_000;

/** True si la URL cacheada se puede usar para montar el reproductor ahora. */
export function isPlayUrlFresh(entry: BunnyPlayUrlEntry | undefined, nowMs: number): boolean {
  if (!entry) return false;
  if (entry.expiresAtMs === null) return nowMs - entry.fetchedAtMs < UNSIGNED_PLAY_URL_TTL_MS;
  return entry.expiresAtMs - PLAY_URL_EXPIRY_MARGIN_MS > nowMs;
}

/** Clave de caché de un vídeo de Bunny. */
export function bunnyRefKey(ref: BunnyRef): string {
  return `${ref.libraryId}/${ref.guid.toLowerCase()}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Marca de agua dinámica
// ──────────────────────────────────────────────────────────────────────────

/**
 * Posición (en % del reproductor) para la marca de agua. Acotada para que el
 * texto quede siempre dentro del vídeo y NUNCA encima de la barra de controles
 * de la parte inferior (último ~20 %), ni pegado al botón de pantalla completa
 * de la esquina superior derecha.
 *
 * En vertical solo usa dos franjas, la de arriba y la de abajo: por el centro
 * pasaría por encima de lo que se está explicando y distrae de la clase.
 */
export const WATERMARK_TOP_RANGE: readonly [number, number] = [8, 72];
export const WATERMARK_TOP_BANDS: ReadonlyArray<readonly [number, number]> = [
  [8, 20],
  [60, 72],
];
export const WATERMARK_LEFT_RANGE: readonly [number, number] = [3, 55];

export function randomWatermarkPosition(rand: () => number = Math.random): {
  topPct: number;
  leftPct: number;
} {
  const pick = ([min, max]: readonly [number, number]) => {
    const r = Math.min(Math.max(rand(), 0), 1);
    return Math.round((min + r * (max - min)) * 10) / 10;
  };
  const band = WATERMARK_TOP_BANDS[rand() < 0.5 ? 0 : 1]!;
  return { topPct: pick(band), leftPct: pick(WATERMARK_LEFT_RANGE) };
}

/** Texto de la marca: email + id corto, para identificar a quien grabe la pantalla. */
export function watermarkLabel(user: { email: string; id: string }): string {
  return `${user.email} · ${user.id.slice(0, 8)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Timestamps y recursos ("00:00 - Texto")
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convierte un timestamp `MM:SS` o `HH:MM:SS` a segundos. Devuelve null si
 * el formato no es válido (minutos/segundos fuera de rango incluidos).
 */
export function parseTimestampToSeconds(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hasHours = m[1] !== undefined;
  const h = hasHours ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (s >= 60) return null;
  if (hasHours && min >= 60) return null;
  return h * 3600 + min * 60 + s;
}

/** Formatea segundos a `M:SS` (o `H:MM:SS` si supera la hora). */
export function formatSeconds(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const min = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

export type ResourceSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; href: string; label: string };

export type ResourceLine =
  | { kind: 'chapter'; seconds: number; label: string }
  | { kind: 'text'; segments: ResourceSegment[] };

const URL_RE = /(https?:\/\/[^\s]+)/g;
// Línea de capítulo: "02:15 - Texto", admite separadores -, –, —, : y ·.
const CHAPTER_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—:·]\s*(.+)$/;

function linkifySegments(line: string): ResourceSegment[] {
  const segments: ResourceSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(URL_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ type: 'text', value: line.slice(lastIndex, idx) });
    }
    const href = match[0];
    segments.push({ type: 'link', href, label: href });
    lastIndex = idx + href.length;
  }
  if (lastIndex < line.length) {
    segments.push({ type: 'text', value: line.slice(lastIndex) });
  }
  if (segments.length === 0) segments.push({ type: 'text', value: line });
  return segments;
}

/**
 * Parsea el campo de recursos de una lección (texto libre, una entrada por
 * línea). Las líneas con formato `MM:SS - Texto` se convierten en capítulos
 * clicables (hacen seek en el vídeo); el resto se renderizan como viñetas,
 * con las URLs convertidas en enlaces.
 */
export function parseResources(text: string): ResourceLine[] {
  if (!text) return [];
  const lines: ResourceLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s+/, '');
    if (!line) continue;
    const chapter = line.match(CHAPTER_RE);
    if (chapter) {
      const seconds = parseTimestampToSeconds(chapter[1] ?? '');
      if (seconds !== null) {
        lines.push({ kind: 'chapter', seconds, label: (chapter[2] ?? '').trim() });
        continue;
      }
    }
    lines.push({ kind: 'text', segments: linkifySegments(line) });
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────────────────
// Medición de tiempo de visionado REAL
//
// El reproductor de Bunny es un iframe cross-origin: la página host no recibe
// los eventos nativos del vídeo. Vía el protocolo Player.js (postMessage) sí
// podemos leer la posición de reproducción (`timeupdate`) y, con estos
// helpers, acumular solo los segundos efectivamente reproducidos —
// descartando pausas (no llegan eventos) y saltos/seeks (delta grande). Es la
// base fiable para un mínimo de visionado por lección.
// ──────────────────────────────────────────────────────────────────────────

export interface WatchState {
  /** Última posición observada (segundos), o null si se cortó la continuidad. */
  lastSeconds: number | null;
  /** Segundos efectivamente reproducidos (acumulado desde el inicio). */
  watchedSeconds: number;
  /** Posición máxima alcanzada en el vídeo (segundos). */
  maxPositionSeconds: number;
}

export function initWatchState(): WatchState {
  return { lastSeconds: null, watchedSeconds: 0, maxPositionSeconds: 0 };
}

/**
 * Procesa una posición de reproducción (`timeupdate`). Suma al tiempo visto
 * solo el avance "natural" (delta positivo y ≤ `maxStepSeconds`); los saltos
 * hacia delante y los retrocesos no cuentan como visionado. Actualiza la
 * posición máxima alcanzada.
 *
 * `maxStepSeconds` debe ser algo mayor que el intervalo entre `timeupdate`
 * (Player.js los emite varias veces por segundo) para tolerar lag sin contar
 * un seek como visionado. Default 1.5s.
 */
export function advanceWatch(
  state: WatchState,
  currentSeconds: number,
  opts: { maxStepSeconds?: number } = {},
): WatchState {
  const maxStep = opts.maxStepSeconds ?? 1.5;
  let watchedSeconds = state.watchedSeconds;
  if (state.lastSeconds !== null) {
    const delta = currentSeconds - state.lastSeconds;
    if (delta > 0 && delta <= maxStep) {
      watchedSeconds += delta;
    }
  }
  return {
    lastSeconds: currentSeconds,
    watchedSeconds,
    maxPositionSeconds: Math.max(state.maxPositionSeconds, currentSeconds),
  };
}

/**
 * Corta la continuidad de medición (tras pausa, seek o cambio de pestaña): el
 * próximo `advanceWatch` no contará el salto desde la última posición.
 */
export function breakWatchContinuity(state: WatchState): WatchState {
  return { ...state, lastSeconds: null };
}

/**
 * Porcentaje del vídeo cubierto: segundos reproducidos respecto de la
 * duración, acotado a 0-100. Mide cobertura real (no es "gameable" con un seek
 * al final, porque los saltos no suman). Devuelve 0 si la duración no es válida.
 */
export function watchedPercent(watchedSeconds: number, durationSeconds: number): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  const pct = (watchedSeconds / durationSeconds) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
