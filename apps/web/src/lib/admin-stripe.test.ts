/**
 * `deriveStripeStatus`: qué banner enseña el panel de pagos.
 */

import { describe, expect, it } from 'vitest';
import { deriveStripeStatus, type AdminStripeDto } from './admin-stripe';

const BASE: AdminStripeDto = {
  hasSecretKey: false,
  hasWebhookSecret: false,
  hasSubscriptionsWebhookSecret: false,
  mode: null,
  verifiedAt: null,
  verifiedByUserId: null,
  hasTenantConfig: false,
  hasGlobalFallback: false,
};

describe('deriveStripeStatus', () => {
  it('credenciales propias verificadas → verified', () => {
    expect(
      deriveStripeStatus({ ...BASE, hasTenantConfig: true, verifiedAt: '2026-11-12T00:00:00Z' }),
    ).toBe('verified');
  });

  it('credenciales propias sin verificar → configured-unverified', () => {
    expect(deriveStripeStatus({ ...BASE, hasTenantConfig: true })).toBe('configured-unverified');
  });

  it('sin credenciales propias, heredando la cuenta del servidor → fallback', () => {
    expect(deriveStripeStatus({ ...BASE, hasGlobalFallback: true })).toBe('fallback');
  });

  /**
   * El servidor tiene cuenta común pero, al haber varias aulas, esta ya no la
   * hereda: NO está cobrando. Es un aviso distinto del «sin configurar»: aquí
   * algo que funcionaba ha dejado de funcionar y hay que decir por qué.
   */
  it('cuenta común que ya no se hereda → fallback-blocked', () => {
    expect(deriveStripeStatus({ ...BASE, globalFallbackBlocked: true })).toBe('fallback-blocked');
  });

  it('con credenciales propias, el bloqueo de la cuenta común no pinta nada', () => {
    expect(
      deriveStripeStatus({ ...BASE, hasTenantConfig: true, globalFallbackBlocked: true }),
    ).toBe('configured-unverified');
  });

  it('nada de nada → none (también con una API anterior que no manda el campo nuevo)', () => {
    expect(deriveStripeStatus(BASE)).toBe('none');
  });
});
