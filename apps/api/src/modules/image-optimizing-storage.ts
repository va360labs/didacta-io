import type {
  StorageAdapter,
  StorageService,
  UploadImageOptions,
  UploadedImage,
} from '@didacta/core-kernel';
import { isOptimizableImage, optimizeImage, swapExtension } from './image-optimizer';

/**
 * Envuelve un backend de storage crudo para darle `uploadImage()`.
 *
 * Por qué aquí y no en cada controller: la optimización vivía SOLO en
 * `StorageController`, así que cada vía de subida nueva nacía sin ella — así se
 * coló el logo del tenant (mod.theming escribía el blob crudo) y la API
 * `media.uploadFromBytes` que usan los módulos. Poniéndola en el contrato de
 * storage, cualquier ruta de subida la hereda: la del host, la de los módulos
 * first-party y la de los de terceros del marketplace.
 *
 * `upload()` se deja intacto a propósito: un adapter que reescribe tus bytes
 * por su cuenta sería una trampa para un PDF, un ZIP firmado o los assets de un
 * paquete SCORM (donde el HTML referencia los ficheros por nombre exacto).
 */
export function withImageOptimization<T extends StorageAdapter>(adapter: T): T & StorageService {
  const wrapped = adapter as T & StorageService;

  wrapped.uploadImage = async function uploadImage(
    key: string,
    data: Buffer | Uint8Array,
    contentType: string,
    opts?: UploadImageOptions,
  ): Promise<UploadedImage> {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (!isOptimizableImage(contentType)) {
      // Vectores y formatos que no sabemos recomprimir: se guardan tal cual.
      await adapter.upload(key, input, contentType);
      return {
        key,
        contentType,
        optimized: false,
        size: input.length,
        previousSize: input.length,
      };
    }

    const result = await optimizeImage(input, contentType, opts);
    if (!result.optimized) {
      await adapter.upload(key, input, contentType);
      return {
        key,
        contentType,
        optimized: false,
        size: input.length,
        previousSize: input.length,
      };
    }

    // La extensión tiene que seguir al formato: el servidor de ficheros locales
    // resuelve el MIME por la extensión de la key, así que un WebP guardado como
    // `.png` se serviría con el content-type equivocado.
    const finalKey = swapExtension(key, result.extension);
    await adapter.upload(finalKey, result.buffer, result.contentType);
    return {
      key: finalKey,
      contentType: result.contentType,
      optimized: true,
      size: result.buffer.length,
      previousSize: input.length,
      ...(result.width !== undefined ? { width: result.width } : {}),
      ...(result.height !== undefined ? { height: result.height } : {}),
    };
  };

  return wrapped;
}
