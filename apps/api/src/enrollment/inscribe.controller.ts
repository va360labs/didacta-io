import { Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
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
import { inscribeSchema, revokeSchema, type InscribeDto, type RevokeDto } from './inscribe.dto';
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

  @Post('revoke')
  @ApiOperation({
    summary: 'Dar de baja a un comprador de uno o varios cursos (reembolso / cancelación)',
    description:
      'Cancela la matrícula que creó `POST /inscribe` para ese email. Idempotente y tolerante: ' +
      'si el email no existe devuelve `userFound: false` (no 404) y los cursos sin matrícula viva ' +
      'se reportan como `NOT_ENROLLED`. SOLO afecta a matrículas de origen API: el acceso por ' +
      'grupo, suscripción o compra directa NO se revoca. Requiere scope `enrollments:write`.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'courseIds'],
      properties: {
        email: { type: 'string', format: 'email', example: 'ana@ejemplo.com' },
        courseIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        externalRef: { type: 'string', example: 'wc_refund_998' },
        reason: { type: 'string', example: 'refund' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Baja procesada (idempotente).',
    schema: {
      type: 'object',
      properties: {
        userFound: { type: 'boolean' },
        userId: { type: 'string', format: 'uuid', nullable: true },
        revoked: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              courseId: { type: 'string', format: 'uuid' },
              status: { type: 'string', enum: ['REVOKED', 'NOT_ENROLLED'] },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `enrollments:write`.' })
  async revoke(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(revokeSchema)) dto: RevokeDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.service.revoke(user.tenantId, user.sub, dto, extractClientContext(req));
  }

  @Get('courses')
  @RequireApiScopes('courses:read')
  @ApiOperation({
    summary: 'Listar los cursos del tenant (con su estado) para mapear producto → curso',
    description:
      'Devuelve todos los cursos no borrados con su `status` (DRAFT / PUBLISHED / ARCHIVED). ' +
      'Solo los `PUBLISHED` admiten matrícula por `POST /inscribe`. Pensado para que el ' +
      'integrador (n8n, Zapier…) resuelva el UUID del curso sin copiarlo a mano. ' +
      'Requiere scope `courses:read`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Catálogo de cursos del tenant.',
    schema: {
      type: 'object',
      properties: {
        courses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              title: { type: 'string' },
              slug: { type: 'string' },
              status: { type: 'string', enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
              category: { type: 'string', nullable: true },
              publishedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `courses:read`.' })
  async listCourses(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const courses = await this.service.listCourses(user.tenantId);
    return { courses };
  }
}
