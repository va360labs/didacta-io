import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ALL_CAPABILITIES, LicenseService } from '@didacta/license-sdk';
import { CurrentUser, MfaExempt } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { TenantModulesService } from './tenant-modules.service';

/**
 * Endpoint para el sidebar del frontend (gating UI).
 *
 * Devuelve, en una sola llamada, el estado del tenant del usuario que el
 * sidebar necesita para decidir qué items mostrar:
 *
 *  - `activeModules`: lista de módulos CE habilitados en el tenant.
 *    Items con `requiresModule` que no estén aquí → OCULTOS.
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
  ) {}

  @Get('modules')
  @MfaExempt()
  @ApiOperation({
    summary:
      'Módulos activos del tenant + capabilities EE de la instancia. Lo consume el sidebar para gating UI.',
  })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const modules = await this.tenantModules.list(user.tenantId);
    const activeModules = modules.filter((m) => m.enabled).map((m) => m.name);
    const enabledCapabilities = ALL_CAPABILITIES.filter((c) =>
      this.license.isCapabilityEnabled(c),
    );
    return { activeModules, enabledCapabilities };
  }
}
