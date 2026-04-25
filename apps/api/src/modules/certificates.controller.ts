import { Controller, Get, Param, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertificatesError } from '@learnship/mod-certificates';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ModuleRegistryService } from './module-registry.service';

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
