import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  /**
   * Los ficheros ocultos de la raíz son del propio servidor: ahí vivió la clave
   * maestra de cifrado. Ningún camino de la aplicación —ni el endpoint público,
   * ni un módulo, ni una subida— puede leerlos, pisarlos ni borrarlos a través
   * del adaptador.
   */
  it.each([
    '.didacta-secret-key',
    '.oculto/fichero.bin',
    'tenants/t1/.oculto',
    'tenants/t1/uploads/.htaccess',
    'tenants/./uploads/a.png',
    'tenants//uploads/a.png',
    'tenants/t1/uploads/',
  ])('rechaza leer, escribir y borrar %j (segmento oculto o vacío)', async (key) => {
    await writeFile(join(root, '.didacta-secret-key'), 'clave', 'utf8');

    await expect(storage.download(key)).rejects.toThrow(/segmento|traversal/);
    await expect(storage.upload(key, Buffer.from('pisada'))).rejects.toThrow(/segmento|traversal/);
    await expect(storage.delete(key)).rejects.toThrow(/segmento|traversal/);
    await expect(storage.getSignedUrl(key)).rejects.toThrow(/segmento|traversal/);

    // La clave sigue ahí, intacta.
    expect(await readFile(join(root, '.didacta-secret-key'), 'utf8')).toBe('clave');
  });

  it('un punto en medio del nombre no es un fichero oculto', async () => {
    await storage.upload('tenants/t1/uploads/1-informe.v2.pdf', Buffer.from('x'));
    expect((await storage.download('tenants/t1/uploads/1-informe.v2.pdf')).toString()).toBe('x');
  });

  it('delete es idempotente sobre archivos inexistentes', async () => {
    await expect(storage.delete('does/not/exist.bin')).resolves.toBeUndefined();
  });

  it('getSignedUrl devuelve la ruta /api/v1/storage/file/... (servida por el API)', async () => {
    const url = await storage.getSignedUrl('foo/bar.bin');
    expect(url).toBe('/api/v1/storage/file/foo/bar.bin');
  });
});
