/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import AdmZip from 'adm-zip';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { InstalledModuleService } from './installed-module.service';
import { MODULE_SURFACES, type ModuleSurface } from './module-manifest.schema';

/// Cache en memoria de bundles UI extraídos. Evita re-descargar y re-extraer
/// el ZIP en cada request. La key es `${moduleName}:${surface}`.
/// En producción esto podría ser Redis o un CDN, pero para MVP memoria es OK.
const bundleCache = new Map<string, { data: Buffer; version: string }>();

/// Tiempo de cache del bundle en el navegador (1 hora). El header ETag
/// lleva la versión del módulo para invalidación automática.
const CACHE_MAX_AGE = 3600;

/// Respuesta ÚNICA del endpoint público cuando no puede servir un bundle,
/// sea cual sea el motivo real (módulo no instalado, instalado pero en un
/// status no servible, fallo del storage, ZIP corrupto o paquete sin ese
/// bundle). Es deliberadamente vaga.
///
/// SEGURIDAD (MUST-FIX 26): este endpoint NO pide autenticación. Antes
/// devolvía un `code` + `message` distinto por causa, e incluso el status
/// interno de instalación y el `err.message` crudo del storage (que en
/// disco local lleva la ruta absoluta del fichero y en S3 el bucket).
/// Cualquiera podía enumerar qué módulos hay instalados en la instancia y
/// en qué estado. Ahora las cinco causas son indistinguibles desde fuera:
/// mismo 404, mismo `code`, mismo `message`. El motivo real va al log del
/// servidor vía `denyAsset`.
const ASSET_NOT_FOUND_CODE = 'MARKETPLACE_ASSET_NOT_FOUND';
const ASSET_NOT_FOUND_MESSAGE = 'El recurso solicitado no está disponible.';

/**
 * Endpoints públicos para servir assets de módulos instalados.
 *
 * Estos endpoints NO requieren autenticación porque sirven archivos estáticos
 * (JS bundles, iconos) que el browser necesita cargar directamente.
 *
 * SEGURIDAD: El código JS ya fue validado en el momento de la instalación
 * (lint + firma). No hay riesgo adicional al servirlo públicamente.
 */
@ApiTags('Modules · Assets')
// El prefijo `api/v1` lo aplica `app.setGlobalPrefix('api/v1')` en `main.ts`.
// Si lo repetimos en el decorator, la ruta final queda `/api/v1/api/v1/modules/...`
// y el `ModulesDispatcherController` (`@All('modules/*')`) atrapa los requests
// reales — devolviendo "No hay módulo registrado". Ver bug alpha.60.
@Controller('modules')
export class ModuleAssetsController {
  private readonly logger = new Logger(ModuleAssetsController.name);

  constructor(
    private readonly installed: InstalledModuleService,
    private readonly contextFactory: ModuleContextFactory,
  ) {}

  @Get(':slug/ui/:surface.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @ApiOperation({
    summary: 'Sirve el bundle UI de un módulo para una surface específica. No requiere auth.',
  })
  async getUIBundle(
    @Param('slug') slug: string,
    @Param('surface') surface: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<StreamableFile> {
    // Validar surface
    if (!MODULE_SURFACES.includes(surface as ModuleSurface)) {
      throw new NotFoundException({
        message: `Surface "${surface}" no es válida.`,
        code: 'MARKETPLACE_ASSET_SURFACE_INVALID',
        detail: surface,
      });
    }

    // El slug viene sin "mod." prefix, lo añadimos
    const moduleName = `mod.${slug}`;
    const cacheKey = `${moduleName}:${surface}`;

    // Cache hit
    const cached = bundleCache.get(cacheKey);
    if (cached) {
      res.header('ETag', `"${cached.version}"`);
      res.header('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      res.header('X-Module-Version', cached.version);
      return new StreamableFile(cached.data);
    }

    // A partir de aquí toda salida de error usa `denyAsset`: el cliente
    // anónimo recibe siempre el mismo 404 y el motivo real solo va al log.
    const bundlePath = `dist/ui/${surface}.js`;

    // Buscar módulo instalado
    const module = await this.installed.findByName(moduleName);
    if (!module) {
      throw this.denyAsset('el módulo no está instalado en esta instancia', {
        module: moduleName,
        surface,
      });
    }
    if (module.status !== 'INSTALLED') {
      throw this.denyAsset(`el módulo está en status ${module.status}, no en INSTALLED`, {
        module: moduleName,
        surface,
        version: module.version,
      });
    }

    // Descargar el paquete desde storage
    const storage = this.contextFactory.getStorage();
    let packageBuffer: Buffer;
    try {
      packageBuffer = await storage.download(module.packageStorageKey);
    } catch (err) {
      throw this.denyAsset(
        'falló la descarga del paquete desde el storage',
        { module: moduleName, surface, storageKey: module.packageStorageKey },
        err,
      );
    }

    // Extraer el bundle UI. `adm-zip` parsea el directorio central de forma
    // perezosa, así que un paquete corrupto revienta aquí y no en el
    // constructor — por eso ambos van dentro del mismo try. Sin este try el
    // fallo escapaba como 500 y volvía a ser un oráculo: solo se llega a
    // este punto si el módulo existe, está INSTALLED y su blob se descargó.
    let entry: ReturnType<AdmZip['getEntry']>;
    try {
      entry = new AdmZip(packageBuffer).getEntry(bundlePath);
    } catch (err) {
      throw this.denyAsset(
        'el paquete descargado no se pudo leer como ZIP',
        { module: moduleName, surface, storageKey: module.packageStorageKey },
        err,
      );
    }
    if (!entry) {
      throw this.denyAsset(`el paquete no incluye "${bundlePath}"`, {
        module: moduleName,
        surface,
        version: module.version,
      });
    }

    let bundleData: Buffer;
    try {
      bundleData = entry.getData();
    } catch (err) {
      throw this.denyAsset(
        `no se pudo extraer "${bundlePath}" del paquete`,
        { module: moduleName, surface, storageKey: module.packageStorageKey },
        err,
      );
    }

    // Cachear para próximos requests
    bundleCache.set(cacheKey, { data: bundleData, version: module.version });

    // Headers de cache
    res.header('ETag', `"${module.version}"`);
    res.header('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
    res.header('X-Module-Version', module.version);

    return new StreamableFile(bundleData);
  }

  /// Única fábrica del 404 del endpoint público (MUST-FIX 26).
  ///
  /// Registra en el log del servidor el motivo REAL con contexto suficiente
  /// para depurar (módulo, surface, versión, storage key y, si lo hay, el
  /// error original con su stack) y devuelve al cliente un cuerpo idéntico
  /// para todas las causas. Que exista un solo constructor del error es lo
  /// que garantiza que las respuestas no puedan divergir en un refactor
  /// futuro y volver a convertirse en un oráculo de enumeración.
  ///
  /// `warn` cuando la causa es esperable (módulo ausente, sin bundle para
  /// esa surface); `error` cuando hay un fallo real de infraestructura
  /// (storage caído, paquete corrupto) que el operador debe atender.
  private denyAsset(
    reason: string,
    context: Record<string, string | undefined>,
    cause?: unknown,
  ): NotFoundException {
    const detail = Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const line = `Assets · no se sirve el bundle: ${reason} — ${detail}`;
    if (cause === undefined) {
      this.logger.warn(line);
    } else {
      this.logger.error(
        line,
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      );
    }
    return new NotFoundException({
      message: ASSET_NOT_FOUND_MESSAGE,
      code: ASSET_NOT_FOUND_CODE,
    });
  }

  /**
   * Invalida el cache de bundles UI de un módulo.
   * Llamado internamente tras actualización/reinstalación.
   */
  static invalidateCache(moduleName: string): void {
    for (const key of bundleCache.keys()) {
      if (key.startsWith(`${moduleName}:`)) {
        bundleCache.delete(key);
      }
    }
  }
}
