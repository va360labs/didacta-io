import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ALL_CAPABILITIES, LicenseService } from '@didacta/license-sdk';
import { CurrentUser, MfaExempt } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantModulesService } from './tenant-modules.service';

/**
 * Endpoint para el sidebar del frontend (gating UI).
 *
 * Devuelve, en una sola llamada, el estado del tenant del usuario que el
 * sidebar necesita para decidir qué items mostrar:
 *
 *  - `activeModules`: lista de módulos activos. Incluye:
 *      - Módulos built-in (registry hardcoded) HABILITADOS para el tenant
 *        en `tenant_module.enabled = true`.
 *      - Módulos third-party instalados vía marketplace en estado
 *        `INSTALLED` (`installed_module.status = 'INSTALLED'`). Estos
 *        son a nivel instancia y se consideran activos para todos los
 *        tenants una vez instalados (Community = single-tenant en la
 *        práctica; cuando llegue multi-tenant.real, se añadirá la
 *        dimensión por tenant también para third-party).
 *    Items con `requiresModule` que no estén aquí → OCULTOS.
 *
 *  - `enabledCapabilities`: lista de capabilities EE activas en la
 *    instancia (no por tenant — la licencia es global del core).
 *    Items con `requiresCapability` que no estén aquí → marcados con
 *    candado (patrón EeGate, n8n style), NO ocultos.
 *
 * Vive en `ModulesModule` y no en `AuthModule` para evitar dependencia
 * circular (ModulesModule ya importa AuthModule).
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeModulesController {
  constructor(
    private readonly tenantModules: TenantModulesService,
    private readonly license: LicenseService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('modules')
  @MfaExempt()
  @ApiOperation({
    summary:
      'Módulos activos del tenant (built-in + third-party instalados) + capabilities EE de la instancia. Lo consume el sidebar para gating UI.',
  })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const modules = await this.tenantModules.list(user.tenantId);
    const builtInActive = modules.filter((m) => m.enabled).map((m) => m.name);

    // Third-party instalados (marketplace). El frontend los necesita para
    // que las extensions de UI declaradas en `apps/web/src/modules/` sean
    // visibles. Si el día de mañana queremos toggle por tenant para
    // third-party, este es el lugar donde añadir la condición — hoy no lo
    // hacemos para no inventar contrato hasta que multi-tenant.real lo
    // pida.
    const installedRows = await this.prisma.installedModule.findMany({
      where: { status: 'INSTALLED' },
      select: { name: true },
    });
    const thirdPartyActive = installedRows.map((r) => r.name);

    const activeModules = Array.from(new Set([...builtInActive, ...thirdPartyActive]));

    const enabledCapabilities = ALL_CAPABILITIES.filter((c) =>
      this.license.isCapabilityEnabled(c),
    );
    return { activeModules, enabledCapabilities };
  }
}
