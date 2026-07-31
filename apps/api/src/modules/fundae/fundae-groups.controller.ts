/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCostSchema,
  createGroupSchema,
  finalizeGroupSchema,
  groupStatusSchema,
  updateCostSchema,
  updateGroupSchema,
  type CreateCostDto,
  type CreateGroupDto,
  type FinalizeGroupDto,
  type GroupStatus,
  type UpdateCostDto,
  type UpdateGroupDto,
} from '@didacta/mod-fundae';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const listGroupsQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  actionId: z.string().uuid().optional(),
  status: groupStatusSchema.optional(),
});

/**
 * Endpoints REST del grupo bonificable Fundae (LMS-81).
 * Path base: `/api/v1/admin/fundae/groups`
 * Costes anidados: `/api/v1/admin/fundae/groups/:id/costs`
 */
@ApiTags('Admin · Fundae · Grupos')
@ApiBearerAuth()
@Controller('admin/fundae/groups')
@UseGuards(JwtAuthGuard)
export class FundaeGroupsController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException(
        'Solo super_admin y tenant_admin pueden gestionar grupos bonificables.',
      );
    }
    return user;
  }

  // ──────────────────── GRUPOS ────────────────────

  @Get()
  @ApiOperation({
    summary: 'Listar grupos bonificables. Filtra por companyId, actionId o status.',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listGroupsQuerySchema)) q: z.infer<typeof listGroupsQuerySchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().list(u.tenantId, {
      companyId: q.companyId,
      actionId: q.actionId,
      status: q.status as GroupStatus | undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un grupo bonificable con sus costes.' })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().get(u.tenantId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear grupo bonificable en DRAFT.' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createGroupSchema)) dto: CreateGroupDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().create(u.tenantId, u.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar metadatos del grupo (solo DRAFT o ACTIVE).' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateGroupSchema)) dto: UpdateGroupDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().update(u.tenantId, u.sub, id, dto);
  }

  @Post(':id/start')
  @ApiOperation({
    summary:
      'DRAFT → ACTIVE. Valida antelación RLPT (15 días) y crédito Fundae disponible de la empresa.',
  })
  async start(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().start(u.tenantId, u.sub, id);
  }

  @Post(':id/close')
  @ApiOperation({
    summary: 'ACTIVE → CLOSED. Debita el crédito consumido del grupo en el crédito de la empresa.',
  })
  async close(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().close(u.tenantId, u.sub, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'DRAFT/ACTIVE → CANCELLED.' })
  async cancel(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().cancel(u.tenantId, u.sub, id);
  }

  @Post(':id/finalize')
  @ApiOperation({
    summary:
      'Calcula APTO/NO_APTO/EN_CURSO por participante usando el umbral del grupo (default 75%). Modo `preview` no persiste.',
  })
  async finalize(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(finalizeGroupSchema)) dto: FinalizeGroupDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().computeCompletion(u.tenantId, u.sub, id, {
      umbralOverride: dto.umbralOverride,
      preview: dto.preview,
    });
  }

  @Get(':id/start-xml')
  @ApiOperation({
    summary:
      'XML de "Comunicación de inicio de grupo" Fundae (LMS-83). Incluye acción, grupo, empresa y participantes ENROLLED.',
  })
  async startXml(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const u = this.requireAdmin(user);
    // Header se aplica solo en la rama de éxito; si el service lanza,
    // el FundaeErrorFilter responde JSON sin colisionar con este content-type.
    const xml = await this.registry.getFundaeGroupService().generateStartXml(u.tenantId, id);
    void reply.header('Content-Type', 'application/xml; charset=utf-8').status(200).send(xml);
  }

  @Get(':id/end-xml')
  @ApiOperation({
    summary:
      'XML de "Comunicación de finalización de grupo" Fundae (LMS-85). Incluye listado nominal con APTO/NO_APTO y desglose de costes.',
  })
  async endXml(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const u = this.requireAdmin(user);
    const xml = await this.registry.getFundaeGroupService().generateEndXml(u.tenantId, id);
    void reply.header('Content-Type', 'application/xml; charset=utf-8').status(200).send(xml);
  }

  @Get(':id/audit-zip')
  @ApiOperation({
    summary:
      'Paquete de auditoría Fundae (LMS-86): ZIP con manifest.json + inicio.xml + finalizacion.xml + participantes.csv + costes.csv + adjuntos RLPT.',
  })
  async auditZip(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const u = this.requireAdmin(user);
    const buf = await this.registry.getFundaeGroupService().generateAuditZip(u.tenantId, id);
    void reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="fundae-grupo-${id}-auditoria.zip"`)
      .status(200)
      .send(buf);
  }

  // ──────────────────── COSTES ────────────────────

  @Get(':id/costs')
  @ApiOperation({ summary: 'Listar costes de un grupo.' })
  async listCosts(@CurrentUser() user: SessionClaims | undefined, @Param('id') groupId: string) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().listCosts(u.tenantId, groupId);
  }

  @Post(':id/costs')
  @ApiOperation({ summary: 'Añadir coste a un grupo (solo DRAFT o ACTIVE).' })
  async addCost(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') groupId: string,
    @Body(new ZodValidationPipe(createCostSchema)) dto: CreateCostDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeGroupService().addCost(u.tenantId, u.sub, groupId, dto);
  }

  @Patch(':id/costs/:costId')
  @ApiOperation({ summary: 'Actualizar un coste.' })
  async updateCost(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') groupId: string,
    @Param('costId') costId: string,
    @Body(new ZodValidationPipe(updateCostSchema)) dto: UpdateCostDto,
  ) {
    const u = this.requireAdmin(user);
    return this.registry
      .getFundaeGroupService()
      .updateCost(u.tenantId, u.sub, groupId, costId, dto);
  }

  @Delete(':id/costs/:costId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Eliminar un coste (solo si el grupo no está cerrado).' })
  async removeCost(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') groupId: string,
    @Param('costId') costId: string,
  ) {
    const u = this.requireAdmin(user);
    await this.registry.getFundaeGroupService().removeCost(u.tenantId, u.sub, groupId, costId);
    return { deleted: true };
  }
}
