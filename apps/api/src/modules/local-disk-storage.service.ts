import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { StorageService } from '@didacta/core-kernel';

/**
 * StorageService que persiste en disco bajo `STORAGE_ROOT` (default: ./data/storage).
 *
 * Pensado para Fase 1.A: nada de S3 todavía. La key se sanea para evitar
 * traversal: solo se permiten letras/dígitos/`-_./` y nunca se sale del root.
 *
 * `getSignedUrl` no firma realmente — devuelve la ruta relativa que el reverse
 * proxy de Easypanel sirve. En Fase 2 se reemplaza por un service S3-compatible.
 */
export class LocalDiskStorageService implements StorageService {
  private readonly root: string;

  constructor(rootDir?: string) {
    this.root = resolve(rootDir ?? process.env.STORAGE_ROOT ?? './data/storage');
  }

  async upload(
    key: string,
    data: Buffer | Uint8Array,
    _contentType?: string,
  ): Promise<{ key: string }> {
    const safe = this.sanitize(key);
    const fullPath = this.absolutePath(safe);
    await mkdir(dirname(fullPath), { recursive: true });
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await writeFile(fullPath, buffer);
    return { key: safe };
  }

  async download(key: string): Promise<Buffer> {
    const safe = this.sanitize(key);
    return readFile(this.absolutePath(safe));
  }

  async delete(key: string): Promise<void> {
    const safe = this.sanitize(key);
    try {
      await unlink(this.absolutePath(safe));
    } catch (error) {
      // ENOENT es OK: borrar algo que ya no existe es idempotente.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async getSignedUrl(key: string): Promise<string> {
    const safe = this.sanitize(key);
    return `/storage/${safe}`;
  }

  private sanitize(key: string): string {
    if (!key || key.length > 512) throw new Error('Storage key inválida');
    if (!/^[A-Za-z0-9._\-/]+$/.test(key)) {
      throw new Error('Storage key contiene caracteres no permitidos');
    }
    if (key.includes('..')) throw new Error('Storage key contiene traversal');
    if (key.startsWith('/')) throw new Error('Storage key debe ser relativa');
    return key;
  }

  private absolutePath(safeKey: string): string {
    const full = resolve(join(this.root, safeKey));
    // Comprueba que `full` queda dentro del root usando `path.relative`,
    // que es portable entre POSIX y Windows (el `startsWith(root + '/')`
    // anterior fallaba en Windows porque el separador es `\`).
    const rel = relative(this.root, full);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return full;
    }
    throw new Error('Storage key escapa al root');
  }
}
