import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { InstalledModule, InstalledModuleStatus, InstalledModuleVendor } from '@didacta/database';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { InstalledModuleService } from './installed-module.service';
import { InstallPackageService, type InstallResult } from './install-package.service';
import { MarketplaceErrorFilter } from './marketplace-error.filter';
import { MarketplacePackageError } from './module-package.errors';
import { ModuleRouterService } from './module-router.service';

const ALLOWED_STATUSES = new Set<InstalledModuleStatus>([
  'INSTALLING',
  'INSTALLED',
  'FAILED',
  'DEPRECATED',
]);
const ALLOWED_VENDORS = new Set<InstalledModuleVendor>(['DIDACTA', 'COMMUNITY']);

/// Vista pública de un row `installed_module`. Filtra metadata sensible
/// (storage key, sha256) que solo el super_admin necesita; aún así toda
/// llamada pasa por `requireSuperAdmin` así que la restricción es por si en
/// el futuro abrimos un endpoint read-only a tenant_admin.
function toPublicInstall(row: InstalledModule): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    prevVersion: row.prevVersion,
    vendor: row.vendor,
    displayName: row.displayName,
    description: row.description,
    coreVersionRequired: row.coreVersionRequired,
    tablePrefix: row.tablePrefix,
    apiNamespace: row.apiNamespace,
    requiredCapabilities: row.requiredCapabilities,
    requiredEnvVars: row.requiredEnvVars,
    isolation: row.isolation,
    status: row.status,
    errorMessage: row.errorMessage,
    signedAt: row.signedAt.toISOString(),
    packageStorageKey: row.packageStorageKey,
    packageSha256: row.packageSha256,
    packageSizeBytes: row.packageSizeBytes,
    installedById: row.installedById,
    installedAt: row.installedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException('Esta acción requiere rol super_admin.');
  }
  return user;
}

/// Endpoints super_admin del marketplace. Solo se llega aquí con un Bearer
/// JWT válido + rol `super_admin`. El upload del `*.didactamod` viaja como
/// body `application/zip` (parser registrado en `main.ts`); el frontend
/// puede usar `fetch(..., { body: file })` con `Content-Type: application/zip`.
///
/// Sin endpoint de download presigned: en MVP el operador no descarga el
/// paquete una vez subido. El blob queda en storage solo para reinstall en
/// otra réplica del deploy o rollback (ambos vías otro endpoint, fuera de
/// este PR).
@ApiTags('Admin · Marketplace módulos')
@ApiBearerAuth()
@Controller('admin/modules')
@UseGuards(JwtAuthGuard)
@UseFilters(MarketplaceErrorFilter)
export class AdminMarketplaceController {
  constructor(
    private readonly install: InstallPackageService,
    private readonly installed: InstalledModuleService,
    private readonly router: ModuleRouterService,
  ) {}

  @Post('install')
  @ApiOperation({
    summary:
      'Instala un paquete *.didactamod firmado por Didacta (KMS alias/didacta-issuer-2026, ES256). Requiere rol super_admin.',
  })
  async installPackage(
    @CurrentUser() user: SessionClaims | undefined,
    @Body() body: Buffer,
  ): Promise<InstallResult> {
    const session = requireSuperAdmin(user);
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new MarketplacePackageError(
        'PACKAGE_INVALID_ZIP',
        'Body vacío o no es application/zip. Manda los bytes del .didactamod en el body.',
      );
    }
    return this.install.install(body, session.sub);
  }

  @Get('installed')
  @ApiOperation({ summary: 'Listado de módulos instalados a nivel instancia. Filtros opcionales por status / vendor.' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('status') status?: string,
    @Query('vendor') vendor?: string,
  ): Promise<{ modules: ReturnType<typeof toPublicInstall>[] }> {
    requireSuperAdmin(user);
    const filters: { status?: InstalledModuleStatus; vendor?: InstalledModuleVendor } = {};
    if (status) {
      const upper = status.toUpperCase();
      if (!ALLOWED_STATUSES.has(upper as InstalledModuleStatus)) {
        throw new MarketplacePackageError(
          'NOT_FOUND',
          `status="${status}" no es válido (esperado: ${[...ALLOWED_STATUSES].join('|')}).`,
        );
      }
      filters.status = upper as InstalledModuleStatus;
    }
    if (vendor) {
      const upper = vendor.toUpperCase();
      if (!ALLOWED_VENDORS.has(upper as InstalledModuleVendor)) {
        throw new MarketplacePackageError(
          'NOT_FOUND',
          `vendor="${vendor}" no es válido (esperado: ${[...ALLOWED_VENDORS].join('|')}).`,
        );
      }
      filters.vendor = upper as InstalledModuleVendor;
    }
    const rows = await this.installed.list(filters);
    return { modules: rows.map(toPublicInstall) };
  }

  @Get('installed/:name')
  @ApiOperation({ summary: 'Detalle de un módulo instalado por su slug (ej. "mod.example").' })
  async findOne(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
  ): Promise<ReturnType<typeof toPublicInstall>> {
    requireSuperAdmin(user);
    const row = await this.installed.findByName(name);
    if (!row) {
      throw new MarketplacePackageError('NOT_FOUND', `Módulo "${name}" no está instalado en esta instancia.`);
    }
    return toPublicInstall(row);
  }

  @Delete('installed/:name')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Desinstala un módulo (solo MVP: borra el row y el blob en storage). NO desactiva el módulo en runtime — eso llega en PR C.',
  })
  async uninstall(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
  ): Promise<void> {
    requireSuperAdmin(user);
    const row = await this.installed.findByName(name);
    if (!row) {
      throw new MarketplacePackageError('NOT_FOUND', `Módulo "${name}" no está instalado.`);
    }
    // Desregistro del dispatcher runtime ANTES del delete BD: una vez
    // borrado el row, los handlers en memoria no pueden volver a
    // resolverse, así que no queremos seguir sirviéndolos.
    this.router.unregisterModule(row.name);
    await this.installed.deleteById(row.id);
  }

  @Get('installed/:name/routes')
  @ApiOperation({ summary: 'Listado de routes HTTP que el módulo expone via dispatcher runtime.' })
  async listRoutes(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
  ): Promise<{ routes: ReturnType<ModuleRouterService['listRoutes']> }> {
    requireSuperAdmin(user);
    const row = await this.installed.findByName(name);
    if (!row) {
      throw new MarketplacePackageError('NOT_FOUND', `Módulo "${name}" no está instalado.`);
    }
    return { routes: this.router.listRoutes(name) };
  }
}
