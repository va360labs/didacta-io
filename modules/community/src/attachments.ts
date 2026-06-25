/**
 * Parsing y aplanado de los adjuntos embebidos en el body de un post.
 *
 * El compositor del frontend serializa imágenes y archivos como un comentario
 * HTML al final del body:
 *   `<!--didacta-attachments:{"images":[...],"files":[...]}-->`
 *
 * Este módulo es la contraparte BACKEND de
 * `apps/web/src/modules/community/attachments.ts`. Ambos deben mantener el
 * MISMO formato del marcador. No compartimos código porque viven en paquetes
 * distintos (web vs. módulo de servidor).
 */

export interface AttachmentImage {
  url: string;
  name: string;
}

export interface AttachmentFile {
  url: string;
  name: string;
  size?: number;
}

/** Adjunto aplanado con la metadata del post del que proviene. */
export interface CommunityAttachment {
  kind: 'image' | 'file';
  url: string;
  name: string;
  size?: number;
  postId: string;
  postTitle: string;
  authorId: string;
  authorName: string | null;
  /** ISO-8601 (createdAt del post). */
  createdAt: string;
}

/** Forma mínima del post que necesita `flattenPostAttachments`. */
export interface PostForAttachments {
  id: string;
  title: string;
  body: string;
  authorId: string;
  authorDisplayName: string | null;
  createdAt: Date;
}

const ATTACHMENTS_MARKER = '<!--didacta-attachments:';

export function parseBodyAttachments(body: string): {
  images: AttachmentImage[];
  files: AttachmentFile[];
} {
  const idx = body.indexOf(ATTACHMENTS_MARKER);
  if (idx === -1) return { images: [], files: [] };
  const jsonStart = idx + ATTACHMENTS_MARKER.length;
  const jsonEnd = body.indexOf('-->', jsonStart);
  if (jsonEnd === -1) return { images: [], files: [] };
  try {
    const raw = JSON.parse(body.slice(jsonStart, jsonEnd)) as {
      images?: AttachmentImage[];
      files?: AttachmentFile[];
    };
    return {
      images: Array.isArray(raw.images) ? raw.images : [],
      files: Array.isArray(raw.files) ? raw.files : [],
    };
  } catch {
    return { images: [], files: [] };
  }
}

/**
 * El body es texto libre controlado por el usuario (la API `createPost` acepta
 * cualquier string), así que el marcador podría traer URLs arbitrarias. La
 * galería pinta estas URLs en `<img src>` / `<a href>`, por lo que solo
 * dejamos pasar esquemas seguros (http/https) o rutas relativas del propio host.
 */
function isSafeUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.startsWith('/')) return true;
  return /^https?:\/\//i.test(url);
}

/**
 * Aplana los adjuntos de una lista de posts a un array plano, conservando la
 * metadata (post, autor, fecha) de cada uno. Descarta adjuntos con URL no segura.
 */
export function flattenPostAttachments(posts: PostForAttachments[]): CommunityAttachment[] {
  const out: CommunityAttachment[] = [];
  for (const post of posts) {
    const { images, files } = parseBodyAttachments(post.body);
    const base = {
      postId: post.id,
      postTitle: post.title,
      authorId: post.authorId,
      authorName: post.authorDisplayName,
      createdAt: post.createdAt.toISOString(),
    };
    for (const img of images) {
      if (!isSafeUrl(img?.url)) continue;
      out.push({ kind: 'image', url: img.url, name: img.name ?? '', ...base });
    }
    for (const file of files) {
      if (!isSafeUrl(file?.url)) continue;
      out.push({
        kind: 'file',
        url: file.url,
        name: file.name ?? '',
        ...(typeof file.size === 'number' ? { size: file.size } : {}),
        ...base,
      });
    }
  }
  return out;
}
