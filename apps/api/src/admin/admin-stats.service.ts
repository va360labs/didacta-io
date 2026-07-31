/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type StatsRange = 'all' | '7d' | '30d';

export interface AdminStats {
  range: StatsRange;
  /** Usuarios con status=ACTIVE en el tenant. */
  activeUsers: number;
  /** Cursos en estado PUBLISHED y no eliminados. */
  coursesPublished: number;
  /** Matriculaciones (ACTIVE+COMPLETED) creadas en la ventana. */
  totalEnrollments: number;
  /** Certificados emitidos no revocados en la ventana. */
  certificatesIssued: number;
  /**
   * Tasa de finalización = completed / total enrollments del rango (0..100).
   * 0 si no hay enrollments en el rango (evita división por cero).
   */
  completionRate: number;
}

/**
 * HU-TA-003 — métricas básicas para el dashboard del tenant_admin.
 *
 * El rango temporal aplica solo a métricas con sentido temporal
 * (matriculaciones nuevas, certificados emitidos). Usuarios activos y
 * cursos publicados son snapshots actuales, no histórico.
 */
@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats(tenantId: string, range: StatsRange = 'all'): Promise<AdminStats> {
    const since = computeSince(range);
    const dateFilter = since ? { gte: since } : undefined;

    const [activeUsers, coursesPublished, total, completed, certificatesIssued] = await Promise.all(
      [
        this.prisma.user.count({
          where: { tenantId, status: 'ACTIVE', deletedAt: null },
        }),
        this.prisma.modCoursesCourse.count({
          where: { tenantId, status: 'PUBLISHED', deletedAt: null },
        }),
        this.prisma.modLearningEnrollment.count({
          where: {
            tenantId,
            status: { in: ['ACTIVE', 'COMPLETED'] },
            // Bug previo: usaba `createdAt` que no existe en el modelo. La
            // columna real es `enrolled_at` mapeada como `enrolledAt`. Esto
            // hacía 500 en cualquier rango distinto de 'all'.
            ...(dateFilter ? { enrolledAt: dateFilter } : {}),
          },
        }),
        this.prisma.modLearningEnrollment.count({
          where: {
            tenantId,
            status: 'COMPLETED',
            ...(dateFilter ? { enrolledAt: dateFilter } : {}),
          },
        }),
        this.prisma.modCertificatesIssued.count({
          where: {
            tenantId,
            revokedAt: null,
            ...(dateFilter ? { issuedAt: dateFilter } : {}),
          },
        }),
      ],
    );

    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      range,
      activeUsers,
      coursesPublished,
      totalEnrollments: total,
      certificatesIssued,
      completionRate,
    };
  }
}

function computeSince(range: StatsRange): Date | null {
  if (range === 'all') return null;
  const now = Date.now();
  const days = range === '7d' ? 7 : 30;
  return new Date(now - days * 24 * 60 * 60 * 1000);
}
