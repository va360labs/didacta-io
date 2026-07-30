/**
 * Normalización de transcripciones de clase para el tutor IA.
 *
 * El formato canónico que se guarda en `content.transcript` de una lección de
 * vídeo es un bloque por intervención, separados por línea en blanco y con la
 * marca de tiempo delante:
 *
 *     [00:00] Hola, bienvenidos al capítulo de webhooks.
 *
 *     [00:32] Lo primero que vamos a hacer es crear el nodo.
 *
 * Dos motivos para esa forma:
 *
 *   1. El troceador del indexador parte por líneas en blanco, así que cada
 *      fragmento acaba conteniendo intervenciones completas y arranca con su
 *      marca de tiempo.
 *   2. Como la marca viaja dentro del texto, el tutor puede responder «te lo
 *      explica en el 12:34» y la cita puede enlazar a ese segundo del vídeo,
 *      sin columnas nuevas en la base de datos.
 *
 * Acepta SRT, WebVTT y texto plano. El texto plano se devuelve tal cual
 * (limpiando saltos) porque sin marcas de tiempo no hay nada que extraer.
 */

export interface TranscriptSegment {
  startSeconds: number;
  text: string;
}

const TIMECODE =
  /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
/** Variante corta `mm:ss.mmm --> mm:ss.mmm` que emiten algunos exportadores. */
const TIMECODE_CORTO = /(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** `hh:mm:ss` → segundos. */
function aSegundos(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export function formatMmSs(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const dos = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}

/**
 * Extrae los segmentos de un SRT o WebVTT. Devuelve [] si el texto no lleva
 * ninguna línea de tiempo reconocible (entonces es texto plano).
 */
export function parseSubtitles(raw: string): TranscriptSegment[] {
  const lineas = raw.replace(/\r\n/g, '\n').split('\n');
  const segmentos: TranscriptSegment[] = [];
  let actual: TranscriptSegment | null = null;

  for (const linea of lineas) {
    const largo = TIMECODE.exec(linea);
    const corto = largo ? null : TIMECODE_CORTO.exec(linea);
    if (largo || corto) {
      if (actual && actual.text.trim()) segmentos.push(actual);
      const inicio = largo
        ? aSegundos(largo[1]!, largo[2]!, largo[3]!)
        : Number(corto![1]) * 60 + Number(corto![2]);
      actual = { startSeconds: inicio, text: '' };
      continue;
    }
    if (!actual) continue;
    // Índice numérico suelto del SRT, cabecera WEBVTT y notas: fuera.
    if (/^\d+$/.test(linea.trim())) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(linea.trim())) continue;
    const limpia = linea
      // Etiquetas de posición/karaoke del VTT: <c>, <00:00:01.000>, <v Nombre>
      .replace(/<[^>]*>/g, '')
      .trim();
    if (!limpia) continue;
    actual.text = actual.text ? `${actual.text} ${limpia}` : limpia;
  }
  if (actual && actual.text.trim()) segmentos.push(actual);
  return segmentos;
}

/**
 * Agrupa segmentos cortos hasta juntar al menos `minChars`, conservando la
 * marca de tiempo del primero. Los subtítulos vienen en trozos de 2-3 segundos;
 * sin agrupar, cada fragmento del índice sería una frase suelta sin contexto.
 *
 * `maxGapSeconds` corta la agrupación cuando entre dos intervenciones hay un
 * silencio largo. Sin ese corte, tres frases sueltas repartidas por toda la
 * clase acababan en un único bloque fechado en el minuto de la primera, y el
 * tutor citaba «minuto 0:00» algo que se explica en el 12:34.
 */
export function agruparSegmentos(
  segmentos: TranscriptSegment[],
  minChars = 320,
  maxGapSeconds = 60,
): TranscriptSegment[] {
  const salida: TranscriptSegment[] = [];
  let buffer: TranscriptSegment | null = null;
  let ultimoInicio = 0;

  for (const s of segmentos) {
    if (buffer && s.startSeconds - ultimoInicio > maxGapSeconds) {
      salida.push(buffer);
      buffer = null;
    }
    if (!buffer) {
      buffer = { startSeconds: s.startSeconds, text: s.text };
    } else {
      buffer.text = `${buffer.text} ${s.text}`.trim();
      if (buffer.text.length >= minChars) {
        salida.push(buffer);
        buffer = null;
      }
    }
    ultimoInicio = s.startSeconds;
  }
  if (buffer && buffer.text.trim()) salida.push(buffer);
  return salida;
}

/** Segmentos → formato canónico `[mm:ss] texto`, separados por línea en blanco. */
export function segmentosATexto(segmentos: TranscriptSegment[]): string {
  return segmentos
    .map((s) => `[${formatMmSs(s.startSeconds)}] ${s.text.trim()}`)
    .join('\n\n')
    .trim();
}

export interface NormalizeResult {
  /** Texto listo para guardar en `content.transcript`. */
  text: string;
  /** Formato detectado, para poder decírselo al formador. */
  formato: 'subtitulos' | 'texto';
  /** Nº de bloques resultantes. */
  bloques: number;
}

/**
 * Punto de entrada: recibe el contenido crudo de un .srt/.vtt/.txt y devuelve
 * el texto normalizado. Si no hay marcas de tiempo lo deja como texto plano
 * (el tutor lo indexa igual, sólo que no podrá citar el minuto).
 */
export function normalizeTranscript(raw: string): NormalizeResult {
  const segmentos = parseSubtitles(raw);
  if (segmentos.length > 0) {
    const agrupados = agruparSegmentos(segmentos);
    return {
      text: segmentosATexto(agrupados),
      formato: 'subtitulos',
      bloques: agrupados.length,
    };
  }
  const plano = raw
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return {
    text: plano,
    formato: 'texto',
    bloques: plano ? plano.split(/\n\s*\n+/).length : 0,
  };
}
