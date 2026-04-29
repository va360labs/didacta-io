import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface UploadResult {
  key: string;
  url: string;
  contentType: string;
  size: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

/**
 * Lee un File como base64 puro (sin el prefijo `data:...,`).
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('No se pudo leer el archivo.'));
        return;
      }
      // result es `data:<mime>;base64,<XXX>` — quitamos el prefijo.
      const idx = result.indexOf(',');
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

export const storageApi = {
  /**
   * Sube una imagen al storage del tenant y devuelve la URL para
   * incrustar en `<img src>`. Lo usa el editor enriquecido de cursos.
   */
  async uploadImage(file: File): Promise<UploadResult> {
    const data = await fileToBase64(file);
    return apiFetch<UploadResult>(
      '/api/v1/storage/upload',
      {
        method: 'POST',
        body: JSON.stringify({
          data,
          filename: file.name,
          contentType: file.type,
        }),
      },
      withAuth(),
    );
  },
};
