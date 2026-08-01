/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Semántica del ORIGEN de una membresía de grupo (`source` en
 * `mod_access_groups_group_member`). Es el contrato que comparten el alta
 * manual del admin y los bridges automáticos (tiers y membresía):
 *
 *   - MANUAL: alta del admin (o aprobación de inscripción). Es "sticky": los
 *     bridges nunca la degradan ni la retiran — lo que un admin concedió a
 *     mano solo lo quita un admin.
 *   - TIER: reconciliada por el vínculo tier→grupo (mod.payment-connections).
 *   - MEMBERSHIP: concedida por la membresía de pago (mod.subscriptions).
 *
 * Cada bridge automático solo crea/retira membresías de SU source. Así un
 * tier-down no retira lo que concedió la membresía, un impago de membresía no
 * retira lo que concedió un tier, y ninguno de los dos toca lo MANUAL.
 */

export const ACCESS_GROUP_MEMBER_SOURCES = ['MANUAL', 'TIER', 'MEMBERSHIP'] as const;
export type AccessGroupMemberSource = (typeof ACCESS_GROUP_MEMBER_SOURCES)[number];

/** Sources de bridge (automáticos): todos menos MANUAL. */
export type AccessGroupBridgeSource = Exclude<AccessGroupMemberSource, 'MANUAL'>;

/** Lo que el planificador necesita saber de la membresía existente (o null). */
export interface ExistingMembership {
  /** 'ACTIVE' | 'REVOKED' (columna status, VarChar en BD). */
  status: string;
  /** Source actual tal cual está en BD. */
  source: string;
}

export type MemberActivationPlan =
  /** No existe fila: crear con el source solicitado. */
  | { action: 'create'; source: AccessGroupMemberSource }
  /** Fila revocada: reactivar. MANUAL es sticky — se conserva aunque reactive un bridge. */
  | { action: 'reactivate'; source: AccessGroupMemberSource }
  /** Activa no-MANUAL + alta manual del admin: promocionar a MANUAL. */
  | { action: 'promote'; source: 'MANUAL' }
  /** Ya activa y nada que cambiar. */
  | { action: 'none' };

/**
 * Decide qué hacer al (re)activar la membresía de un usuario en un grupo.
 *
 * Reglas (las mismas que aplicaba el host para MANUAL/TIER, generalizadas):
 *  - Sin fila previa → crear con el source del que concede.
 *  - Revocada → reactivar; si era MANUAL se queda MANUAL (sticky), si no,
 *    pasa a ser del que la reactiva (el nuevo concedente es su dueño).
 *  - Activa y el admin la asserta a mano → promocionar a MANUAL (un tier-down
 *    o un impago posteriores ya no la retiran).
 *  - Activa y la asserta un bridge → no tocar: el source existente conserva la
 *    propiedad (un bridge nunca "roba" la membresía de otro ni la del admin).
 */
export function planMemberActivation(
  existing: ExistingMembership | null | undefined,
  requested: AccessGroupMemberSource,
): MemberActivationPlan {
  if (!existing) return { action: 'create', source: requested };
  if (existing.status !== 'ACTIVE') {
    return {
      action: 'reactivate',
      source: existing.source === 'MANUAL' ? 'MANUAL' : requested,
    };
  }
  if (requested === 'MANUAL' && existing.source !== 'MANUAL') {
    return { action: 'promote', source: 'MANUAL' };
  }
  return { action: 'none' };
}

/**
 * ¿Puede un bridge automático revocar esta membresía? Solo si es SUYA.
 * Lo MANUAL (y lo del otro bridge) queda intacto — quien pierde el tier no
 * pierde lo que le dio la membresía, y viceversa.
 */
export function bridgeMayRevoke(memberSource: string, bridge: AccessGroupBridgeSource): boolean {
  return memberSource === bridge;
}
