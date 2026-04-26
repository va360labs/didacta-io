import { Body, Controller, Get, Post, Put, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { updateThemeSchema, type UpdateThemeDto } from '@didacta/mod-theming';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

@ApiTags('Modules · Theming')
@ApiBearerAuth()
@Controller('modules/theming')
@UseGuards(JwtAuthGuard)
export class ThemingController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Theme actual del tenant del usuario (crea con defaults Didacta si no existe). Lectura pública para todos los roles autenticados — el theme es información de presentación.',
  })
  async getMine(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getThemingService().getOrCreate(user.tenantId);
  }

  @Put('me')
  @ApiOperation({
    summary:
      'Actualiza el theme del tenant. Solo super_admin y tenant_admin (permission theming.write).',
  })
  async updateMine(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(updateThemeSchema)) dto: UpdateThemeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo administradores pueden modificar el theme.');
    }
    return this.registry.getThemingService().update(user.tenantId, dto);
  }

  @Post('me/reset')
  @ApiOperation({
    summary: 'Restaura el theme del tenant a los defaults Didacta. Solo administradores.',
  })
  async resetMine(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo administradores pueden resetear el theme.');
    }
    return this.registry.getThemingService().reset(user.tenantId);
  }
}
