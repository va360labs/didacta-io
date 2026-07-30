import type { ModuleWebExtension } from '@/lib/module-registry';

/**
 * mod.gamification — puntos, niveles y retos (bloque 1).
 *
 * Las dos entradas cuelgan del grupo 'Personas', donde ya vivía el ranking. Al
 * declararlas aquí y no en `buildGroups()`, desaparecen solas si el tenant
 * desactiva el módulo — algo que el /leaderboard anterior no hacía: era un item
 * fijo del menú que se quedaba vacío.
 */
export const gamificationExtension: ModuleWebExtension = {
  name: 'mod.gamification',
  sidebarItems: [
    {
      group: 'Personas',
      href: '/leaderboard',
      label: 'Clasificación',
      icon: 'trophy',
    },
    {
      group: 'Personas',
      href: '/retos',
      label: 'Retos',
      icon: 'target',
    },
    {
      group: 'Administración',
      href: '/admin/gamificacion',
      label: 'Puntos y retos',
      icon: 'trophy',
      requiresRole: 'tenant_admin',
    },
  ],
};

// Convención: los consumidores importan SIEMPRE desde '@/modules/gamification'.
export { SubmitChallengeModal } from './challenge-modals';
export {
  gamificationApi,
  gamificationAdminApi,
  type BackfillSummary,
  type BenefitKind,
  type ChallengeStatus,
  type ChallengeView,
  type LeaderboardEntry,
  type LeaderboardRange,
  type LedgerEntry,
  type LevelView,
  type RuleView,
  type Standing,
  type SubmissionStatus,
  type SubmissionView,
} from './client';
