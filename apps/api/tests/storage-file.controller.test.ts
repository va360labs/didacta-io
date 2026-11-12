import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicStorageKey } from '../src/modules/public-storage-keys';

/**
 * `GET /api/v1/storage/file/*` es público (lo que sirve se carga desde `<img>`,
 * desde el `<iframe>` de un SCORM o desde un correo). Servía CUALQUIER fichero
 * bajo la raíz del storage, y en esa raíz vivía la clave maestra de cifrado:
 * `GET /api/v1/storage/file/.didacta-secret-key` devolvía 200 con la clave.
 *
 * Estos tests van por HTTP de verdad (Fastify + el controlador real + disco
 * real) porque el fallo estaba en lo que el router acaba entregando al
 * controlador, no en una función aislada: aquí se prueba también lo que llega
 * codificado (`%2e`, `%2f`).
 */

const SECRET = 'a'.repeat(64);

const FILES: Record<string, string> = {
  // Lo que NO se puede servir nunca.
  '.didacta-secret-key': SECRET,
  '.didacta-instance-id': 'instancia-123',
  'suelto-en-la-raiz.txt': 'raiz',
  'certificates/tenant-a/cert-1.pdf': 'PDF con nombre y apellidos',
  'evidence/tenant-a/fundae/grupo-1/abc.bin': 'evidencia',
  'modules/mod.de-pago/1.0.0-1.zip': 'zip firmado',
  'tenants/tenant-a/privado/nomina.pdf': 'no es uploads ni branding',
  'tenants/tenant-a/uploads/.oculto': 'oculto dentro de un prefijo público',
  'scorm/tenant-a/paquete-1/.htaccess': 'oculto dentro de un paquete',
  // Lo que SÍ es público (control).
  'tenants/tenant-a/uploads/1785782996000-foto.png': 'PNG',
  'tenants/tenant-a/branding/logo.png': 'LOGO',
  'scorm/tenant-a/paquete-1/index.html': '<html>scorm</html>',
  'scorm/tenant-a/paquete-1/js/api.js': 'js',
  'mod-uploads/mod-migrator/tenant-a/0a1b2c': 'portada',
};

describe('StorageFileController · qué se sirve sin sesión', () => {
  let root: string;
  let app: NestFastifyApplication;
  let savedRoot: string | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'didacta-storage-file-'));
    for (const [key, content] of Object.entries(FILES)) {
      const full = join(root, key);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    savedRoot = process.env['STORAGE_ROOT'];
    process.env['STORAGE_ROOT'] = root;

    // Se importa DESPUÉS de fijar STORAGE_ROOT: el controlador resuelve la raíz
    // al construirse.
    const { StorageFileController } = await import('../src/modules/storage-file.controller');
    @Module({ controllers: [StorageFileController] })
    class StorageFileAppModule {}

    app = await NestFactory.create<NestFastifyApplication>(
      StorageFileAppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    if (savedRoot === undefined) delete process.env['STORAGE_ROOT'];
    else process.env['STORAGE_ROOT'] = savedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const get = (path: string) => app.inject({ method: 'GET', url: `/api/v1/storage/file/${path}` });

  describe('la clave maestra de cifrado', () => {
    it.each([
      ['tal cual', '.didacta-secret-key'],
      ['con el punto codificado', '%2edidacta-secret-key'],
      ['todo codificado', '%2E%64idacta-secret-key'],
      [
        'subiendo desde un prefijo público',
        'tenants/tenant-a/uploads/../../../.didacta-secret-key',
      ],
      [
        'subiendo con la barra codificada',
        'tenants/tenant-a/uploads/..%2f..%2f..%2f.didacta-secret-key',
      ],
      [
        'subiendo con los puntos codificados',
        'tenants/tenant-a/uploads/%2e%2e/%2e%2e/%2e%2e/.didacta-secret-key',
      ],
      ['con barra doble', 'tenants/tenant-a/uploads//../../../.didacta-secret-key'],
      ['con la barra invertida', 'tenants/tenant-a/uploads/..%5c..%5c..%5c.didacta-secret-key'],
    ])('%s → no se sirve', async (_caso, path) => {
      const res = await get(path);
      expect(res.statusCode).not.toBe(200);
      expect([400, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain(SECRET);
    });

    it('la petición exacta que funcionaba en producción da 404', async () => {
      const res = await get('.didacta-secret-key');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'STORAGE_FILE_NOT_FOUND' });
    });
  });

  describe('lo que vive en el mismo disco y no es público', () => {
    it.each([
      ['otro fichero oculto de la raíz', '.didacta-instance-id'],
      ['un fichero suelto en la raíz', 'suelto-en-la-raiz.txt'],
      ['un certificado (se descarga por su endpoint)', 'certificates/tenant-a/cert-1.pdf'],
      ['una evidencia de formación', 'evidence/tenant-a/fundae/grupo-1/abc.bin'],
      ['un ZIP del marketplace', 'modules/mod.de-pago/1.0.0-1.zip'],
      ['una carpeta del aula que no es uploads ni branding', 'tenants/tenant-a/privado/nomina.pdf'],
      ['un fichero oculto dentro de un prefijo público', 'tenants/tenant-a/uploads/.oculto'],
      ['un fichero oculto dentro de un paquete SCORM', 'scorm/tenant-a/paquete-1/.htaccess'],
      ['un directorio', 'tenants/tenant-a/uploads/'],
      ['el prefijo sin fichero', 'tenants/tenant-a/uploads'],
    ])('%s → 404, igual que si no existiera', async (_caso, path) => {
      const existe = await get(path);
      const noExiste = await get('tenants/tenant-a/uploads/no-existe.png');
      expect(existe.statusCode).toBe(404);
      // Mismo cuerpo que un fichero inexistente: no se confirma qué hay en disco.
      expect(existe.json()).toEqual(noExiste.json());
    });
  });

  describe('control: lo público se sigue sirviendo', () => {
    it.each([
      ['una imagen subida', 'tenants/tenant-a/uploads/1785782996000-foto.png', 'PNG', 'image/png'],
      ['el logo del aula', 'tenants/tenant-a/branding/logo.png', 'LOGO', 'image/png'],
      ['la entrada de un SCORM', 'scorm/tenant-a/paquete-1/index.html', '<html>scorm</html>', null],
      ['un recurso relativo del SCORM', 'scorm/tenant-a/paquete-1/js/api.js', 'js', null],
      ['una subida de un módulo', 'mod-uploads/mod-migrator/tenant-a/0a1b2c', 'portada', null],
    ])('%s → 200 con su contenido', async (_caso, path, content, type) => {
      const res = await get(path);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(content);
      if (type) expect(res.headers['content-type']).toContain(type);
      // Las cabeceras que neutralizan un HTML/SVG subido siguen puestas.
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('un fichero público que no existe → 404', async () => {
      expect((await get('tenants/tenant-a/uploads/no-existe.png')).statusCode).toBe(404);
    });
  });
});

describe('isPublicStorageKey', () => {
  it.each([
    'tenants/t/uploads/1-a.png',
    'tenants/t/uploads/sub/carpeta/a.pdf',
    'tenants/t/branding/logo',
    'scorm/t/p/index.html',
    'mod-uploads/m/t/abc',
  ])('acepta %s', (key) => {
    expect(isPublicStorageKey(key)).toBe(true);
  });

  it.each([
    '',
    '.didacta-secret-key',
    'tenants/.didacta-secret-key',
    'tenants/t/uploads/../../../.didacta-secret-key',
    'tenants/t/uploads/..',
    'tenants/t/uploads/./a.png',
    'tenants/t/uploads//a.png',
    '/tenants/t/uploads/a.png',
    'tenants/t/uploads/',
    'tenants/t/uploads',
    'tenants//uploads/a.png',
    'tenants/t/otros/a.png',
    'Tenants/t/uploads/a.png',
    'certificates/t/c.pdf',
    'evidence/t/x/y/z.bin',
    'modules/m/1.zip',
    'scorm/t/index.html',
    'tenants/t/uploads/a b.png',
    'tenants/t/uploads/a\\b.png',
    'tenants/t/uploads/a%2e.png',
    `tenants/t/uploads/${'a'.repeat(600)}`,
  ])('rechaza %j', (key) => {
    expect(isPublicStorageKey(key)).toBe(false);
  });

  it('rechaza lo que no es una cadena', () => {
    expect(isPublicStorageKey(undefined)).toBe(false);
    expect(isPublicStorageKey(null)).toBe(false);
    expect(isPublicStorageKey(['tenants/t/uploads/a.png'])).toBe(false);
  });
});
