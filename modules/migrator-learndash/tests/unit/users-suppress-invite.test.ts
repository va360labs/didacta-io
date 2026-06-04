import { describe, expect, it } from 'vitest';
import { adaptCanonicalToDidacta } from '../../src/index.js';

/// Tests del adapter de users · supresión de invitaciones (v1.0.36).
///
/// Contexto (incidente): una migración disparó ~2900 emails de invitación
/// porque al crear usuarios el host enviaba el email de bienvenida/invite
/// por defecto. El migrador NUNCA debe enviar emails al crear usuarios: el
/// operador notifica después de forma explícita y controlada.
///
/// v1.0.36: el adapter de users construye el input con `suppressInvite: true`
/// SIEMPRE. El host alpha.81+ respeta el flag (no envía email); hosts viejos
/// lo ignoran como campo extra (defensa aditiva — no rompe nada).

describe('adaptCanonicalToDidacta · users · suppressInvite (v1.0.36)', () => {
  it('user válido → input incluye suppressInvite: true', () => {
    const canonical = {
      sourceId: '7',
      email: 'alumno@example.com',
      displayName: 'Alumno Uno',
      roles: ['subscriber'],
    };
    const result = adaptCanonicalToDidacta('users', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ns).toBe('users');
    expect(result.input['suppressInvite']).toBe(true);
  });

  it('suppressInvite=true incluso cuando faltan campos opcionales (sin displayName)', () => {
    const canonical = {
      sourceId: '8',
      email: 'sin-nombre@example.com',
    };
    const result = adaptCanonicalToDidacta('users', canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input['name']).toBeUndefined();
    // El flag NO depende de campos opcionales: migrar NUNCA dispara emails.
    expect(result.input['suppressInvite']).toBe(true);
  });

  it('suppressInvite=true para cualquier rol mapeado (admin, formador, alumno)', () => {
    for (const roles of [['administrator'], ['group_leader'], ['subscriber'], []]) {
      const result = adaptCanonicalToDidacta('users', {
        sourceId: '9',
        email: 'rol@example.com',
        roles,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.input['suppressInvite']).toBe(true);
    }
  });

  it('regresión: el input de users NUNCA debe omitir suppressInvite', () => {
    // Guardia explícita contra una futura edición que elimine el flag y
    // reintroduzca el incidente de ~2900 emails.
    const result = adaptCanonicalToDidacta('users', {
      sourceId: '10',
      email: 'guard@example.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.prototype.hasOwnProperty.call(result.input, 'suppressInvite')).toBe(true);
    expect(result.input['suppressInvite']).toBe(true);
  });
});
