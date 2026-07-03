import sharp from 'sharp';

/**
 * Optimizador de imágenes para web. Recomprime y redimensiona imágenes raster a
 * WebP para que se sirvan ligeras (portadas de curso, avatares, adjuntos de
 * comunidad, imágenes inline). No procesa vectores (SVG) ni documentos: esos
 * pasan intactos.
 *
 * Se usa desde el endpoint genérico de upload (`StorageController`), tanto al
 * subir (auto-optimización) como para reprocesar imágenes ya existentes.
 */

/** Tipos raster que sabemos recomprimir/redimensionar con sharp. */
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Ancho máximo por defecto (px). Suficiente para el hero del curso y cards. */
const DEFAULT_MAX_WIDTH = 1600;
/** Calidad WebP por defecto: buen equilibrio nitidez/peso para fotos. */
const DEFAULT_QUALITY = 80;

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface OptimizeImageOptions {
  /** Ancho máximo en px; nunca amplía. Default 1600. Se acota a [64, 4096]. */
  maxWidth?: number;
  /** Calidad WebP. Default 80. Se acota a [40, 95]. */
  quality?: number;
}

export interface OptimizedImage {
  buffer: Buffer;
  contentType: string;
  /** Extensión SIN punto que debe llevar la key para servir el MIME correcto. */
  extension: string;
  width?: number;
  height?: number;
  /** true si el resultado se recomprimió a algo más pequeño que el original. */
  optimized: boolean;
}

/** ¿Sabemos recomprimir este contentType? (raster; SVG/documentos no). */
export function isOptimizableImage(contentType: string): boolean {
  return RASTER_IMAGE_TYPES.has(contentType);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function contentTypeFromFormat(format?: string): string | null {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return null;
  }
}

/**
 * Recomprime y redimensiona una imagen raster a WebP. Convierte png/jpeg/gif a
 * WebP (soporta transparencia y animación), respeta la orientación EXIF y NUNCA
 * amplía. Si el resultado no es más pequeño que el original (imágenes ya
 * diminutas), el formato no es raster, o sharp falla con una imagen corrupta,
 * devuelve el original intacto con `optimized:false` — así el upload nunca se
 * rompe por una imagen rara.
 */
export async function optimizeImage(
  input: Buffer,
  contentType: string,
  opts: OptimizeImageOptions = {},
): Promise<OptimizedImage> {
  const passthrough = (): OptimizedImage => ({
    buffer: input,
    contentType,
    extension: EXT_BY_TYPE[contentType] ?? 'bin',
    optimized: false,
  });

  if (!isOptimizableImage(contentType)) return passthrough();

  const maxWidth = clamp(opts.maxWidth ?? DEFAULT_MAX_WIDTH, 64, 4096);
  const quality = clamp(opts.quality ?? DEFAULT_QUALITY, 40, 95);
  // GIF puede ser animado: leemos todos los frames y emitimos WebP animado.
  const animated = contentType === 'image/gif';

  try {
    const out = await sharp(input, { animated })
      .rotate() // aplica la orientación EXIF y descarta el tag (fotos de móvil)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    // Nos quedamos con el original si comprimir no aportó nada (el header WebP
    // puede pesar más que el ahorro en imágenes ya minúsculas).
    if (out.data.length >= input.length) return passthrough();

    return {
      buffer: out.data,
      contentType: 'image/webp',
      extension: 'webp',
      width: out.info.width,
      height: out.info.height,
      optimized: true,
    };
  } catch {
    return passthrough();
  }
}

/**
 * Detecta el contentType raster de un buffer con sharp (útil para reprocesar
 * imágenes existentes, donde solo tenemos los bytes). Devuelve null si el buffer
 * no es una imagen raster que sepamos optimizar.
 */
export async function detectRasterContentType(input: Buffer): Promise<string | null> {
  try {
    const meta = await sharp(input).metadata();
    const type = contentTypeFromFormat(meta.format);
    return type && isOptimizableImage(type) ? type : null;
  } catch {
    return null;
  }
}

/**
 * Cambia la extensión de un nombre de fichero ya saneado. Si no tiene extensión,
 * la añade. Garantiza que la key acabe en `.webp` para que el servidor de
 * ficheros locales resuelva el MIME correcto.
 */
export function swapExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base || 'image'}.${ext}`;
}
