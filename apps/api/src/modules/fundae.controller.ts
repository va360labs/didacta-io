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
  createBlockSchema,
  updateActionSchema,
  updateBlockSchema,
  type CreateActionDto,
  type CreateBlockDto,
  type UpdateActionDto,
  type UpdateBlockDto,
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

  @Get('actions/:id/participants/count')
  @ApiOperation({
    summary:
      'Cuenta los participantes (matriculaciones activas) del curso vinculado a una acción Fundae.',
  })
  async countParticipants(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    const total = await this.registry.getFundaeService().countParticipants(u.tenantId, id);
    return { total };
  }

  @Get('actions/:id/participants')
  @ApiOperation({
    summary:
      'Lista detallada de participantes con email, DNI, progreso y resultado. Usado por el admin para generar evidencias PDF.',
  })
  async listParticipants(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().listParticipants(u.tenantId, id);
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

  // ------------------- bloques / módulos formativos -------------------

  @Get('actions/:id/blocks')
  @ApiOperation({ summary: 'Listar módulos formativos (bloques) de una acción Fundae.' })
  async listBlocks(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().listBlocks(u.tenantId, id);
  }

  @Post('actions/:id/blocks')
  @ApiOperation({
    summary:
      'Crear un módulo formativo en una acción. Si no se provee `ordinal`, se asigna el siguiente.',
  })
  async createBlock(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createBlockSchema)) dto: CreateBlockDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().createBlock(u.tenantId, u.sub, id, dto);
  }

  @Put('actions/:id/blocks/:blockId')
  @ApiOperation({ summary: 'Actualizar un módulo formativo.' })
  async updateBlock(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('blockId') blockId: string,
    @Body(new ZodValidationPipe(updateBlockSchema)) dto: UpdateBlockDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeService().updateBlock(u.tenantId, u.sub, id, blockId, dto);
  }

  @Delete('actions/:id/blocks/:blockId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eliminar un módulo formativo de una acción.' })
  async deleteBlock(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('blockId') blockId: string,
  ) {
    const u = this.requireAdmin(user);
    await this.registry.getFundaeService().deleteBlock(u.tenantId, u.sub, id, blockId);
    return { deleted: true };
  }

  // ------------------- evidencias + ZIP de presentación -------------------

  @Get('actions/:id/participants/:userId/evidence.pdf')
  @ApiOperation({
    summary:
      'PDF de evidencia firmada para un participante. El firmante es el admin que solicita la descarga; el service resuelve nombre desde User.',
  })
  async exportEvidencePdf(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Res({ passthrough: false }) reply: FastifyReply,
  ) {
    const u = this.requireAdmin(user);
    const signer = await this.resolveSigner(u);
    const pdf = await this.registry
      .getFundaeService()
      .generateEvidencePdf(u.tenantId, id, userId, signer);
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="evidencia-${id}-${userId}.pdf"`)
      .send(pdf);
  }

  @Get('actions/:id/export.zip')
  @ApiOperation({
    summary:
      'ZIP de presentación Fundae: contiene el XML de la acción y un PDF de evidencia firmada por participante (si la acción tiene curso vinculado).',
  })
  async exportPresentationZip(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res({ passthrough: false }) reply: FastifyReply,
  ) {
    const u = this.requireAdmin(user);
    const signer = await this.resolveSigner(u);
    const zip = await this.registry
      .getFundaeService()
      .generatePresentationZip(u.tenantId, u.sub, id, signer);
    void reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="fundae-${id}.zip"`)
      .send(zip);
  }

  /**
   * Resuelve el firmante (nombre + cargo) consultando el User del admin
   * que dispara la descarga. Si el usuario no tiene `name`, cae a su email.
   * El cargo se infiere del primer rol administrativo presente.
   */
  private async resolveSigner(
    user: SessionClaims,
  ): Promise<{ name: string; title: string | null }> {
    const dbUser = await this.registry
      .getFundaeService()
      .resolveSignerProfile(user.tenantId, user.sub);
    const title = user.roles.includes('super_admin')
      ? 'Super administrador'
      : user.roles.includes('tenant_admin')
        ? 'Administrador'
        : null;
    return {
      name: dbUser?.name ?? dbUser?.email ?? 'Responsable de formación',
      title,
    };
  }
}
