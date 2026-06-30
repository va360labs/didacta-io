import { authStorage } from '@/lib/auth-storage';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

/** Tipos de documento/archivo admitidos (espejo del allowlist del backend). */
const ALLOWED_FILE_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.ms-powerpoint', // ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
]);

/**
 * Mapa extensión → MIME. Windows a veces reporta `file.type` vacío o no estándar
 * para zip/pptx/etc.; cuando el MIME del navegador no sirve, lo derivamos de la
 * extensión para mandar un contentType que el backend acepte (si no, lo rechazaba
 * o el request se quedaba colgado).
 */
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
};

/** Resuelve un contentType admitido para un archivo, o null si no se soporta. */
function resolveFileContentType(file: File): string | null {
  if (file.type && ALLOWED_FILE_TYPES.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? null;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function callUploadEndpoint(
  base64: string,
  filename: string,
  contentType: string,
): Promise<string> {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('No autenticado');

  const res = await fetch('/api/v1/storage/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data: base64, filename, contentType }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Error ${res.status} al subir el archivo.`);
  }

  const result = (await res.json()) as { url: string };
  return result.url;
}

export async function uploadCommunityImage(file: File): Promise<string> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Tipo de imagen no admitido. Usa PNG, JPG, WebP, GIF o SVG.');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('La imagen supera el límite de 5 MB.');
  }
  const base64 = await readAsBase64(file);
  return callUploadEndpoint(base64, file.name, file.type);
}

export async function uploadCommunityFile(file: File): Promise<{ url: string; name: string }> {
  const contentType = resolveFileContentType(file);
  if (!contentType) {
    throw new Error(
      'Tipo de archivo no admitido. Usa PDF, Word, Excel, PowerPoint, TXT, CSV o ZIP.',
    );
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('El archivo supera el límite de 10 MB.');
  }
  const base64 = await readAsBase64(file);
  const url = await callUploadEndpoint(base64, file.name, contentType);
  return { url, name: file.name };
}
