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
      // 'Personas y accesos' (área admin), NO 'Personas' (menú principal): son
      // árboles distintos y este item es solo para el admin. Apuntaba a
      // 'Administración', un grupo que solo existe para super_admin → el merge
      // lo descartaba en silencio y el panel era invisible para los
      // tenant_admin, que son justo su destinatario.
      group: 'Personas y accesos',
      href: '/admin/gamificacion',
      label: 'Puntos y retos',
      icon: 'trophy',
      requiresRole: 'tenant_admin',
    },
  ],
};

// Convención: los consumidores importan SIEMPRE desde '@/modules/gamification'.
export { RequestPerkModal, SubmitChallengeModal } from './challenge-modals';
export {
  gamificationApi,
  gamificationAdminApi,
  type BackfillSummary,
  type ChallengeStatus,
  type ChallengeView,
  type LeaderboardEntry,
  type LeaderboardRange,
  type LedgerEntry,
  type LevelView,
  type MyPerkView,
  type PerkRequestStatus,
  type PerkRequestView,
  type PerkView,
  type RuleView,
  type Standing,
  type SubmissionStatus,
  type SubmissionView,
} from './client';
