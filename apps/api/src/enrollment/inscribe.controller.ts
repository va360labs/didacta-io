/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ApiScopeGuard } from '../auth/api-scope.guard';
import { JwtOrApiKeyGuard } from '../auth/api-key.guard';
import { RequireApiScopes } from '../auth/api-scope.decorator';
import { CurrentUser } from '../auth/decorators';
import { extractClientContext } from '../auth/client-context';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
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
  constructor(
    private readonly service: InscribeService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

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
    description:
      'Hay que indicar al menos `courseIds` o `accessGroupIds`. El grupo de acceso es la vía ' +
      'recomendada para packs/membresías: otorga (y al dar de baja revoca) todos sus cursos.',
    schema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email', example: 'ana@ejemplo.com' },
        name: { type: 'string', example: 'Ana Pérez' },
        courseIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          example: ['3f4b2c10-1a2b-4c3d-9e8f-0a1b2c3d4e5f'],
        },
        accessGroupIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Grupo(s) de permisos que dan visibilidad a uno o varios cursos.',
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
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(user.tenantId, req);
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

  @Get('access-groups')
  @RequireApiScopes('courses:read')
  @ApiOperation({
    summary: 'Listar los grupos de acceso del tenant (para mapear pack/membresía → grupo)',
    description:
      'Devuelve los grupos de permisos con su `kind` y cuántos cursos otorgan. Se usan en ' +
      '`accessGroupIds` de /inscribe y /inscribe/revoke. Requiere scope `courses:read`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Grupos de acceso del tenant.',
    schema: {
      type: 'object',
      properties: {
        accessGroups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              kind: { type: 'string', enum: ['ALL_COURSES', 'COURSE', 'MULTI_COURSE'] },
              courseCount: { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `courses:read`.' })
  async listAccessGroups(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const accessGroups = await this.service.listAccessGroups(user.tenantId);
    return { accessGroups };
  }
}
