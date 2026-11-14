/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { IconName } from '@/components/icon';
import type { TranslatorLike } from '@/lib/i18n/labels';
import type { BadgeKind } from './retention-client';

/**
 * Nombre de una insignia: el que le puso el creador o, si no la renombró, el
 * del catálogo en el idioma de quien la mira (`modGamification.retencion.badge`).
 * Un tipo que esta web aún no conoce se muestra con su clave, nunca vacío.
 */
export function badgeLabel(
  badge: { kind: BadgeKind | string; threshold: number; name: string | null; key?: string },
  t: TranslatorLike,
): string {
  if (badge.name) return badge.name;
  const known = ['first_post', 'first_comment', 'first_course', 'streak_days', 'level'];
  if (!known.includes(badge.kind)) return badge.key ?? badge.kind;
  return t(badge.kind, { count: badge.threshold });
}

/** Icono de cada tipo de insignia (decoración estable, no dato). */
export const BADGE_ICON: Record<string, IconName> = {
  first_post: 'edit',
  first_comment: 'message',
  first_course: 'award',
  streak_days: 'trending',
  level: 'trophy',
};
