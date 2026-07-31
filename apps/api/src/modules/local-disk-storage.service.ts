/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { StorageAdapter } from '@didacta/core-kernel';
import { resolvePersistentDataRoot } from './persistent-data-root';

/**
 * Adapter de storage que persiste en disco bajo el volumen persistente.
 *
 * El root se resuelve via `resolvePersistentDataRoot()` que prueba en este
 * orden: argumento explícito → `STORAGE_ROOT` env → `/app/data/storage` (si
 * existe — detección automática del volumen Docker en PaaS/k8s sin
 * necesidad de env var) → `/app/data` → `./data/storage` (dev local). Ver
 * `persistent-data-root.ts` para detalle.
 *
 * Pensado para Fase 1.A: nada de S3 todavía. La key se sanea para evitar
 * traversal: solo se permiten letras/dígitos/`-_./` y nunca se sale del root.
 *
 * `getSignedUrl` no firma realmente — devuelve la ruta relativa que el reverse
 * proxy del despliegue sirve. En Fase 2 se reemplaza por un service S3-compatible.
 */
export class LocalDiskStorageService implements StorageAdapter {
  private readonly root: string;

  constructor(rootDir?: string) {
    this.root = resolvePersistentDataRoot(rootDir);
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
    // Servimos los ficheros locales por el API (`StorageFileController`), que
    // el reverse-proxy alcanza vía el rewrite `/api/*`. Devolvemos URL absoluta
    // cuando conocemos el host público (NEXT_PUBLIC_DEV_HOST / PUBLIC_BASE_URL)
    // para que pase la validación `z.url()` y sea cargable en `<img src>`; si no,
    // ruta relativa (también la sirve el mismo origin).
    const path = `/api/v1/storage/file/${safe}`;
    const base =
      process.env['PUBLIC_BASE_URL'] ||
      (process.env['NEXT_PUBLIC_DEV_HOST'] ? `https://${process.env['NEXT_PUBLIC_DEV_HOST']}` : '');
    return base ? `${base.replace(/\/+$/, '')}${path}` : path;
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
