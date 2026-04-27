import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertificatesError } from '@didacta/mod-certificates';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { ModuleRegistryService } from './module-registry.service';

const TEMPLATE_EDITOR_ROLES = ['super_admin', 'tenant_admin', 'formador'] as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const createTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
  primaryColor: z.string().regex(HEX_RE).optional(),
  logoUrl: z.string().url().nullable().optional(),
  signerName: z.string().max(200).nullable().optional(),
  signerTitle: z.string().max(200).nullable().optional(),
  isDefault: z.boolean().optional(),
});

const updateTemplateSchema = createTemplateSchema.partial();

type CreateTemplateDto = z.infer<typeof createTemplateSchema>;
type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;

function requireTemplateEditor(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const allowed = user.roles.some((r) => (TEMPLATE_EDITOR_ROLES as readonly string[]).includes(r));
  if (!allowed) {
    throw new ForbiddenException('Esta acción requiere rol formador, tenant_admin o super_admin.');
  }
  return user;
}

@ApiTags('Modules · Certificates')
@ApiBearerAuth()
@Controller('modules/certificates')
@UseGuards(JwtAuthGuard)
export class CertificatesController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('me')
  @ApiOperation({ summary: 'Listar mis certificados emitidos' })
  async listMine(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCertificatesService().listMyCertificates(user.tenantId, user.sub);
  }

  // ----------------------------------------------------------------------
  // HU-FOR-004 — CRUD de plantillas (formador / tenant_admin / super_admin).
  // ----------------------------------------------------------------------

  @Get('templates')
  @ApiOperation({ summary: 'Listar plantillas de certificado del tenant.' })
  async listTemplates(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTemplateEditor(user);
    return this.registry.getCertificatesService().listTemplates(u.tenantId);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Detalle de una plantilla de certificado.' })
  async getTemplate(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireTemplateEditor(user);
    return this.registry.getCertificatesService().getTemplate(u.tenantId, id);
  }

  @Post('templates')
  @ApiOperation({ summary: 'Crear nueva plantilla. Si isDefault=true desmarca otras.' })
  async createTemplate(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createTemplateSchema)) dto: CreateTemplateDto,
  ) {
    const u = requireTemplateEditor(user);
    return this.registry.getCertificatesService().createTemplate(u.tenantId, dto);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Actualizar plantilla. Solo los campos presentes se modifican.' })
  async updateTemplate(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) dto: UpdateTemplateDto,
  ) {
    const u = requireTemplateEditor(user);
    return this.registry.getCertificatesService().updateTemplate(u.tenantId, id, dto);
  }

  @Post('templates/:id/set-default')
  @ApiOperation({ summary: 'Marcar plantilla como default del tenant (desmarca la previa).' })
  async setDefaultTemplate(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    const u = requireTemplateEditor(user);
    return this.registry.getCertificatesService().setDefaultTemplate(u.tenantId, id);
  }

  @Delete('templates/:id')
  @ApiOperation({
    summary: 'Eliminar plantilla. Falla si es default o si está asignada a algún curso.',
  })
  async deleteTemplate(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireTemplateEditor(user);
    await this.registry.getCertificatesService().deleteTemplate(u.tenantId, id);
    return { ok: true };
  }

  // ----------------------------------------------------------------------
  // Certificados emitidos.
  // ----------------------------------------------------------------------

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un certificado emitido' })
  async getById(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    return this.registry.getCertificatesService().getById(user.tenantId, id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Descargar PDF del certificado' })
  async download(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    if (!user) throw new UnauthorizedException();
    const cert = await this.registry.getCertificatesService().getById(user.tenantId, id);
    const pdf = await this.registry
      .getCertificatesService()
      .renderCertificatePdf(user.tenantId, id);

    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${cert.number}.pdf"`)
      .header('Content-Length', String(pdf.length))
      .send(pdf);
  }
}

export { CertificatesError };
