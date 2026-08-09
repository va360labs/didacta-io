/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tests del endpoint público de assets de módulos (MUST-FIX 26).
 *
 * `GET /api/v1/modules/:slug/ui/:surface.js` NO pide autenticación. Antes de
 * este fix cada motivo de fallo devolvía un `code` y un `message` distintos:
 *
 *   - `MARKETPLACE_MODULE_NOT_INSTALLED`  → "no está instalado"
 *   - `MARKETPLACE_MODULE_NOT_AVAILABLE`  → "(status: FAILED)"   ← estado interno
 *   - `MARKETPLACE_PACKAGE_DOWNLOAD_FAILED` → `err.message` crudo ← ruta/bucket
 *   - `MARKETPLACE_SURFACE_UI_MISSING`    → "no tiene UI para surface"
 *
 * Un anónimo podía por tanto enumerar qué módulos hay instalados en la
 * instancia y en qué estado, y sacarle al storage la ruta absoluta del blob
 * (disco local) o el nombre del bucket (S3).
 *
 * Estos tests fijan las dos mitades del contrato nuevo:
 *   (a) el cliente NO ve ningún detalle interno y las cinco causas son
 *       indistinguibles entre sí — mismo status, mismo `code`, mismo `message`;
 *   (b) el detalle real SÍ queda en el log del servidor con contexto para
 *       depurar (módulo, surface, versión, storage key y el error original).
 */

import { Logger, NotFoundException } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { ModuleAssetsController } from '../../src/marketplace/module-assets.controller';
import type { InstalledModuleService } from '../../src/marketplace/installed-module.service';
import type { ModuleContextFactory } from '../../src/modules/module-context.factory';

/// Cuerpo exacto que el endpoint debe devolver ante CUALQUIER motivo por el
/// que no puede servir el bundle. Si un refactor futuro diferencia una causa,
/// estos tests caen.
const GENERIC_BODY = {
  message: 'El recurso solicitado no está disponible.',
  code: 'MARKETPLACE_ASSET_NOT_FOUND',
};

/// Fragmentos que NUNCA pueden aparecer en lo que ve el cliente. Cubren las
/// dos familias de storage soportadas: disco local (ruta absoluta en el
/// ENOENT de `readFile`) y S3/MinIO (bucket + endpoint en el error del SDK).
const LOCAL_DISK_ERROR =
  "ENOENT: no such file or directory, open '/var/lib/didacta/storage/modules/mod.example-1.0.0.zip'";
const S3_ERROR = 'NoSuchKey: The specified key does not exist. Bucket: didacta-prod-modules';

function makeRes(): FastifyReply {
  return { header: vi.fn() } as unknown as FastifyReply;
}

function makeInstalled(row: unknown): InstalledModuleService {
  return { findByName: vi.fn(async () => row) } as unknown as InstalledModuleService;
}

function makeContextFactory(download: () => Promise<Buffer>): ModuleContextFactory {
  return { getStorage: () => ({ download }) } as unknown as ModuleContextFactory;
}

/// Row mínimo de `installed_module` con los campos que el controller lee.
function moduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'mod.example',
    version: '1.0.0',
    status: 'INSTALLED',
    packageStorageKey: 'modules/mod.example-1.0.0.zip',
    ...overrides,
  };
}

/// ZIP válido que NO contiene `dist/ui/<surface>.js`.
function zipWithoutBundle(): Buffer {
  const zip = new AdmZip();
  zip.addFile('module.json', Buffer.from('{"name":"mod.example"}', 'utf8'));
  return zip.toBuffer();
}

/// ZIP válido que SÍ contiene el bundle de la surface `admin`.
function zipWithBundle(code: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('dist/ui/admin.js', Buffer.from(code, 'utf8'));
  return zip.toBuffer();
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  // El cache de bundles es estático a nivel de módulo: sin esto un test que
  // sirve un bundle contamina a los siguientes con el mismo slug+surface.
  ModuleAssetsController.invalidateCache('mod.example');
});

/// Ejecuta el endpoint y devuelve el cuerpo que vería el cliente.
async function callAndCaptureBody(ctrl: ModuleAssetsController): Promise<unknown> {
  try {
    await ctrl.getUIBundle('example', 'admin', makeRes());
  } catch (err) {
    expect(err).toBeInstanceOf(NotFoundException);
    return (err as NotFoundException).getResponse();
  }
  throw new Error('Se esperaba un NotFoundException y no se lanzó ninguno.');
}

/// Aplana todo lo que se pasó al logger (mensaje + trace) en un solo string.
function loggedText(): string {
  return [...warn.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
}

describe('ModuleAssetsController · endpoint público sin auth', () => {
  it('status distinto de INSTALLED: el cliente no ve el estado interno, el log sí', async () => {
    const ctrl = new ModuleAssetsController(
      makeInstalled(moduleRow({ status: 'FAILED' })),
      makeContextFactory(async () => zipWithBundle('ok')),
    );

    const body = await callAndCaptureBody(ctrl);

    // (a) el cliente no ve el status interno de instalación
    expect(body).toEqual(GENERIC_BODY);
    expect(JSON.stringify(body)).not.toContain('FAILED');
    expect(JSON.stringify(body)).not.toContain('status');

    // (b) el operador sí lo ve, con módulo y surface para depurar
    const log = loggedText();
    expect(log).toContain('FAILED');
    expect(log).toContain('module=mod.example');
    expect(log).toContain('surface=admin');
  });

  it('fallo del storage: el cliente no ve el error crudo (ruta local), el log sí', async () => {
    const ctrl = new ModuleAssetsController(
      makeInstalled(moduleRow()),
      makeContextFactory(async () => {
        throw new Error(LOCAL_DISK_ERROR);
      }),
    );

    const body = await callAndCaptureBody(ctrl);

    // (a) ni el mensaje del storage ni la ruta absoluta llegan al cliente
    expect(body).toEqual(GENERIC_BODY);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('ENOENT');
    expect(serialized).not.toContain('/var/lib/didacta');
    expect(serialized).not.toContain('modules/mod.example-1.0.0.zip');

    // (b) el log lleva el error original + la storage key que falló
    const log = loggedText();
    expect(log).toContain('ENOENT');
    expect(log).toContain('/var/lib/didacta/storage/modules/mod.example-1.0.0.zip');
    expect(log).toContain('storageKey=modules/mod.example-1.0.0.zip');
    expect(error).toHaveBeenCalled();
  });

  it('fallo del storage S3: el nombre del bucket no llega al cliente', async () => {
    const ctrl = new ModuleAssetsController(
      makeInstalled(moduleRow()),
      makeContextFactory(async () => {
        throw new Error(S3_ERROR);
      }),
    );

    const body = await callAndCaptureBody(ctrl);

    expect(body).toEqual(GENERIC_BODY);
    expect(JSON.stringify(body)).not.toContain('didacta-prod-modules');
    expect(loggedText()).toContain('didacta-prod-modules');
  });

  it('paquete sin bundle para la surface: no confirma que el módulo esté instalado', async () => {
    const ctrl = new ModuleAssetsController(
      makeInstalled(moduleRow()),
      makeContextFactory(async () => zipWithoutBundle()),
    );

    const body = await callAndCaptureBody(ctrl);

    // (a) el cliente no puede deducir que el módulo existe ni su versión
    expect(body).toEqual(GENERIC_BODY);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('mod.example');
    expect(serialized).not.toContain('1.0.0');
    expect(serialized).not.toContain('dist/ui');

    // (b) el log dice exactamente qué entrada faltaba en el ZIP
    const log = loggedText();
    expect(log).toContain('dist/ui/admin.js');
    expect(log).toContain('version=1.0.0');
  });

  it('paquete corrupto: no escapa como 500 ni filtra el error de adm-zip', async () => {
    const ctrl = new ModuleAssetsController(
      makeInstalled(moduleRow()),
      // Bytes que no son un ZIP: adm-zip revienta al parsear el directorio.
      makeContextFactory(async () => Buffer.from('esto no es un zip', 'utf8')),
    );

    const body = await callAndCaptureBody(ctrl);

    expect(body).toEqual(GENERIC_BODY);
    expect(error).toHaveBeenCalled();
    expect(loggedText()).toContain('module=mod.example');
  });

  it('las cinco causas de fallo son indistinguibles desde fuera', async () => {
    const scenarios: Array<() => ModuleAssetsController> = [
      // no instalado
      () =>
        new ModuleAssetsController(
          makeInstalled(null),
          makeContextFactory(async () => zipWithBundle('ok')),
        ),
      // instalado pero en otro status
      () =>
        new ModuleAssetsController(
          makeInstalled(moduleRow({ status: 'INSTALLING' })),
          makeContextFactory(async () => zipWithBundle('ok')),
        ),
      // storage caído
      () =>
        new ModuleAssetsController(
          makeInstalled(moduleRow()),
          makeContextFactory(async () => {
            throw new Error(S3_ERROR);
          }),
        ),
      // ZIP corrupto
      () =>
        new ModuleAssetsController(
          makeInstalled(moduleRow()),
          makeContextFactory(async () => Buffer.from('no soy un zip', 'utf8')),
        ),
      // ZIP válido sin el bundle de esa surface
      () =>
        new ModuleAssetsController(
          makeInstalled(moduleRow()),
          makeContextFactory(async () => zipWithoutBundle()),
        ),
    ];

    const bodies: unknown[] = [];
    const statuses: number[] = [];
    for (const build of scenarios) {
      try {
        await build().getUIBundle('example', 'admin', makeRes());
        throw new Error('Se esperaba un NotFoundException y no se lanzó ninguno.');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        bodies.push((err as NotFoundException).getResponse());
        statuses.push((err as NotFoundException).getStatus());
      }
    }

    // Un solo status y un solo cuerpo para las cinco: sin oráculo de
    // enumeración. Esta es la aserción que impide que el fix se revierta.
    expect(new Set(statuses)).toEqual(new Set([404]));
    for (const body of bodies) expect(body).toEqual(GENERIC_BODY);
  });

  it('el camino feliz sigue sirviendo el bundle con sus headers de cache', async () => {
    const res = makeRes();
    const ctrl = new ModuleAssetsController(
      makeInstalled(moduleRow()),
      makeContextFactory(async () => zipWithBundle('console.log(1)')),
    );

    const file = await ctrl.getUIBundle('example', 'admin', res);

    expect(file.getStream()).toBeDefined();
    expect(res.header).toHaveBeenCalledWith('ETag', '"1.0.0"');
    expect(res.header).toHaveBeenCalledWith('X-Module-Version', '1.0.0');
  });

  it('surface inválida mantiene su code: no depende de qué haya instalado', async () => {
    const installed = makeInstalled(moduleRow());
    const ctrl = new ModuleAssetsController(
      installed,
      makeContextFactory(async () => zipWithBundle('ok')),
    );

    await expect(ctrl.getUIBundle('example', 'inventada', makeRes())).rejects.toMatchObject({
      response: { code: 'MARKETPLACE_ASSET_SURFACE_INVALID' },
    });
    // Se rechaza antes de tocar la BD, así que no revela nada de la instancia.
    expect(installed.findByName).not.toHaveBeenCalled();
  });
});
