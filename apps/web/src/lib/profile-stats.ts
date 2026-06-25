'use client';

import { certificatesApi } from '@/modules/certificates';
import { authStorage } from './auth-storage';
import { leaderboardApi } from './leaderboard';
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
  const userId = authStorage.getSession()?.user.id ?? null;
  const [learning, certs, board] = await Promise.allSettled([
    learningApi.getMyStats(),
    certificatesApi.listMine(),
    leaderboardApi.get('all'),
  ]);

  const completedCourses = learning.status === 'fulfilled' ? learning.value.completedCourses : null;
  const trainingHours =
    learning.status === 'fulfilled' ? Math.round(learning.value.trainingSeconds / 3600) : null;
  const certificates =
    certs.status === 'fulfilled' ? certs.value.filter((c) => c.revokedAt === null).length : null;

  let rankingTopPercent: number | null = null;
  if (board.status === 'fulfilled' && userId && board.value.length > 0) {
    const me = board.value.find((e) => e.userId === userId);
    // Solo hay percentil si el usuario aparece en el ranking (tiene puntos).
    if (me) rankingTopPercent = Math.max(1, Math.ceil((me.rank / board.value.length) * 100));
  }

  return { completedCourses, trainingHours, certificates, rankingTopPercent };
}
