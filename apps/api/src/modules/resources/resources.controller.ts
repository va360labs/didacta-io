/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

/** Roles que gestionan colecciones y moderan. Compartir recursos es de todos. */
const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

const searchSchema = z.object({ q: z.string().trim().max(120).optional() });

const createCollectionSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(1000).optional(),
  coverUrl: z.string().trim().max(2000).optional(),
});

const updateCollectionSchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  coverUrl: z.string().trim().max(2000).nullable().optional(),
});

const createResourceSchema = z.object({
  collectionId: z.string().uuid(),
  kind: z.enum(['FILE', 'LINK']),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(1000).optional(),
  url: z.string().trim().min(1).max(2000),
  fileName: z.string().trim().max(255).optional(),
  // zoomSessionId NO se acepta del cliente todavía: lo pondrá el trigger
  // post-clase (v2) tras verificar que la sesión pertenece al tenant.
});

const uuidSchema = z.string().uuid();

/**
 * Un id malformado en la ruta produciría un P2023 de Prisma (columna Uuid) que
 * el filtro de dominio no captura → 500. Mismo criterio que zoom-live: un id
 * que no es UUID es, simplemente, un recurso que no existe.
 */
function ensureUuid(id: string): string {
  if (!uuidSchema.safeParse(id).success) {
    throw new NotFoundException('No encontrado.');
  }
  return id;
}

/// Backend HTTP de `mod.resources` (bloque 4 — biblioteca por colecciones).
/// Cualquier miembro consulta, descarga y COMPARTE recursos; el staff crea y
/// edita las colecciones. El autor puede borrar lo suyo; el staff, todo.
@ApiTags('Recursos')
@Controller('modules/resources')
export class ResourcesController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('collections')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Colecciones del tenant con nº de recursos (siembra las 6 default).' })
  async listCollections(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    const collections = await this.registry.getResourcesService().listCollections(u.tenantId);
    return { collections };
  }

  @Post('collections')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea una colección con portada opcional (staff).' })
  async createCollection(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createCollectionSchema))
    dto: z.infer<typeof createCollectionSchema>,
  ) {
    const u = this.requireStaff(user);
    return this.registry.getResourcesService().createCollection({
      tenantId: u.tenantId,
      createdById: u.sub,
      ...dto,
    });
  }

  @Get('collections/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Colección + recursos, con buscador opcional dentro de ella.' })
  async getCollection(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(searchSchema)) query: z.infer<typeof searchSchema>,
  ) {
    const u = this.requireUser(user);
    return this.registry.getResourcesService().getCollection(u.tenantId, ensureUuid(id), query);
  }

  @Put('collections/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edita título, descripción o portada de una colección (staff).' })
  async updateCollection(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCollectionSchema))
    dto: z.infer<typeof updateCollectionSchema>,
  ) {
    const u = this.requireStaff(user);
    return this.registry.getResourcesService().updateCollection(u.tenantId, ensureUuid(id), dto);
  }

  @Delete('collections/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Elimina una colección vacía (staff).' })
  async deleteCollection(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireStaff(user);
    await this.registry.getResourcesService().deleteCollection(u.tenantId, ensureUuid(id));
    return { ok: true };
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Comparte un recurso en una colección (cualquier miembro).' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createResourceSchema))
    dto: z.infer<typeof createResourceSchema>,
  ) {
    const u = this.requireUser(user);
    return this.registry.getResourcesService().create({
      tenantId: u.tenantId,
      createdById: u.sub,
      ...dto,
    });
  }

  @Post(':id/download')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Registra la descarga/apertura y devuelve la URL del recurso.' })
  async download(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireUser(user);
    return this.registry.getResourcesService().registerDownload(u.tenantId, ensureUuid(id));
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Elimina un recurso (el autor lo suyo; el staff, cualquiera).' })
  async remove(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireUser(user);
    await this.registry.getResourcesService().remove(u.tenantId, ensureUuid(id), {
      id: u.sub,
      isStaff: u.roles.some((r) => STAFF_ROLES.has(r)),
    });
    return { ok: true };
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireStaff(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles.some((r) => STAFF_ROLES.has(r))) {
      throw new ForbiddenException('Sólo admin o formador pueden gestionar colecciones.');
    }
    return u;
  }
}
