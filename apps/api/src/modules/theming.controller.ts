import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LogoNotFoundError,
  updateThemeSchema,
  uploadLogoSchema,
  type UpdateThemeDto,
  type UploadLogoDto,
} from '@didacta/mod-theming';
import { LicenseService, LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import type { FastifyReply } from 'fastify';
import { CurrentUser, Public } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Campos del UpdateThemeDto que requieren capability `feat:white_label` activa
 * para poder modificarse. Los colores, fuentes y copy del tenant son CE; el
 * CSS arbitrario y el footer HTML son white-label puro.
 */
const WHITE_LABEL_FIELDS = ['customCss', 'footerHtml'] as const satisfies readonly (keyof UpdateThemeDto)[];

@ApiTags('Modules · Theming')
@ApiBearerAuth()
@Controller('modules/theming')
@UseGuards(JwtAuthGuard)
export class ThemingController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly license: LicenseService,
  ) {}

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
      'Actualiza el theme del tenant. Solo super_admin y tenant_admin. Los campos `customCss` y `footerHtml` exigen capability Enterprise `feat:white_label` activa — sin licencia el endpoint devuelve 402.',
  })
  async updateMine(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(updateThemeSchema)) dto: UpdateThemeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo administradores pueden modificar el theme.');
    }
    // Si el dto incluye CUALQUIER campo white-label (customCss / footerHtml),
    // requerimos la capability EE. Lanza CapabilityRequiredError → 402.
    const touchesWhiteLabel = WHITE_LABEL_FIELDS.some((f) => dto[f] !== undefined);
    if (touchesWhiteLabel) {
      this.license.requireCapability(LICENSE_CAPABILITIES.WHITE_LABEL);
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

  @Post('me/logo')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sube un logo (PNG/JPG/SVG/WebP, max 2 MB) al storage del tenant y actualiza el theme. Solo administradores.',
  })
  async uploadLogo(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(uploadLogoSchema)) dto: UploadLogoDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo administradores pueden subir el logo.');
    }
    return this.registry.getThemingService().uploadLogo(user.tenantId, dto);
  }

  @Delete('me/logo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Elimina el logo subido del tenant (limpia blob + columnas). Solo administradores.',
  })
  async removeLogo(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo administradores pueden eliminar el logo.');
    }
    return this.registry.getThemingService().removeLogo(user.tenantId);
  }

  @Get('tenants/:tenantId/logo')
  @Public()
  @ApiOperation({
    summary:
      'Sirve el logo subido del tenant. Endpoint público porque tiene que renderizarse en signin/signup antes de auth.',
  })
  async getPublicLogo(
    @Param('tenantId') tenantId: string,
    @Res({ passthrough: false }) reply: FastifyReply,
  ) {
    try {
      const { buffer, mimeType } = await this.registry.getThemingService().getLogoBlob(tenantId);
      void reply
        .header('Content-Type', mimeType)
        .header('Cache-Control', 'public, max-age=300, must-revalidate')
        .send(buffer);
    } catch (e) {
      if (e instanceof LogoNotFoundError) {
        void reply.status(404).send({ error: 'logo_not_found' });
        return;
      }
      throw e;
    }
  }
}
