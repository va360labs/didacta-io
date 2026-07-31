/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  ForbiddenException,
  Get,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionClaims } from '../auth/token.service';

const FORMADOR_ROLES = new Set(['formador', 'tenant_admin', 'super_admin']);

interface FormadorStats {
  coursesPublished: number;
  coursesDraft: number;
  totalActiveEnrollments: number;
  totalCompletedEnrollments: number;
  averageProgressPercent: number;
  pendingGradings: number;
}

@ApiTags('Formador · Stats')
@ApiBearerAuth()
@Controller('formador/stats')
@UseGuards(JwtAuthGuard)
export class FormadorStatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary:
      'Estadísticas agregadas del tenant para el panel del formador / tenant_admin: cursos, matrículas, progreso, correcciones pendientes',
  })
  async getStats(@CurrentUser() user: SessionClaims | undefined): Promise<FormadorStats> {
    if (!user) throw new UnauthorizedException();
    const isFormador = user.roles.some((r) => FORMADOR_ROLES.has(r));
    if (!isFormador) {
      throw new ForbiddenException(
        'Solo formador / tenant_admin / super_admin puede ver estas stats',
      );
    }

    const tenantId = user.tenantId;

    const [
      coursesPublished,
      coursesDraft,
      activeEnrollments,
      completedEnrollments,
      progressAgg,
      pendingGradings,
    ] = await Promise.all([
      this.prisma.modCoursesCourse.count({
        where: { tenantId, status: 'PUBLISHED', deletedAt: null },
      }),
      this.prisma.modCoursesCourse.count({
        where: { tenantId, status: 'DRAFT', deletedAt: null },
      }),
      this.prisma.modLearningEnrollment.count({
        where: { tenantId, status: 'ACTIVE' },
      }),
      this.prisma.modLearningEnrollment.count({
        where: { tenantId, status: 'COMPLETED' },
      }),
      this.prisma.modLearningEnrollment.aggregate({
        where: { tenantId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        _avg: { progressPercent: true },
      }),
      this.prisma.modAssessmentsAttempt.count({
        where: { tenantId, status: 'PENDING_REVIEW' },
      }),
    ]);

    return {
      coursesPublished,
      coursesDraft,
      totalActiveEnrollments: activeEnrollments,
      totalCompletedEnrollments: completedEnrollments,
      averageProgressPercent: Math.round(progressAgg._avg.progressPercent ?? 0),
      pendingGradings,
    };
  }
}
