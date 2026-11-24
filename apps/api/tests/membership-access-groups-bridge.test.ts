/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { MembershipAccessGroupsBridge } from '../src/modules/subscriptions/membership-access-groups.bridge';

/**
 * Puente membresía → grupos de acceso con NIVELES:
 *  - el grupo sale del plan que la suscripción paga HOY (no del evento);
 *  - al cambiar de nivel se concede el nuevo ANTES de retirar el viejo (los
 *    cursos comunes no se pierden), y solo lo que concedió la membresía;
 *  - al terminar una membresía de pago con nivel gratis, la persona pasa a él.
 */

const T = 'tenant-1';
type Handler = (event: {
  data: Record<string, unknown>;
  metadata: { tenantId: string };
}) => Promise<void>;

function build(opts: {
  subPlan: string | null;
  subStatus?: string;
  groupByPlan: Record<string, string | null>;
  freeTier?: { active: boolean; accessGroupId: string | null } | null;
  stillPaying?: boolean;
}) {
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const bridge = new MembershipAccessGroupsBridge(
    {
      getMembershipTiersService: () => ({
        accessGroupForPlan: async (_t: string, planId: string | null) =>
          planId ? (opts.groupByPlan[planId] ?? null) : null,
        findFreeTier: async () => opts.freeTier ?? null,
      }),
    } as never,
    {
      getEventBus: () => ({
        subscribe: (name: string, fn: Handler) => handlers.set(name, fn),
      }),
    } as never,
    {
      assignMembers: async (_t: string, groupId: string, users: string[], source: string) => {
        calls.push(`assign:${groupId}:${users.join(',')}:${source}`);
        return { assigned: 1, added: 1 };
      },
      revokeMember: async (
        _t: string,
        groupId: string,
        userId: string,
        o: { onlySource?: string },
      ) => {
        calls.push(`revoke:${groupId}:${userId}:${o.onlySource}`);
        return { revoked: true };
      },
    } as never,
    {
      modSubscriptionsSubscription: {
        findFirst: async (args: { where: { id?: string; userId?: string } }) =>
          args.where.id
            ? opts.subPlan === undefined
              ? null
              : { planId: opts.subPlan, status: opts.subStatus ?? 'ACTIVE' }
            : opts.stillPaying
              ? { id: 'otra' }
              : null,
      },
    } as never,
    { log: () => undefined, warn: () => undefined, error: () => undefined } as never,
  );
  bridge.onModuleInit();
  const emit = (name: string, data: Record<string, unknown>) =>
    handlers.get(name)!({ data, metadata: { tenantId: T } });
  return { emit, calls };
}

describe('MembershipAccessGroupsBridge — niveles', () => {
  it('cambio de nivel: concede el grupo nuevo y DESPUÉS retira el viejo (solo MEMBERSHIP)', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro',
      groupByPlan: { plan_basico: 'g_basico', plan_pro: 'g_pro' },
    });
    await emit('subscriptions.membership.plan_changed', {
      subscriptionId: 's1',
      userId: 'u1',
      fromPlanId: 'plan_basico',
      toPlanId: 'plan_pro',
    });
    expect(calls).toEqual(['assign:g_pro:u1:MEMBERSHIP', 'revoke:g_basico:u1:MEMBERSHIP']);
  });

  it('otra periodicidad del MISMO nivel (mismo grupo): no se retira nada', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro_anual',
      groupByPlan: { plan_pro: 'g_pro', plan_pro_anual: 'g_pro' },
    });
    await emit('subscriptions.membership.plan_changed', {
      subscriptionId: 's1',
      userId: 'u1',
      fromPlanId: 'plan_pro',
      toPlanId: 'plan_pro_anual',
    });
    expect(calls).toEqual(['assign:g_pro:u1:MEMBERSHIP']);
  });

  it('un aviso que llega tarde actúa sobre el plan de HOY (no concede el que ya no paga)', async () => {
    // Pasó de Básico a Pro y luego volvió a Básico: el aviso del primer cambio
    // llega después del segundo.
    const { emit, calls } = build({
      subPlan: 'plan_basico',
      groupByPlan: { plan_basico: 'g_basico', plan_pro: 'g_pro' },
    });
    await emit('subscriptions.membership.plan_changed', {
      subscriptionId: 's1',
      userId: 'u1',
      fromPlanId: 'plan_basico',
      toPlanId: 'plan_pro',
    });
    expect(calls).toEqual(['assign:g_basico:u1:MEMBERSHIP']);
  });

  it('suscripción que ya no da acceso (impago): retira el viejo y no concede', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro',
      subStatus: 'UNPAID',
      groupByPlan: { plan_basico: 'g_basico', plan_pro: 'g_pro' },
    });
    await emit('subscriptions.membership.plan_changed', {
      subscriptionId: 's1',
      userId: 'u1',
      fromPlanId: 'plan_basico',
      toPlanId: 'plan_pro',
    });
    expect(calls).toEqual(['revoke:g_basico:u1:MEMBERSHIP']);
  });

  it('alta: el grupo del nivel del plan que paga hoy', async () => {
    const { emit, calls } = build({ subPlan: 'plan_pro', groupByPlan: { plan_pro: 'g_pro' } });
    await emit('subscriptions.membership.activated', {
      subscriptionId: 's1',
      userId: 'u1',
      planId: 'plan_pro',
    });
    expect(calls).toEqual(['assign:g_pro:u1:MEMBERSHIP']);
  });

  it('baja inmediata con nivel gratis encendido: retira el de pago y pasa al gratis', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro',
      groupByPlan: { plan_pro: 'g_pro' },
      freeTier: { active: true, accessGroupId: 'g_gratis' },
    });
    await emit('subscriptions.subscription.canceled', {
      subscriptionId: 's1',
      userId: 'u1',
      planId: 'plan_pro',
      immediate: true,
    });
    expect(calls).toEqual(['revoke:g_pro:u1:MEMBERSHIP', 'assign:g_gratis:u1:MANUAL']);
  });

  it('impago sin nivel gratis (o apagado): solo se retira el de pago', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro',
      groupByPlan: { plan_pro: 'g_pro' },
      freeTier: { active: false, accessGroupId: 'g_gratis' },
    });
    await emit('subscriptions.subscription.unpaid', {
      subscriptionId: 's1',
      userId: 'u1',
      planId: 'plan_pro',
    });
    expect(calls).toEqual(['revoke:g_pro:u1:MEMBERSHIP']);
  });

  it('si aún paga otra membresía, no se le pasa al gratis', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro',
      groupByPlan: { plan_pro: 'g_pro' },
      freeTier: { active: true, accessGroupId: 'g_gratis' },
      stillPaying: true,
    });
    await emit('subscriptions.subscription.unpaid', {
      subscriptionId: 's1',
      userId: 'u1',
      planId: 'plan_pro',
    });
    expect(calls).toEqual(['revoke:g_pro:u1:MEMBERSHIP']);
  });

  it('la pausa retira el grupo pero NO pasa al gratis (vuelve sola)', async () => {
    const { emit, calls } = build({
      subPlan: 'plan_pro',
      groupByPlan: { plan_pro: 'g_pro' },
      freeTier: { active: true, accessGroupId: 'g_gratis' },
    });
    await emit('subscriptions.subscription.paused', {
      subscriptionId: 's1',
      userId: 'u1',
      planId: 'plan_pro',
    });
    expect(calls).toEqual(['revoke:g_pro:u1:MEMBERSHIP']);
  });
});
