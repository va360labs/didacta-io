/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRegistryService } from './module-registry.service';

interface CacheEntry {
  enabled: boolean;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const PATH_PREFIX = '/modules/';

/**
 * Interceptor global que bloquea endpoints de módulos desactivados para el
 * tenant.
 *
 * Se implementa como Interceptor (no Guard) porque necesita `request.user`,
 * que se popula en `JwtAuthGuard` (controller-level). Los APP_GUARD globales
 * corren antes que los guards de controller, así que un guard global NO
 * tendría user disponible.
 *
 * Lógica:
 * - Inspecciona la URL: si matchea `/modules/<segment>/...`, mapea el
 *   segment al nombre del módulo via manifests cargados en el registry
 *   (`courses` → `mod.courses`).
 * - Si el path no es de un módulo conocido, deja pasar (admin, auth, me,
 *   healthz, audit, etc. NO se ven afectados).
 * - Si no hay user (rutas públicas pre-JWT), deja pasar — JwtAuthGuard ya
 *   habría rechazado si auth era requerido.
 * - Consulta `tenant_module`. Si no hay fila, usa `enabledByDefault` del
 *   módulo (true por convención al sembrar al boot).
 * - Cachea (tenantId, moduleName) → boolean por 30s.
 */
@Injectable()
export class ModuleAccessInterceptor implements NestInterceptor {
  private readonly cache = new Map<string, CacheEntry>();
  private segmentMap?: Map<string, string>;

  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const moduleName = this.resolveModuleFromPath(request.url ?? '');
    if (moduleName) {
      const user = request.user;
      if (user?.tenantId) {
        const enabled = await this.isEnabled(user.tenantId, moduleName);
        if (!enabled) {
          throw new ForbiddenException({
            message: `El módulo "${moduleName}" no está activo para este tenant. Contacta al administrador.`,
            code: 'TENANT_MODULES_MODULE_NOT_ACTIVE',
          });
        }
      }
    }
    return next.handle();
  }

  /**
   * Limpia la cache. `TenantModulesService` debería invocarlo tras
   * enable/disable para evitar ventana de inconsistencia.
   */
  invalidate(tenantId?: string, moduleName?: string): void {
    if (tenantId && moduleName) {
      this.cache.delete(this.key(tenantId, moduleName));
      return;
    }
    if (tenantId) {
      for (const k of this.cache.keys()) {
        if (k.startsWith(`${tenantId}::`)) this.cache.delete(k);
      }
      return;
    }
    this.cache.clear();
  }

  private resolveModuleFromPath(rawUrl: string): string | null {
    const path = rawUrl.split('?', 1)[0]!;
    const idx = path.indexOf(PATH_PREFIX);
    if (idx < 0) return null;
    const after = path.slice(idx + PATH_PREFIX.length);
    const segment = after.split('/', 1)[0];
    if (!segment) return null;

    const map = this.getSegmentMap();
    return map.get(segment) ?? null;
  }

  private getSegmentMap(): Map<string, string> {
    if (this.segmentMap) return this.segmentMap;
    const map = new Map<string, string>();
    for (const mod of this.registry.getRegistry().listModules()) {
      const ns = mod.manifest.apiNamespace;
      const segment = ns.replace(/^\/modules\//, '').split('/', 1)[0];
      if (segment) map.set(segment, mod.manifest.name);
    }
    this.segmentMap = map;
    return map;
  }

  private async isEnabled(tenantId: string, moduleName: string): Promise<boolean> {
    const cacheKey = this.key(tenantId, moduleName);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.enabled;

    // Dos queries top-level en vez de include anidado (RLS F2): el include
    // `tenantModules: { where: { tenantId } }` viajaba DENTRO de la query del
    // modelo global Module, invisible para la extensión RLS — bajo didacta_app
    // habría vuelto vacío en silencio y el fallback a enabledByDefault dejaba
    // el gating fail-open. Como op top-level, la lectura de tenant_module sí
    // pasa por el hook (se escopa con el contexto del request o aflora en
    // telemetría si falta).
    const row = await this.prisma.module.findUnique({
      where: { name: moduleName },
      select: { id: true, enabledByDefault: true },
    });
    if (!row) {
      this.cache.set(cacheKey, { enabled: true, expiresAt: now + CACHE_TTL_MS });
      return true;
    }
    const link = await this.prisma.tenantModule.findUnique({
      where: { tenantId_moduleId: { tenantId, moduleId: row.id } },
    });
    const enabled = link ? link.enabled : row.enabledByDefault;
    this.cache.set(cacheKey, { enabled, expiresAt: now + CACHE_TTL_MS });
    return enabled;
  }

  private key(tenantId: string, moduleName: string): string {
    return `${tenantId}::${moduleName}`;
  }
}
