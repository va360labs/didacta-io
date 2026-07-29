import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

/** Roles que publican/gestionan recursos. Cualquier miembro puede consultarlos. */
const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

const categorySchema = z.enum(['WORKFLOW', 'SKILL', 'TOOL', 'TEMPLATE', 'OTHER']);

const listSchema = z.object({
  category: categorySchema.optional(),
  q: z.string().trim().max(120).optional(),
});

const createSchema = z.object({
  category: categorySchema,
  kind: z.enum(['FILE', 'LINK']),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(1000).optional(),
  url: z.string().trim().min(1).max(2000),
  fileName: z.string().trim().max(255).optional(),
  zoomSessionId: z.string().uuid().optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  category: categorySchema.optional(),
});

/// Backend HTTP de `mod.resources` (bloque 4 — biblioteca de recursos).
@ApiTags('Recursos')
@Controller('modules/resources')
export class ResourcesController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Biblioteca de recursos del tenant, con filtro y buscador.' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    const u = this.requireUser(user);
    const resources = await this.registry.getResourcesService().list(u.tenantId, query);
    return { resources };
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Publica un recurso (staff: admin/formador).' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSchema)) dto: z.infer<typeof createSchema>,
  ) {
    const u = this.requireStaff(user);
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
    return this.registry.getResourcesService().registerDownload(u.tenantId, id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edita título, descripción o categoría (staff).' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSchema)) dto: z.infer<typeof updateSchema>,
  ) {
    const u = this.requireStaff(user);
    return this.registry.getResourcesService().update(u.tenantId, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Elimina un recurso (staff).' })
  async remove(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireStaff(user);
    await this.registry.getResourcesService().remove(u.tenantId, id, u.sub);
    return { ok: true };
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireStaff(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles.some((r) => STAFF_ROLES.has(r))) {
      throw new ForbiddenException('Sólo admin o formador pueden gestionar recursos.');
    }
    return u;
  }
}
