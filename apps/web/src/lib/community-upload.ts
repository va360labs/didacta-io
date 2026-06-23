import { authStorage } from '@/lib/auth-storage';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

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
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('El archivo supera el límite de 10 MB.');
  }
  const base64 = await readAsBase64(file);
  const url = await callUploadEndpoint(base64, file.name, file.type);
  return { url, name: file.name };
}
