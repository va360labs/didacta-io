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
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  actionStatusSchema,
  createActionSchema,
  updateActionSchema,
  type CreateActionDto,
  type UpdateActionDto,
} from '@didacta/mod-fundae';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const listQuerySchema = z.object({
  courseId: z.string().uuid().optional(),
  status: actionStatusSchema.optional(),
});

@ApiTags('Modules · Fundae')
@ApiBearerAuth()
@Controller('modules/fundae')
@UseGuards(JwtAuthGuard)
export class FundaeController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo super_admin y tenant_admin pueden gestionar Fundae.');
    }
    return user;
  }

  @Get('actions')
  @ApiOperation({ summary: 'Listar acciones formativas del tenant.' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().list(u.tenantId, q);
  }

  @Get('actions/:id')
  @ApiOperation({ summary: 'Detalle de una acción formativa.' })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().get(u.tenantId, id);
  }

  @Post('actions')
  @ApiOperation({ summary: 'Crear acción formativa Fundae.' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createActionSchema)) dto: CreateActionDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().create(u.tenantId, u.sub, dto);
  }

  @Put('actions/:id')
  @ApiOperation({ summary: 'Actualizar acción formativa.' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateActionSchema)) dto: UpdateActionDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().update(u.tenantId, u.sub, id, dto);
  }

  @Delete('actions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archivar acción formativa (soft).' })
  async archive(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.registry.getFundaeService().archive(u.tenantId, u.sub, id);
    return { archived: true };
  }

  @Get('actions/:id/export.xml')
  @ApiOperation({
    summary:
      'Genera el XML Fundae para una acción formativa. Devuelve `application/xml` para descarga directa.',
  })
  async exportXml(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res({ passthrough: false }) reply: FastifyReply,
  ) {
    const u = this.requireAdmin(user);
    const xml = await this.registry.getFundaeService().generateXml(u.tenantId, u.sub, id);
    void reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="fundae-${id}.xml"`)
      .send(xml);
  }
}
