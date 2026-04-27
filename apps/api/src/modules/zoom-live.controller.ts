import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createSessionSchema,
  sessionStatusSchema,
  updateSessionSchema,
  type CreateSessionDto,
  type UpdateSessionDto,
} from '@didacta/mod-zoom-live';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

const listQuerySchema = z.object({
  courseId: z.string().uuid().optional(),
  lessonId: z.string().uuid().optional(),
  status: sessionStatusSchema.optional(),
});

@ApiTags('Modules · Zoom Live')
@ApiBearerAuth()
@Controller('modules/zoom-live')
@UseGuards(JwtAuthGuard)
export class ZoomLiveController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('sessions')
  @ApiOperation({ summary: 'Listar sesiones síncronas del tenant (lectura: cualquier rol).' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getZoomLiveService().list(user.tenantId, q);
  }

  @Get('sessions/:id')
  @ApiOperation({
    summary:
      'Detalle de una sesión. Si el usuario es host o admin, incluye `startUrl`. Alumnos solo ven `joinUrl`.',
  })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    const isHostOrAdmin = user.roles.some((r) => ADMIN_ROLES.has(r));
    return isHostOrAdmin
      ? this.registry.getZoomLiveService().getForHost(user.tenantId, id)
      : this.registry.getZoomLiveService().get(user.tenantId, id);
  }

  @Post('sessions')
  @ApiOperation({
    summary:
      'Crear una sesión Zoom (formador o admin). El stub de Zoom API genera un meetingId determinístico.',
  })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSessionSchema)) dto: CreateSessionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden crear sesiones.');
    }
    return this.registry.getZoomLiveService().create(user.tenantId, user.sub, dto);
  }

  @Put('sessions/:id')
  @ApiOperation({ summary: 'Actualizar una sesión SCHEDULED.' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSessionSchema)) dto: UpdateSessionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden modificar sesiones.');
    }
    return this.registry.getZoomLiveService().update(user.tenantId, user.sub, id, dto);
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar una sesión (soft: status = CANCELLED).' })
  async cancel(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden cancelar sesiones.');
    }
    await this.registry.getZoomLiveService().cancel(user.tenantId, user.sub, id);
    return { cancelled: true };
  }
}
