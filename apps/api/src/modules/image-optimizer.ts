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
  /**
   * Formato de salida. Default `'webp'` (lo mejor para la web).
   *
   * `'png'` es para imágenes que además consumen CLIENTES DE EMAIL — hoy, el
   * logo del tenant, que va en la cabecera de todos los correos. WebP no es
   * seguro ahí: Outlook de escritorio no lo entiende y otros clientes decodifican
   * el WebP con pérdida IGNORANDO su canal alfa, así que un logo transparente
   * aparece como un rectángulo negro con las letras recortadas. PNG lo soporta
   * todo el mundo desde siempre, alfa incluido.
   */
  format?: 'webp' | 'png';
}

/**
 * Formatos que cualquier cliente de email sabe pintar. Un logo que ya esté en
 * uno de estos no se fuerza a PNG si eso lo engordara; uno que no lo esté (WebP)
 * SÍ se convierte aunque pese más — que se vea vale más que unos KB.
 */
const EMAIL_SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

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
  const target = opts.format ?? 'webp';
  // GIF puede ser animado: leemos todos los frames y emitimos WebP animado. Con
  // salida PNG NO: sharp apilaría los frames en una tira vertical.
  const animated = contentType === 'image/gif' && target === 'webp';

  try {
    const pipeline = sharp(input, { animated })
      .rotate() // aplica la orientación EXIF y descarta el tag (fotos de móvil)
      .resize({ width: maxWidth, withoutEnlargement: true });

    const conAlfa = target === 'png' ? ((await sharp(input).metadata()).hasAlpha ?? false) : false;

    const out =
      target === 'png'
        ? await encodePngParaEmail(pipeline, conAlfa)
        : await pipeline.webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true });

    const outContentType = target === 'png' ? 'image/png' : 'image/webp';

    // Reescribir es OBLIGATORIO —pese al guard de tamaño— en dos casos, porque
    // ahí los bytes ahorrados no valen nada si la imagen no se ve:
    //  - el original está en un formato que los clientes de email no pintan;
    //  - el original tiene transparencia, y solo reescribiéndolo podemos
    //    garantizar que debajo del alfa hay blanco y no negro.
    const conversionObligada = target === 'png' && (!EMAIL_SAFE_TYPES.has(contentType) || conAlfa);

    // Nos quedamos con el original si comprimir no aportó nada (el header WebP
    // puede pesar más que el ahorro en imágenes ya minúsculas, y recomprimir un
    // WebP ya óptimo solo pierde calidad).
    if (out.data.length >= input.length && !conversionObligada) return passthrough();

    return {
      buffer: out.data,
      contentType: outContentType,
      extension: target,
      width: out.info.width,
      height: out.info.height,
      optimized: true,
    };
  } catch {
    return passthrough();
  }
}

/**
 * Codifica el PNG que se va a ver en un cliente de email. Siempre sin pérdida:
 * un logo es plano y con bordes duros, y comprimirlo con pérdida le deja halos
 * alrededor de las letras.
 *
 * Si la imagen NO tiene alfa, se cuantiza a paleta y queda pequeña.
 *
 * Si la tiene, se hace algo que no se ve pero decide si el email queda bien: el
 * RGB de los píxeles TOTALMENTE transparentes se pinta de blanco. Un logo con
 * fondo transparente suele llevar negro debajo del alfa; si el cliente de correo
 * ignora el canal alfa —cosa que pasa— ese negro sale a la superficie y el logo
 * aparece como un rectángulo negro. Con blanco debajo, el peor caso es un fondo
 * blanco sobre la cabecera blanca del email: invisible. Para quien respeta el
 * alfa no cambia nada.
 *
 * Ojo: en ese caso NO se cuantiza a paleta. El cuantizador reasigna a su antojo
 * el RGB de los píxeles transparentes (le da igual, no se ven) y se cargaría el
 * blanco que acabamos de poner. Un logo pesa unas decenas de KB: barato.
 */
async function encodePngParaEmail(
  pipeline: sharp.Sharp,
  conAlfa: boolean,
): Promise<{ data: Buffer; info: sharp.OutputInfo }> {
  if (!conAlfa) {
    return pipeline
      .png({ compressionLevel: 9, palette: true })
      .toBuffer({ resolveWithObject: true });
  }

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) {
      data[i - 3] = 255;
      data[i - 2] = 255;
      data[i - 1] = 255;
    }
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
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
 *
 * Acepta también una key con directorios (`tenants/…/branding/logo`): solo mira
 * el último segmento, porque un punto en una carpeta no es una extensión y
 * truncar por él dejaría la imagen en otra ruta.
 */
export function swapExtension(name: string, ext: string): string {
  const slash = name.lastIndexOf('/');
  const dir = slash === -1 ? '' : name.slice(0, slash + 1);
  const file = slash === -1 ? name : name.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${dir}${base || 'image'}.${ext}`;
}
