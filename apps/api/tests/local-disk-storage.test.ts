import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskStorageService } from '../src/modules/local-disk-storage.service';

describe('LocalDiskStorageService', () => {
  let root: string;
  let storage: LocalDiskStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lmship-storage-'));
    storage = new LocalDiskStorageService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('upload + download round-trip', async () => {
    const buf = Buffer.from('hello pdf');
    await storage.upload('certificates/t1/abc.pdf', buf);
    const back = await storage.download('certificates/t1/abc.pdf');
    expect(back.toString()).toBe('hello pdf');
  });

  it('crea directorios anidados al uploadear', async () => {
    await storage.upload('a/b/c/d/e.bin', Buffer.from('x'));
    const file = await readFile(join(root, 'a/b/c/d/e.bin'));
    expect(file.toString()).toBe('x');
  });

  it('rechaza keys con traversal (..)', async () => {
    await expect(storage.upload('../escape.txt', Buffer.from('bad'))).rejects.toThrow(
      /no permitidos|traversal/,
    );
  });

  it('rechaza keys absolutas', async () => {
    await expect(storage.upload('/etc/passwd', Buffer.from('x'))).rejects.toThrow(/relativa/);
  });

  it('rechaza keys con caracteres no permitidos', async () => {
    await expect(storage.upload('a b\\c', Buffer.from('x'))).rejects.toThrow(/no permitidos/);
  });

  it('delete es idempotente sobre archivos inexistentes', async () => {
    await expect(storage.delete('does/not/exist.bin')).resolves.toBeUndefined();
  });

  it('getSignedUrl devuelve ruta /storage/...', async () => {
    const url = await storage.getSignedUrl('foo/bar.bin');
    expect(url).toBe('/storage/foo/bar.bin');
  });
});
