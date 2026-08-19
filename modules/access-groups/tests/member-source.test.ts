/**
 * Tests de la semántica portable del `source` de membresías de grupo:
 * MANUAL sticky, promoción por alta manual, propiedad por bridge.
 */

import { describe, expect, it } from 'vitest';
import { bridgeMayRevoke, planMemberActivation } from '../src/member-source.js';

describe('planMemberActivation', () => {
  it('sin fila previa crea con el source solicitado', () => {
    expect(planMemberActivation(null, 'MANUAL')).toEqual({ action: 'create', source: 'MANUAL' });
    expect(planMemberActivation(undefined, 'TIER')).toEqual({ action: 'create', source: 'TIER' });
    expect(planMemberActivation(null, 'MEMBERSHIP')).toEqual({
      action: 'create',
      source: 'MEMBERSHIP',
    });
  });

  it('reactivar una MANUAL revocada la entrega a quien la reactiva (M10)', () => {
    // Antes MANUAL era sticky también aquí, y ese "sticky" producía un acceso
    // IRREVOCABLE: membresía manual revocada → un pago la reactiva → sigue
    // marcada MANUAL → cuando el pago deja de entrar, `bridgeMayRevoke` dice
    // que no y nadie se la quita. Un acceso concedido por dinero sobrevivía al
    // impago. Y no había nada del admin que proteger: la membresía estaba
    // REVOCADA, o sea que su decisión ya se había deshecho.
    const revokedManual = { status: 'REVOKED', source: 'MANUAL' };
    expect(planMemberActivation(revokedManual, 'TIER')).toEqual({
      action: 'reactivate',
      source: 'TIER',
    });
    expect(planMemberActivation(revokedManual, 'MEMBERSHIP')).toEqual({
      action: 'reactivate',
      source: 'MEMBERSHIP',
    });
    // El bridge que la reactivó SÍ puede retirarla cuando deje de aplicar.
    expect(bridgeMayRevoke('TIER', 'TIER')).toBe(true);
  });

  it('sobre una membresía ACTIVA, MANUAL sigue siendo intocable para un bridge', () => {
    // La regla sticky no desaparece: donde tiene sentido es aquí, sobre una
    // membresía viva, para que un tier-down no borre la decisión del admin.
    expect(planMemberActivation({ status: 'ACTIVE', source: 'MANUAL' }, 'TIER')).toEqual({
      action: 'none',
    });
    expect(bridgeMayRevoke('MANUAL', 'TIER')).toBe(false);
  });

  it('reactivar una no-MANUAL revocada la entrega al nuevo concedente', () => {
    // Un miembro TIER revocado que entra ahora por membresía pasa a ser
    // propiedad del bridge de membresía (y viceversa).
    expect(planMemberActivation({ status: 'REVOKED', source: 'TIER' }, 'MEMBERSHIP')).toEqual({
      action: 'reactivate',
      source: 'MEMBERSHIP',
    });
    expect(planMemberActivation({ status: 'REVOKED', source: 'MEMBERSHIP' }, 'TIER')).toEqual({
      action: 'reactivate',
      source: 'TIER',
    });
    expect(planMemberActivation({ status: 'REVOKED', source: 'MEMBERSHIP' }, 'MANUAL')).toEqual({
      action: 'reactivate',
      source: 'MANUAL',
    });
  });

  it('un alta MANUAL sobre una activa no-MANUAL la promociona a MANUAL', () => {
    expect(planMemberActivation({ status: 'ACTIVE', source: 'TIER' }, 'MANUAL')).toEqual({
      action: 'promote',
      source: 'MANUAL',
    });
    expect(planMemberActivation({ status: 'ACTIVE', source: 'MEMBERSHIP' }, 'MANUAL')).toEqual({
      action: 'promote',
      source: 'MANUAL',
    });
  });

  it('un bridge sobre una activa NUNCA cambia el source (no roba propiedad)', () => {
    expect(planMemberActivation({ status: 'ACTIVE', source: 'MANUAL' }, 'MEMBERSHIP')).toEqual({
      action: 'none',
    });
    expect(planMemberActivation({ status: 'ACTIVE', source: 'MANUAL' }, 'TIER')).toEqual({
      action: 'none',
    });
    expect(planMemberActivation({ status: 'ACTIVE', source: 'TIER' }, 'MEMBERSHIP')).toEqual({
      action: 'none',
    });
    expect(planMemberActivation({ status: 'ACTIVE', source: 'MEMBERSHIP' }, 'TIER')).toEqual({
      action: 'none',
    });
  });

  it('alta MANUAL sobre una activa ya MANUAL es no-op', () => {
    expect(planMemberActivation({ status: 'ACTIVE', source: 'MANUAL' }, 'MANUAL')).toEqual({
      action: 'none',
    });
  });
});

describe('bridgeMayRevoke', () => {
  it('cada bridge solo revoca lo suyo', () => {
    expect(bridgeMayRevoke('MEMBERSHIP', 'MEMBERSHIP')).toBe(true);
    expect(bridgeMayRevoke('TIER', 'TIER')).toBe(true);
  });

  it('nunca revoca MANUAL ni lo del otro bridge', () => {
    expect(bridgeMayRevoke('MANUAL', 'MEMBERSHIP')).toBe(false);
    expect(bridgeMayRevoke('MANUAL', 'TIER')).toBe(false);
    expect(bridgeMayRevoke('TIER', 'MEMBERSHIP')).toBe(false);
    expect(bridgeMayRevoke('MEMBERSHIP', 'TIER')).toBe(false);
  });
});
