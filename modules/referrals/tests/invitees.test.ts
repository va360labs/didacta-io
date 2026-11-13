import { describe, expect, it } from 'vitest';
import { deriveInviteeState, initialsOf } from '../src/invitees.js';

// Reglas puras de «Tus invitados»: estado de cada invitado e iniciales.

const d = (iso: string) => new Date(iso);

describe('deriveInviteeState', () => {
  it('suscripción en prueba → trial', () => {
    expect(
      deriveInviteeState({
        subscriptions: [{ status: 'TRIALING', createdAt: d('2026-11-01') }],
        hasCoursePurchase: false,
      }),
    ).toBe('trial');
  });

  it('ACTIVE y PAST_DUE cuentan como pagando', () => {
    for (const status of ['ACTIVE', 'PAST_DUE']) {
      expect(
        deriveInviteeState({
          subscriptions: [{ status, createdAt: d('2026-11-01') }],
          hasCoursePurchase: false,
        }),
      ).toBe('paying');
    }
  });

  it('manda la suscripción MÁS RECIENTE: se dio de baja y volvió → pagando', () => {
    expect(
      deriveInviteeState({
        subscriptions: [
          { status: 'CANCELED', createdAt: d('2026-09-01') },
          { status: 'ACTIVE', createdAt: d('2026-10-01') },
        ],
        hasCoursePurchase: false,
      }),
    ).toBe('paying');
  });

  it('pagaba y lo dejó → se dio de baja', () => {
    expect(
      deriveInviteeState({
        subscriptions: [
          { status: 'ACTIVE', createdAt: d('2026-09-01') },
          { status: 'CANCELED', createdAt: d('2026-10-01') },
        ],
        hasCoursePurchase: false,
      }),
    ).toBe('cancelled');
    expect(
      deriveInviteeState({
        subscriptions: [{ status: 'UNPAID', createdAt: d('2026-10-01') }],
        hasCoursePurchase: false,
      }),
    ).toBe('cancelled');
  });

  it('las PENDING (pago sin cerrar) no cuentan', () => {
    expect(
      deriveInviteeState({
        subscriptions: [
          { status: 'ACTIVE', createdAt: d('2026-09-01') },
          { status: 'PENDING', createdAt: d('2026-11-01') },
        ],
        hasCoursePurchase: false,
      }),
    ).toBe('paying');
    expect(
      deriveInviteeState({
        subscriptions: [{ status: 'PENDING', createdAt: d('2026-11-01') }],
        hasCoursePurchase: false,
      }),
    ).toBe('joined');
  });

  it('compra suelta sin suscripción viva → compró un curso (gana a la baja)', () => {
    expect(deriveInviteeState({ subscriptions: [], hasCoursePurchase: true })).toBe(
      'bought_course',
    );
    expect(
      deriveInviteeState({
        subscriptions: [{ status: 'CANCELED', createdAt: d('2026-10-01') }],
        hasCoursePurchase: true,
      }),
    ).toBe('bought_course');
  });

  it('la suscripción viva gana a la compra suelta', () => {
    expect(
      deriveInviteeState({
        subscriptions: [{ status: 'ACTIVE', createdAt: d('2026-10-01') }],
        hasCoursePurchase: true,
      }),
    ).toBe('paying');
  });

  it('sin nada → joined', () => {
    expect(deriveInviteeState({ subscriptions: [], hasCoursePurchase: false })).toBe('joined');
  });
});

describe('initialsOf', () => {
  it('primera letra de las dos primeras palabras, en mayúsculas', () => {
    expect(initialsOf('María Pérez Gil')).toBe('MP');
    expect(initialsOf('lucía')).toBe('L');
    expect(initialsOf('  álvaro   ñúñez ')).toBe('ÁÑ');
  });

  it('sin nombre → «·»', () => {
    expect(initialsOf(null)).toBe('·');
    expect(initialsOf(undefined)).toBe('·');
    expect(initialsOf('   ')).toBe('·');
    expect(initialsOf('123 -- !!')).toBe('·');
  });

  it('nunca devuelve el nombre ni un correo', () => {
    expect(initialsOf('ana.lopez@example.com')).toBe('A');
    expect(initialsOf('Juan Carlos Rodríguez').length).toBe(2);
  });

  it('salta palabras sin letras', () => {
    expect(initialsOf('123 Pedro 4 Ruiz')).toBe('PR');
  });
});
