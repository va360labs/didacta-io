import { describe, expect, it } from 'vitest';
import { adaptCanonicalToDidacta } from '../../src/index.js';

/// Tests del adapter de groups (v1.0.33+).
///
/// Contexto: hasta v1.0.32 el adapter rechazaba groups con
/// `ADAPTER_GROUPS_NO_TARGET` marcando skip=true. Resultado: 0/8 groups
/// "cargados" en el reporte real del operador (silent skip — no aparecían
/// en el DLQ y el operador no sabía que se habían perdido).
///
/// v1.0.33 cambia la política: ahora groups generan fail=true con código
/// `ADAPTER_GROUPS_NOT_SUPPORTED` y mensaje accionable que llega al DLQ
/// (visible en /jobs/:id/dlq). El operador queda enterado y sabe que
/// el flow de groups requiere ET-001b (enrollments fan-out).

describe('adaptCanonicalToDidacta · groups (v1.0.33)', () => {
  it('group con sourceId válido → fail con ADAPTER_GROUPS_NOT_SUPPORTED', () => {
    const canonical = {
      sourceId: '42',
      title: 'Equipo A',
      memberIds: [1, 2, 3],
    };
    const result = adaptCanonicalToDidacta('groups', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ADAPTER_GROUPS_NOT_SUPPORTED');
  });

  it('group NO marca skip (cambio respecto a 1.0.32: ya no es silent skip)', () => {
    const canonical = { sourceId: '42', title: 'Equipo A' };
    const result = adaptCanonicalToDidacta('groups', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.skip).toBeFalsy();
  });

  it('group marca fail=true (para que llegue al DLQ via el loop del loader)', () => {
    const canonical = { sourceId: '42', title: 'Equipo A' };
    const result = adaptCanonicalToDidacta('groups', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fail).toBe(true);
  });

  it('group emite mensaje accionable mencionando ET-001b y enrollments', () => {
    const canonical = { sourceId: '42', title: 'Equipo A' };
    const result = adaptCanonicalToDidacta('groups', canonical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // El operador debe entender por qué se perdió el group y qué falta para soportarlo.
    expect(result.message).toMatch(/ET-001b/);
    expect(result.message).toMatch(/enrollments/i);
  });

  it('group YA NO emite ADAPTER_GROUPS_NO_TARGET (regresión 1.0.32→1.0.33)', () => {
    // En 1.0.32 cualquier group devolvía skip=true con code ADAPTER_GROUPS_NO_TARGET.
    // v1.0.33 NO debe nunca volver a ese estado.
    const canonical = { sourceId: '42', title: 'Cualquier group' };
    const result = adaptCanonicalToDidacta('groups', canonical);
    if (!result.ok) {
      expect(result.code).not.toBe('ADAPTER_GROUPS_NO_TARGET');
    }
  });
});
