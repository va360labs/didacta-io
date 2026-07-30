import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleContextFactory } from '../modules/module-context.factory';
import {
  detectRasterContentType,
  optimizeImage,
  swapExtension,
  type OptimizeImageOptions,
} from '../modules/image-optimizer';

/**
 * Inventario y reoptimización de las imágenes YA subidas del tenant.
 *
 * Desde que la optimización vive en la capa de storage, todo lo que entra nace
 * ligero. Esto es para lo de antes: portadas, avatares, logos y fotos de posts
 * que se subieron en crudo y siguen pesando lo que pesaban.
 *
 * Cómo repunta cada imagen: reoptimizar crea un blob NUEVO (nunca se pisa el
 * original, que puede seguir referenciado si el guardado falla) y después se
 * actualiza la fila dueña. Cada fuente sabe leer sus referencias y escribir la
 * URL nueva — es la única parte que no se puede generalizar, porque cada una
 * guarda la imagen en un sitio distinto (una columna, o embebida en el body de
 * un post).
 *
 * Lectura cross-module (ADR-016): solo LECTURA de tablas `mod_*` filtrando por
 * `tenant_id`, más la escritura de la URL en la fila que ya era del tenant.
 * Mismo patrón que `AdminBusinessMetricsService`.
 */

/** Marcador de las URLs que sirve el storage local (`StorageFileController`). */
const LOCAL_FILE_MARKER = '/api/v1/storage/file/';

/** Tope de imágenes analizadas por pasada: analizar descarga y recomprime. */
const MAX_ANALYZE = 400;

/**
 * Ganancia mínima para que merezca la pena reescribir una imagen: 10% y 5 KB.
 *
 * Sin este umbral la herramienta no converge. Recomprimir un WebP ya optimizado
 * casi siempre arranca unos bytes más (pérdida generacional), así que la imagen
 * volvía a salir como "optimizable" en cada pasada: el admin le daría una y otra
 * vez, degradando la calidad a cambio de nada. Verificado con un avatar: 1 MB →
 * 2,7 KB en la primera pasada, y en la segunda seguía apareciendo.
 */
const MIN_GAIN_RATIO = 0.1;
const MIN_GAIN_BYTES = 5 * 1024;

function mereceLaPena(previousSize: number, optimizedSize: number): boolean {
  const ahorro = previousSize - optimizedSize;
  return ahorro >= MIN_GAIN_BYTES && ahorro >= previousSize * MIN_GAIN_RATIO;
}

export type ImageSource = 'avatar' | 'curso' | 'coleccion' | 'logo' | 'post';

export interface ImageRef {
  source: ImageSource;
  /** Id de la fila dueña (userId, courseId, …). Para el logo, el tenantId. */
  ownerId: string;
  /** Texto con el que el admin reconoce la imagen en la tabla. */
  label: string;
  /** URL tal cual está persistida hoy. */
  url: string;
}

export interface AnalyzedImage extends ImageRef {
  /** Bytes actuales. null si no pudimos leer el blob (URL externa o borrado). */
  currentSize: number | null;
  /** Bytes que ocuparía optimizada. null si no aplica o no se pudo calcular. */
  optimizedSize: number | null;
  /** Motivo por el que no se puede mejorar, si es el caso. */
  skipReason: 'externa' | 'no-encontrada' | 'no-raster' | 'ya-optima' | null;
}

export interface ImagesInventory {
  items: AnalyzedImage[];
  /** Suma de `currentSize` de lo que SÍ se puede mejorar. */
  currentBytes: number;
  /** Suma de `optimizedSize` de lo mismo. */
  optimizedBytes: number;
  /** Cuántas imágenes se pueden mejorar. */
  optimizable: number;
  /** true si se alcanzó el tope y quedaron imágenes sin analizar. */
  truncated: boolean;
}

export interface OptimizeOutcome {
  source: ImageSource;
  ownerId: string;
  ok: boolean;
  previousSize?: number;
  size?: number;
  error?: string;
}

@Injectable()
export class AdminImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Recorre todas las fuentes de imagen del tenant y mide cuánto pesa cada una
   * y cuánto pesaría optimizada. NO escribe nada: es la vista previa que el
   * admin mira antes de decidir.
   */
  async inventory(tenantId: string): Promise<ImagesInventory> {
    const refs = await this.collectRefs(tenantId);
    const truncated = refs.length > MAX_ANALYZE;
    const aAnalizar = refs.slice(0, MAX_ANALYZE);

    const items: AnalyzedImage[] = [];
    for (const ref of aAnalizar) {
      items.push(await this.analyze(tenantId, ref));
    }

    const mejorables = items.filter((i) => i.skipReason === null);
    return {
      items,
      currentBytes: mejorables.reduce((a, i) => a + (i.currentSize ?? 0), 0),
      optimizedBytes: mejorables.reduce((a, i) => a + (i.optimizedSize ?? 0), 0),
      optimizable: mejorables.length,
      truncated,
    };
  }

  /**
   * Reoptimiza las imágenes indicadas y repunta la fila dueña a la URL nueva.
   * Va de una en una y captura el error de cada cual: que una imagen corrupta
   * reviente no puede tumbar el resto del lote.
   */
  async optimize(tenantId: string, refs: ImageRef[]): Promise<OptimizeOutcome[]> {
    const out: OptimizeOutcome[] = [];
    for (const ref of refs) {
      try {
        const result = await this.optimizeOne(tenantId, ref);
        out.push({ source: ref.source, ownerId: ref.ownerId, ...result });
      } catch (err) {
        out.push({
          source: ref.source,
          ownerId: ref.ownerId,
          ok: false,
          error: (err as Error).message ?? 'error',
        });
      }
    }
    this.logger.log(
      { tenantId, total: refs.length, ok: out.filter((o) => o.ok).length },
      'admin.images: lote reoptimizado',
    );
    return out;
  }

  // -------------------- recolección de referencias --------------------

  private async collectRefs(tenantId: string): Promise<ImageRef[]> {
    const [avatares, cursos, colecciones, theme, posts] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId, deletedAt: null, avatarUrl: { not: null } },
        select: { id: true, name: true, email: true, avatarUrl: true },
      }),
      this.prisma.modCoursesCourse.findMany({
        where: { tenantId, deletedAt: null, thumbnailUrl: { not: null } },
        select: { id: true, title: true, thumbnailUrl: true },
      }),
      this.prisma.modResourcesCollection.findMany({
        where: { tenantId, coverUrl: { not: null } },
        select: { id: true, title: true, coverUrl: true },
      }),
      this.prisma.modThemingTenantTheme.findUnique({
        where: { tenantId },
        select: { tenantId: true, logoStorageKey: true, logoUrl: true },
      }),
      this.prisma.modCommunityPost.findMany({
        where: { tenantId, deletedAt: null, body: { contains: LOCAL_FILE_MARKER } },
        select: { id: true, title: true, body: true },
      }),
    ]);

    const refs: ImageRef[] = [];

    for (const u of avatares) {
      refs.push({
        source: 'avatar',
        ownerId: u.id,
        label: u.name ?? u.email,
        url: u.avatarUrl!,
      });
    }
    for (const c of cursos) {
      refs.push({ source: 'curso', ownerId: c.id, label: c.title, url: c.thumbnailUrl! });
    }
    for (const c of colecciones) {
      refs.push({ source: 'coleccion', ownerId: c.id, label: c.title, url: c.coverUrl! });
    }
    if (theme?.logoStorageKey) {
      // El logo se referencia por storage key, no por URL de storage: su
      // `logoUrl` apunta al endpoint público de branding.
      refs.push({
        source: 'logo',
        ownerId: theme.tenantId,
        label: 'Logo del tenant',
        url: `${LOCAL_FILE_MARKER}${theme.logoStorageKey}`,
      });
    }
    for (const p of posts) {
      // Un post puede llevar varias imágenes en el body; cada una es una fila.
      for (const url of extractStorageUrls(p.body)) {
        refs.push({ source: 'post', ownerId: p.id, label: p.title, url });
      }
    }

    return refs;
  }

  // -------------------- análisis y reescritura --------------------

  private async analyze(tenantId: string, ref: ImageRef): Promise<AnalyzedImage> {
    const base: AnalyzedImage = {
      ...ref,
      currentSize: null,
      optimizedSize: null,
      skipReason: null,
    };

    const key = extractLocalStorageKey(ref.url);
    if (!key || !key.startsWith(`tenants/${tenantId}/`)) {
      return { ...base, skipReason: 'externa' };
    }

    const storage = await this.factory.getStorageForTenant(tenantId);
    let original: Buffer;
    try {
      original = await storage.download(key);
    } catch {
      return { ...base, skipReason: 'no-encontrada' };
    }

    const contentType = await detectRasterContentType(original);
    if (!contentType) {
      return { ...base, currentSize: original.length, skipReason: 'no-raster' };
    }

    const optimized = await optimizeImage(original, contentType, imageOptionsFor(ref.source));
    if (!optimized.optimized || !mereceLaPena(original.length, optimized.buffer.length)) {
      return { ...base, currentSize: original.length, skipReason: 'ya-optima' };
    }

    return {
      ...base,
      currentSize: original.length,
      optimizedSize: optimized.buffer.length,
    };
  }

  private async optimizeOne(
    tenantId: string,
    ref: ImageRef,
  ): Promise<Omit<OptimizeOutcome, 'source' | 'ownerId'>> {
    const key = extractLocalStorageKey(ref.url);
    if (!key || !key.startsWith(`tenants/${tenantId}/`)) {
      return { ok: false, error: 'La imagen no está en el storage de este tenant.' };
    }

    const storage = await this.factory.getStorageForTenant(tenantId);
    const original = await storage.download(key);
    const contentType = await detectRasterContentType(original);
    if (!contentType) return { ok: false, error: 'No es una imagen que sepamos recomprimir.' };

    const optimized = await optimizeImage(original, contentType, imageOptionsFor(ref.source));
    if (!optimized.optimized || !mereceLaPena(original.length, optimized.buffer.length)) {
      return { ok: false, error: 'Ya estaba optimizada.' };
    }

    // Blob nuevo, nunca sobreescritura: si el repunte de la fila falla, la
    // imagen vieja sigue ahí y no se rompe nada visible.
    const base = (key.split('/').pop() ?? 'image').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const newKey = swapExtension(
      `tenants/${tenantId}/uploads/${Date.now()}-${base || 'image'}`,
      optimized.extension,
    );
    await storage.upload(newKey, optimized.buffer, optimized.contentType);
    const newUrl = await storage.getSignedUrl(newKey);

    await this.repoint(tenantId, ref, newUrl, newKey, optimized.contentType);

    return { ok: true, previousSize: original.length, size: optimized.buffer.length };
  }

  /** Escribe la URL nueva en la fila dueña. Cada fuente guarda la suya distinto. */
  private async repoint(
    tenantId: string,
    ref: ImageRef,
    newUrl: string,
    newKey: string,
    newContentType: string,
  ): Promise<void> {
    switch (ref.source) {
      case 'avatar':
        await this.prisma.user.updateMany({
          where: { id: ref.ownerId, tenantId },
          data: { avatarUrl: newUrl },
        });
        return;
      case 'curso':
        await this.prisma.modCoursesCourse.updateMany({
          where: { id: ref.ownerId, tenantId },
          data: { thumbnailUrl: newUrl },
        });
        return;
      case 'coleccion':
        await this.prisma.modResourcesCollection.updateMany({
          where: { id: ref.ownerId, tenantId },
          data: { coverUrl: newUrl },
        });
        return;
      case 'logo':
        // El logo se sirve por su storage key, y el `?v=` fuerza al navegador a
        // soltar el que tenía cacheado.
        await this.prisma.modThemingTenantTheme.updateMany({
          where: { tenantId },
          data: {
            logoStorageKey: newKey,
            logoMimeType: newContentType,
            logoUrl: `/api/v1/modules/theming/tenants/${tenantId}/logo?v=${Date.now()}`,
          },
        });
        return;
      case 'post': {
        // La imagen vive dentro del texto: hay que sustituir esa URL concreta.
        // Se relee el body en vez de usar el del inventario porque el autor
        // pudo editar el post entre el análisis y el "optimizar".
        const post = await this.prisma.modCommunityPost.findFirst({
          where: { id: ref.ownerId, tenantId },
          select: { body: true },
        });
        if (!post || !post.body.includes(ref.url)) {
          throw new Error('El post ya no contiene esa imagen.');
        }
        await this.prisma.modCommunityPost.updateMany({
          where: { id: ref.ownerId, tenantId },
          data: { body: post.body.split(ref.url).join(newUrl) },
        });
        return;
      }
    }
  }
}

/**
 * Ajustes por fuente. Un avatar se pinta a 40-96 px y no necesita 1600 de
 * ancho. Las portadas y las fotos de un post sí se ven a tamaño grande.
 *
 * El logo sale en PNG a propósito (mismo criterio que `mod.theming` al subirlo):
 * ese blob se sirve también en la cabecera de los emails y WebP no es seguro en
 * clientes de correo — hay quien ignora el canal alfa y deja un rectángulo
 * negro. Si esta pantalla lo reoptimizara a WebP, volvería a romper los emails.
 */
function imageOptionsFor(source: ImageSource): OptimizeImageOptions {
  switch (source) {
    case 'avatar':
      return { maxWidth: 512, quality: 80 };
    case 'logo':
      return { maxWidth: 512, format: 'png' };
    default:
      return { maxWidth: 1600, quality: 80 };
  }
}

/**
 * Extrae la storage key de una URL servida por el storage local. Devuelve null
 * si la URL no apunta a nuestro storage (un CDN externo, o una imagen que el
 * admin pegó a mano) — esas no las podemos tocar.
 */
export function extractLocalStorageKey(url: string): string | null {
  const idx = url.indexOf(LOCAL_FILE_MARKER);
  if (idx === -1) return null;
  let key = url.slice(idx + LOCAL_FILE_MARKER.length);
  key = key.split('?')[0]!.split('#')[0]!;
  try {
    key = decodeURIComponent(key);
  } catch {
    // Si el decode falla dejamos la key tal cual; el adapter la saneará.
  }
  return key || null;
}

/**
 * Saca las URLs de imágenes de nuestro storage embebidas en el cuerpo de un
 * post (markdown `![](url)` o HTML `<img src="url">`). Deduplica: la misma
 * imagen repetida en un post es una sola reoptimización.
 */
export function extractStorageUrls(body: string): string[] {
  const re = new RegExp(
    `[^\\s"'()<>\\]]*${LOCAL_FILE_MARKER.replace(/\//g, '\\/')}[^\\s"'()<>\\]]*`,
    'g',
  );
  return [...new Set(body.match(re) ?? [])];
}
