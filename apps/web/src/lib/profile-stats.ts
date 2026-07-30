'use client';

import { certificatesApi } from '@/modules/certificates';
import { gamificationApi } from '@/modules/gamification';
import { learningApi } from './learning';

/**
 * Estadísticas reales del perfil ("Mi perfil"). Cada métrica es `null` si su
 * módulo/fuente no está disponible (módulo deshabilitado, 403/404, red) — la UI
 * muestra "—" en ese caso. CLAUDE.md §3: nunca inventamos un número.
 */
export interface ProfileStats {
  /** Cursos con matrícula COMPLETED. */
  completedCourses: number | null;
  /** Horas de formación = suma de visionado real redondeada. */
  trainingHours: number | null;
  /** Certificados emitidos no revocados. */
  certificates: number | null;
  /** "Top X%" del leaderboard de la comunidad (1 = lo más alto). */
  rankingTopPercent: number | null;
}

export async function loadProfileStats(): Promise<ProfileStats> {
  const [learning, certs, standing] = await Promise.allSettled([
    learningApi.getMyStats(),
    certificatesApi.listMine(),
    gamificationApi.myStanding('all'),
  ]);

  const completedCourses = learning.status === 'fulfilled' ? learning.value.completedCourses : null;
  const trainingHours =
    learning.status === 'fulfilled' ? Math.round(learning.value.trainingSeconds / 3600) : null;
  const certificates =
    certs.status === 'fulfilled' ? certs.value.filter((c) => c.revokedAt === null).length : null;

  // El percentil se calcula contra la población COMPLETA de clasificados, que
  // ahora devuelve el módulo. Antes se dividía entre el top 50 que llegaba en
  // la respuesta, así que en un tenant con más de 50 personas salía mal.
  let rankingTopPercent: number | null = null;
  if (standing.status === 'fulfilled') {
    const { rank, total } = standing.value;
    if (rank !== null && total > 0) {
      rankingTopPercent = Math.max(1, Math.ceil((rank / total) * 100));
    }
  }

  return { completedCourses, trainingHours, certificates, rankingTopPercent };
}
