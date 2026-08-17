/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { JwtOrApiKeyGuard } from '../auth/api-key.guard';
import { ApiScopeGuard } from '../auth/api-scope.guard';
import { RequireApiScopes } from '../auth/api-scope.decorator';
import { CurrentUser } from '../auth/decorators';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import {
  learnerStateQuerySchema,
  listCoursesQuerySchema,
  type LearnerStateQuery,
  type ListCoursesQuery,
} from './integrations.dto';
import { IntegrationsService } from './integrations.service';

/**
 * API de LECTURA para sitios externos (`/api/v1/integrations`).
 *
 * El caso de uso que la motiva: un WordPress que quiere dejar de pintar sus
 * fichas de curso con LearnDash y pintarlas con los datos de Didacta —temario,
 * duración, precios— y enseñar a quien ya es alumno por dónde iba.
 *
 * Se autentica con API key del tenant (`Authorization: ApiKey lmsk_…`), igual
 * que `/inscribe`. Es deliberadamente server-to-server: la API no habilita
 * CORS, así que estas llamadas se hacen desde el backend del integrador, que
 * es también donde la API key está a salvo del navegador.
 *
 * Nunca devuelve el contenido de una lección. El temario se enseña para
 * vender; la clase se da en Didacta.
 */
@ApiTags('Integraciones (API externa)')
@ApiSecurity('ApiKey')
@Controller('integrations')
@UseGuards(JwtOrApiKeyGuard, ApiScopeGuard)
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get('courses')
  @RequireApiScopes('courses:read')
  @ApiOperation({
    summary: 'Listar cursos (con alumnos matriculados) para mapearlos con el sitio externo',
    description:
      'Devuelve los cursos no borrados con lo justo para elegir uno y guardar su UUID. ' +
      'Filtra por `slug`, por `status`, o por `externalId` + `externalSource` — esto último ' +
      'resuelve el mapeo solo cuando los cursos se importaron de otro LMS (ej. ' +
      '`externalSource=learndash`, `externalId` = el ID del post de WordPress). ' +
      'Cada curso trae sus `totals` de matrículas (`enrollments` histórico, ' +
      '`enrollmentsActive` con acceso hoy) y la respuesta añade `tenantTotals` con los ' +
      'alumnos DISTINTOS de todo el tenant — que no es la suma de los cursos, porque quien ' +
      'compró tres cuenta una vez, y que NO se ve afectado por los filtros. ' +
      'Requiere scope `courses:read`.',
  })
  @ApiQuery({ name: 'slug', required: false, example: 'curso-de-claude-code' })
  @ApiQuery({ name: 'externalId', required: false, example: '1234' })
  @ApiQuery({ name: 'externalSource', required: false, example: 'learndash' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] })
  @ApiResponse({ status: 200, description: 'Cursos que cumplen el filtro.' })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `courses:read`.' })
  async listCourses(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listCoursesQuerySchema)) query: ListCoursesQuery,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.service.listCourses(user.tenantId, query);
  }

  @Get('courses/:courseId')
  @RequireApiScopes('courses:read')
  @ApiOperation({
    summary: 'Ficha completa de un curso: metadatos, temario, alumnos y oferta',
    description:
      'Todo lo necesario para pintar una página de venta fuera de Didacta: descripción, ' +
      'imagen, vídeo destacado, formador, si emite certificado, totales (módulos, clases, ' +
      'minutos y matriculados), el temario completo módulo a módulo y —si el curso tiene ' +
      'precio en mod.billing— sus opciones de compra. ' +
      'El parámetro acepta el **UUID o el slug** del curso. ' +
      'Ojo con `totals.minutes`: es la suma de las duraciones declaradas clase a clase, así ' +
      'que un 0 significa "sin cargar", no "dura cero" — no publiques ese dato tal cual. ' +
      'NO devuelve el `content` de las lecciones bajo ninguna circunstancia. ' +
      'Requiere scope `courses:read`.',
  })
  @ApiResponse({ status: 200, description: 'Ficha del curso.' })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `courses:read`.' })
  @ApiResponse({ status: 404, description: 'El curso no existe en este tenant.' })
  async getCourse(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('courseId') courseId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.service.getCourseDetail(user.tenantId, courseId);
  }

  @Get('learners/state')
  @RequireApiScopes('enrollments:read')
  @ApiOperation({
    summary: 'Estado de un alumno por email: matrículas, progreso y por dónde continuar',
    description:
      'Responde a la pregunta que se hace una ficha de curso externa: ¿quien está viendo ' +
      'esto ya lo compró? Devuelve `known: false` si el email no corresponde a ningún ' +
      'usuario del tenant —entonces la ficha se pinta en modo venta—, y si existe, sus ' +
      'matrículas. Con `courseId` añade el detalle de ese curso: porcentaje, lecciones ' +
      'completadas y `nextLesson` con la URL directa a la clase. ' +
      'Ojo con `hasAccess: false` y `status: "PAUSED"`: es un alumno suspendido (típicamente ' +
      'por impago), no alguien que nunca compró. ' +
      'Requiere scope `enrollments:read`, separado de los demás precisamente porque permite ' +
      'preguntar por cualquier email del tenant.',
  })
  @ApiQuery({ name: 'email', required: true, example: 'ana@ejemplo.com' })
  @ApiQuery({ name: 'courseId', required: false, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Estado del alumno (o `known: false`).' })
  @ApiResponse({ status: 400, description: 'Email ausente o malformado.' })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({ status: 403, description: 'La API key no tiene el scope `enrollments:read`.' })
  async learnerState(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(learnerStateQuerySchema)) query: LearnerStateQuery,
  ) {
    if (!user) throw new UnauthorizedException();
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(user.tenantId, req);
    return this.service.getLearnerState(user.tenantId, query.email, query.courseId, webBaseUrl);
  }
}
