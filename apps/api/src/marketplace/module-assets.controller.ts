import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
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
@Controller('api/v1/modules')
export class ModuleAssetsController {
  constructor(
    private readonly installed: InstalledModuleService,
    private readonly contextFactory: ModuleContextFactory,
  ) {}

  @Get(':slug/ui/:surface.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @ApiOperation({
    summary:
      'Sirve el bundle UI de un módulo para una surface específica. No requiere auth.',
  })
  async getUIBundle(
    @Param('slug') slug: string,
    @Param('surface') surface: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // Validar surface
    if (!MODULE_SURFACES.includes(surface as ModuleSurface)) {
      throw new NotFoundException(`Surface "${surface}" no es válida.`);
    }

    // El slug viene sin "mod." prefix, lo añadimos
    const moduleName = `mod.${slug}`;
    const cacheKey = `${moduleName}:${surface}`;

    // Cache hit
    const cached = bundleCache.get(cacheKey);
    if (cached) {
      res.setHeader('ETag', `"${cached.version}"`);
      res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
      res.setHeader('X-Module-Version', cached.version);
      return new StreamableFile(cached.data);
    }

    // Buscar módulo instalado
    const module = await this.installed.findByName(moduleName);
    if (!module) {
      throw new NotFoundException(`Módulo "${moduleName}" no está instalado.`);
    }
    if (module.status !== 'INSTALLED') {
      throw new NotFoundException(
        `Módulo "${moduleName}" no está disponible (status: ${module.status}).`,
      );
    }

    // Descargar el paquete desde storage
    const storage = this.contextFactory.getStorage();
    let packageBuffer: Buffer;
    try {
      packageBuffer = await storage.download(module.packageStorageKey);
    } catch (err) {
      throw new NotFoundException(
        `Error descargando paquete del módulo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Extraer el bundle UI
    const zip = new AdmZip(packageBuffer);
    const bundlePath = `dist/ui/${surface}.js`;
    const entry = zip.getEntry(bundlePath);
    if (!entry) {
      throw new NotFoundException(
        `El módulo "${moduleName}" no tiene UI para surface "${surface}".`,
      );
    }

    const bundleData = entry.getData();

    // Cachear para próximos requests
    bundleCache.set(cacheKey, { data: bundleData, version: module.version });

    // Headers de cache
    res.setHeader('ETag', `"${module.version}"`);
    res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
    res.setHeader('X-Module-Version', module.version);

    return new StreamableFile(bundleData);
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
