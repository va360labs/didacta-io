import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ApiScopeGuard } from '../auth/api-scope.guard';
import { JwtOrApiKeyGuard } from '../auth/api-key.guard';
import { RequireApiScopes } from '../auth/api-scope.decorator';
import { CurrentUser } from '../auth/decorators';
import { extractClientContext } from '../auth/client-context';
import { resolveWebBaseUrl } from '../common/resolve-web-base-url';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { inscribeSchema, type InscribeDto } from './inscribe.dto';
import { InscribeService } from './inscribe.service';

/**
 * Endpoint público para integradores externos (páginas de venta de terceros).
 * Autenticado con API key del tenant: `Authorization: ApiKey lmsk_xxx` y scope
 * `enrollments:write`. Crea-o-reusa el usuario por email y lo matricula en los
 * cursos indicados (por UUID). Ver Swagger en /api/docs.
 */
@ApiTags('Inscripción (API externa)')
@ApiSecurity('ApiKey')
@Controller('inscribe')
@UseGuards(JwtOrApiKeyGuard, ApiScopeGuard)
@RequireApiScopes('enrollments:write')
export class InscribeController {
  constructor(private readonly service: InscribeService) {}

  @Post()
  @ApiOperation({
    summary: 'Inscribir a un comprador externo en uno o varios cursos',
    description:
      'Crea (si no existe) el usuario por email con una contraseña temporal que recibe por ' +
      'email y debe cambiar al primer login, y lo matricula en los `courseIds` indicados. ' +
      'Idempotente: repetir la misma inscripción no duplica la matrícula. Requiere una API ' +
      'key del tenant con scope `enrollments:write` en el header `Authorization: ApiKey lmsk_…`.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'courseIds'],
      properties: {
        email: { type: 'string', format: 'email', example: 'ana@ejemplo.com' },
        name: { type: 'string', example: 'Ana Pérez' },
        courseIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          example: ['3f4b2c10-1a2b-4c3d-9e8f-0a1b2c3d4e5f'],
        },
        locale: { type: 'string', example: 'es-ES' },
        externalRef: { type: 'string', example: 'order_12345' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Usuario resuelto/creado y matriculado.',
    schema: {
      type: 'object',
      properties: {
        userId: { type: 'string', format: 'uuid' },
        userCreated: { type: 'boolean' },
        enrollments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              courseId: { type: 'string', format: 'uuid' },
              enrollmentId: { type: 'string', format: 'uuid', nullable: true },
              status: { type: 'string', enum: ['ACTIVE', 'FAILED'] },
              alreadyEnrolled: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Payload inválido (email/courseIds).' })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `enrollments:write`.' })
  @ApiResponse({ status: 429, description: 'Límite de peticiones superado.' })
  async inscribe(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(inscribeSchema)) dto: InscribeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const webBaseUrl = resolveWebBaseUrl(req);
    return this.service.inscribe(
      user.tenantId,
      user.sub,
      dto,
      webBaseUrl,
      extractClientContext(req),
    );
  }
}
