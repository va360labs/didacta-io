/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Parsing del marcador de adjuntos embebido en el cuerpo de un post.
///
/// El compositor (`post-composer-modal.tsx`) serializa imágenes y archivos
/// como un comentario HTML al final del body:
///   `<!--didacta-attachments:{"images":[...],"files":[...]}-->`
///
/// Tanto el detalle del post como la tarjeta del feed deben separar ese
/// marcador del texto visible para no mostrarlo en crudo. Esta es la única
/// fuente de verdad del formato; cualquier render del body debe pasar por acá.

export interface AttachmentImage {
  url: string;
  name: string;
}

export interface AttachmentFile {
  url: string;
  name: string;
  size?: number;
}

export interface ParsedBody {
  /** Texto del post sin el marcador de adjuntos. */
  cleanBody: string;
  images: AttachmentImage[];
  files: AttachmentFile[];
}

const ATTACHMENTS_MARKER = '<!--didacta-attachments:';

/**
 * Serializa el texto + adjuntos al formato que entiende `parseBodyAttachments`.
 * Si no hay adjuntos, devuelve el texto sin el marcador. Es la contraparte
 * exacta de `parseBodyAttachments`: ambos deben evolucionar juntos.
 */
export function buildBodyWithAttachments(
  body: string,
  images: AttachmentImage[],
  files: AttachmentFile[],
): string {
  const trimmed = body.trim();
  if (images.length === 0 && files.length === 0) return trimmed;
  return `${trimmed}\n\n${ATTACHMENTS_MARKER}${JSON.stringify({ images, files })}-->`;
}

export function parseBodyAttachments(body: string): ParsedBody {
  const idx = body.indexOf(ATTACHMENTS_MARKER);
  if (idx === -1) return { cleanBody: body, images: [], files: [] };
  const jsonStart = idx + ATTACHMENTS_MARKER.length;
  const jsonEnd = body.indexOf('-->', jsonStart);
  if (jsonEnd === -1) return { cleanBody: body, images: [], files: [] };
  try {
    const raw = JSON.parse(body.slice(jsonStart, jsonEnd)) as {
      images?: AttachmentImage[];
      files?: AttachmentFile[];
    };
    return {
      cleanBody: body.slice(0, idx).trimEnd(),
      images: raw.images ?? [],
      files: raw.files ?? [],
    };
  } catch {
    return { cleanBody: body, images: [], files: [] };
  }
}
