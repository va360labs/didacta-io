/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * El pago DENTRO de la página de venta del aula (Checkout embebido) y la marca
 * del aula en su cuenta conectada: la clave publicable, la membresía, quién
 * vende y la imagen y el color que se mandan a Stripe.
 */

import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import {
  publishableKeyLivemode,
  publishableKeyProblem,
} from '../src/common/stripe-publishable-key';
import { loadPlatformPaymentsConfig } from '../src/modules/payouts/platform-payments.config';
import {
  brandPrimaryHex,
  hslToHex,
  squareIcon,
  wordmarkLogo,
} from '../src/modules/payouts/payouts-branding.sync';
import { MembershipPublicController } from '../src/modules/subscriptions/membership-public.controller';
import { CheckoutSellerController } from '../src/public/checkout-seller.controller';
import { fakeConsents } from './helpers/fake-purchase-consent';

const TENANT = 'tenant-primer-sorbo';
const PLAN = '33333333-3333-4333-8333-333333333333';

describe('clave publicable', () => {
  it('reconoce pk_test_/pk_live_ y su modo', () => {
    expect(publishableKeyLivemode('pk_test_abcdefgh1')).toBe(false);
    expect(publishableKeyLivemode('pk_live_abcdefgh1')).toBe(true);
    expect(publishableKeyLivemode('sk_test_abcdefgh1')).toBeNull();
    expect(publishableKeyLivemode('pk_test_')).toBeNull();
    expect(publishableKeyLivemode(undefined)).toBeNull();
  });

  it('tiene que ser del mismo modo que la secreta', () => {
    expect(publishableKeyProblem('pk_test_abcdefgh1', 'sk_test_x')).toBeNull();
    expect(publishableKeyProblem('pk_live_abcdefgh1', 'rk_live_x')).toBeNull();
    expect(publishableKeyProblem('pk_live_abcdefgh1', 'sk_test_x')).toBe('mode');
    expect(publishableKeyProblem('pk_test_abcdefgh1', 'sk_live_x')).toBe('mode');
    expect(publishableKeyProblem('nada', 'sk_test_x')).toBe('format');
  });
});

describe('PAYMENTS_PLATFORM_STRIPE_PUBLISHABLE_KEY', () => {
  const base = {
    PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_operador123',
    PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: 'whsec_operador',
  };

  it('opcional: sin ella, publishableKey null (el pago va por el redirect)', () => {
    const config = loadPlatformPaymentsConfig(base);
    expect(config.enabled && config.publishableKey).toBeNull();
  });

  it('con ella, viaja en la configuración', () => {
    const config = loadPlatformPaymentsConfig({
      ...base,
      PAYMENTS_PLATFORM_STRIPE_PUBLISHABLE_KEY: 'pk_test_operador1234',
    });
    expect(config.enabled && config.publishableKey).toBe('pk_test_operador1234');
  });

  it('de otro modo que la secreta, o que no es pk_, aborta el arranque sin repetir el valor', () => {
    expect(() =>
      loadPlatformPaymentsConfig({
        ...base,
        PAYMENTS_PLATFORM_STRIPE_PUBLISHABLE_KEY: 'pk_live_operador1234',
      }),
    ).toThrow(/PAYMENTS_PLATFORM_STRIPE_PUBLISHABLE_KEY/);
    let message = '';
    try {
      loadPlatformPaymentsConfig({
        ...base,
        PAYMENTS_PLATFORM_STRIPE_PUBLISHABLE_KEY: 'xx_secreto_que_no_se_imprime',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('PAYMENTS_PLATFORM_STRIPE_PUBLISHABLE_KEY');
    expect(message).not.toContain('xx_secreto_que_no_se_imprime');
  });
});

describe('MembershipPublicController — pago dentro de /join', () => {
  function build(publishableKey: string | null) {
    const membership = {
      startMembershipCheckout: vi.fn(async (args: { uiMode?: string }) =>
        args.uiMode === 'embedded'
          ? {
              url: null,
              sessionId: 'cs_test_membresia',
              clientSecret: 'cs_test_membresia_secret',
              amountTotal: 0,
              currency: 'eur',
            }
          : {
              url: 'https://stripe/cs_test_membresia',
              sessionId: 'cs_test_membresia',
              clientSecret: null,
              amountTotal: 1900,
              currency: 'eur',
            },
      ),
      getPublicPage: vi.fn(async () => ({ plans: [{ id: PLAN, name: 'Mensual' }] })),
      getCheckoutSessionState: vi.fn(),
    };
    const ctrl = new MembershipPublicController(
      {
        getMembershipService: () => membership,
        resolveCheckoutPublishableKey: vi.fn(async () => publishableKey),
      } as never,
      {
        resolveByHost: async () => ({ id: TENANT }),
        resolveTenantWebBaseUrl: async () => 'https://primersorbo.test',
      } as never,
      fakeConsents() as never,
      // Módulos y ajustes del aula: solo los mira el nivel gratis, que aquí no hay.
      { list: async () => [] } as never,
      {} as never,
    );
    return { ctrl, membership };
  }
  const req = { headers: { host: 'primersorbo.test', cookie: 'didacta_locale=en-US' } } as never;

  it('con clave publicable: embebido con vuelta a /join que pregunta, e importe de la sesión', async () => {
    const { ctrl, membership } = build('pk_test_abcdefgh1234');
    const result = await ctrl.checkout(req, {
      planId: PLAN,
      referralCode: 'ana123',
      uiMode: 'embedded',
    });
    expect(result).toEqual({
      mode: 'embedded',
      sessionId: 'cs_test_membresia',
      url: null,
      clientSecret: 'cs_test_membresia_secret',
      publishableKey: 'pk_test_abcdefgh1234',
      amountTotal: 0,
      currency: 'eur',
    });
    expect(membership.startMembershipCheckout.mock.calls[0]![0]).toMatchObject({
      uiMode: 'embedded',
      returnUrl:
        'https://primersorbo.test/join?status=success&session_id={CHECKOUT_SESSION_ID}&checkout=embedded',
      checkoutLocale: 'en',
      referralCode: 'ana123',
    });
  });

  it('sin clave publicable: redirect de siempre, y la vuelta trae la sesión para la página de gracias', async () => {
    const { ctrl, membership } = build(null);
    const result = await ctrl.checkout(req, { planId: PLAN, uiMode: 'embedded' });
    expect(result).toEqual({
      mode: 'hosted',
      url: 'https://stripe/cs_test_membresia',
      sessionId: 'cs_test_membresia',
    });
    const args = membership.startMembershipCheckout.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('uiMode');
    expect(args['successUrl']).toBe(
      'https://primersorbo.test/join?status=success&session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('vuelta: plan, importe y fecha; 404 si no es de esta academia o el id no es de sesión', async () => {
    const { ctrl, membership } = build(null);
    membership.getCheckoutSessionState.mockResolvedValueOnce({
      status: 'complete',
      paid: true,
      planId: PLAN,
      amount: 1900,
      currency: 'eur',
      at: '2026-11-14T10:00:00.000Z',
    });
    await expect(ctrl.checkoutSession(req, 'cs_test_a1B2c3D4e5F6')).resolves.toEqual({
      status: 'complete',
      paid: true,
      amount: 1900,
      currency: 'eur',
      at: '2026-11-14T10:00:00.000Z',
      plan: { name: 'Mensual' },
    });
    membership.getCheckoutSessionState.mockResolvedValueOnce(null);
    await expect(ctrl.checkoutSession(req, 'cs_test_a1B2c3D4e5F6')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(ctrl.checkoutSession(req, 'in_123')).rejects.toBeInstanceOf(NotFoundException);
    expect(membership.getCheckoutSessionState).toHaveBeenCalledTimes(2);
  });
});

describe('CheckoutSellerController — quién vende', () => {
  function build(replyTo: unknown, creator: unknown) {
    return new CheckoutSellerController(
      {
        resolveByHost: async (h: string | null) =>
          h ? { id: TENANT, name: 'Primer Sorbo' } : null,
      } as never,
      { creator: vi.fn(async () => creator) } as never,
      {
        getTenantConfig: () => ({
          get: async (_t: string, module: string, key: string) =>
            module === 'notifications' && key === 'sender' ? replyTo : undefined,
        }),
      } as never,
    );
  }
  const req = { headers: { host: 'primersorbo.test' } } as never;

  it('nombre del aula, quien la lleva y el correo de contacto que el aula eligió', async () => {
    const ctrl = build(
      { replyToEmail: 'hola@primersorbo.test' },
      { name: 'Lucía Prieto', avatarUrl: null },
    );
    await expect(ctrl.seller(req)).resolves.toEqual({
      name: 'Primer Sorbo',
      creator: { name: 'Lucía Prieto', avatarUrl: null },
      contactEmail: 'hola@primersorbo.test',
    });
  });

  it('sin correo de contacto configurado no se publica ninguno', async () => {
    const ctrl = build(undefined, null);
    await expect(ctrl.seller(req)).resolves.toEqual({
      name: 'Primer Sorbo',
      creator: null,
      contactEmail: null,
    });
  });
});

describe('marca del aula para Stripe', () => {
  it('el color principal es el --color-brand-600 de la web', () => {
    // Azul de Didacta por defecto (213°, 70 %): hsl(213, 72%, 38%).
    expect(brandPrimaryHex(213, 70)).toBe(hslToHex(213, 72, 38));
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
    expect(hslToHex(120, 100, 25)).toBe('#008000');
    expect(brandPrimaryHex(213, 70)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('icono cuadrado de 512 px en PNG, por debajo del tope de Stripe', async () => {
    const wide = await sharp({
      create: {
        width: 600,
        height: 200,
        channels: 4,
        background: { r: 230, g: 110, b: 60, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const icon = await squareIcon(wide);
    const meta = await sharp(Buffer.from(icon.bytes)).metadata();
    expect(icon.contentType).toBe('image/png');
    expect([meta.width, meta.height]).toEqual([512, 512]);
    expect(icon.bytes.length).toBeLessThan(512 * 1024);
  });

  it('logo con nombre: al menos 128 px por lado aunque sea muy apaisado', async () => {
    const strip = await sharp({
      create: { width: 900, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const logo = await wordmarkLogo(strip);
    const meta = await sharp(Buffer.from(logo.bytes)).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(128);
    expect(meta.height).toBeGreaterThanOrEqual(128);
    expect(logo.bytes.length).toBeLessThan(512 * 1024);
  });
});
