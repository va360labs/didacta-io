import { describe, expect, it } from 'vitest';
import {
  classifyPurchase,
  DEFAULT_RULESET,
  expires,
  grantsLearningAccess,
  strongestKind,
  timedExpiryFrom,
  type EntitlementRuleset,
} from '../src/entitlement-rules.js';

/**
 * Ruleset de ejemplo con la forma de un catálogo real de tienda (packs PRO
 * mensual/anual, acceso anual como producto simple, lifetime, hosting).
 * Sirve de test y de documentación de cómo se configura un ruleset por tenant.
 */
const DEMO: EntitlementRuleset = {
  rules: [
    { match: /^vps\b/i, kind: 'INFRA', note: 'Hosting, no formación.' },
    { match: /lifetime/i, kind: 'LIFETIME', note: 'Acceso total permanente.' },
    {
      match: /acceso\s+anual\s+a\s+demo/i,
      kind: 'TIMED',
      durationMonths: 12,
      note: 'Producto simple con vigencia de un año: la tienda no lo renueva sola.',
    },
    {
      match: /demo\s*pro/i,
      kind: 'SUBSCRIPTION',
      note: 'Todos los PRO no-lifetime son recurrentes.',
    },
    {
      match: /demo\s*2026|acceso\s+anual\s+demo/i,
      kind: 'SUBSCRIPTION',
      note: 'Planes de temporada.',
    },
  ],
  fallback: 'ONE_OFF',
};

describe('classifyPurchase · catálogo real de DEMO', () => {
  it('LIFETIME gana sobre PRO: "DEMO PRO LIFETIME" no es una suscripción', () => {
    // El orden de las reglas es lo único que evita cortarle el acceso a los
    // compradores de lifetime.
    expect(classifyPurchase({ productName: 'DEMO PRO LIFETIME' }, DEMO).kind).toBe('LIFETIME');
    expect(classifyPurchase({ productName: 'DEMO PRO LIFETIME UP' }, DEMO).kind).toBe('LIFETIME');
  });

  it('los PRO periódicos son suscripción', () => {
    for (const n of ['DEMO PRO ANUAL', 'DEMO PRO SEMESTRAL', 'DEMO PRO | MENSUAL | BLACK FRIDAY']) {
      expect(classifyPurchase({ productName: n }, DEMO).kind, n).toBe('SUBSCRIPTION');
    }
  });

  it('los planes de temporada son suscripción', () => {
    expect(classifyPurchase({ productName: 'DEMO 2026 - Mensual' }, DEMO).kind).toBe(
      'SUBSCRIPTION',
    );
    expect(classifyPurchase({ productName: 'DEMO 2026 - Anual' }, DEMO).kind).toBe('SUBSCRIPTION');
    expect(classifyPurchase({ productName: 'ACCESO ANUAL DEMO - Alumnos 2025' }, DEMO).kind).toBe(
      'SUBSCRIPTION',
    );
  });

  it('"Acceso ANUAL a DEMO" es TIMED y no SUBSCRIPTION: la tienda no lo renueva sola', () => {
    const c = classifyPurchase({ productName: 'Acceso ANUAL a DEMO', productType: 'simple' }, DEMO);
    expect(c.kind).toBe('TIMED');
    expect(c.durationMonths).toBe(12);
  });

  it('el VPS queda fuera del circuito de formación', () => {
    expect(classifyPurchase({ productName: 'VPS Iniciación' }, DEMO).kind).toBe('INFRA');
    expect(classifyPurchase({ productName: 'VPS Plus' }, DEMO).kind).toBe('INFRA');
    expect(grantsLearningAccess('INFRA')).toBe(false);
  });

  it('un curso suelto no caduca', () => {
    const c = classifyPurchase(
      { productName: 'Master en Automatizaciones y Agentes IA', productType: 'simple' },
      DEMO,
    );
    expect(c.kind).toBe('ONE_OFF');
    expect(expires('ONE_OFF')).toBe(false);
  });

  it('un pedido real de un curso suelto sale como compra suelta', () => {
    expect(
      classifyPurchase({ productName: 'Master en Automatizaciones y Agentes IA' }, DEMO).kind,
    ).toBe('ONE_OFF');
  });
});

describe('classifyPurchase · inferencia sin reglas del tenant', () => {
  it('el tipo de producto de la tienda basta para detectar un recurrente', () => {
    const c = classifyPurchase({ productName: 'Plan Cualquiera', productType: 'subscription' });
    expect(c.kind).toBe('SUBSCRIPTION');
    expect(c.reason).toContain('subscription');
  });

  it('reconoce las suscripciones variables', () => {
    expect(
      classifyPurchase({ productName: 'Plan X', productType: 'variable-subscription' }).kind,
    ).toBe('SUBSCRIPTION');
  });

  it('detecta lifetime por nombre aun sin reglas del tenant', () => {
    expect(classifyPurchase({ productName: 'Acceso Lifetime' }, DEFAULT_RULESET).kind).toBe(
      'LIFETIME',
    );
  });

  it('ante la duda NO caduca: el fallback nunca puede quitar acceso', () => {
    const c = classifyPurchase({ productName: 'Producto Desconocido 2031', productType: 'simple' });
    expect(c.kind).toBe('ONE_OFF');
    expect(expires(c.kind)).toBe(false);
  });

  it('una regla del tenant manda sobre el tipo de la tienda', () => {
    // Producto marcado como recurrente en Woo pero que el negocio considera
    // permanente: gana el negocio.
    const rs: EntitlementRuleset = {
      rules: [{ match: /regalo/i, kind: 'LIFETIME' }],
      fallback: 'ONE_OFF',
    };
    expect(
      classifyPurchase({ productName: 'Regalo VIP', productType: 'subscription' }, rs).kind,
    ).toBe('LIFETIME');
  });

  it('aguanta un nombre vacío sin romperse', () => {
    expect(classifyPurchase({ productName: '' }).kind).toBe('ONE_OFF');
  });
});

describe('expires / grantsLearningAccess', () => {
  it('solo caducan las suscripciones y los accesos con vigencia', () => {
    expect(expires('SUBSCRIPTION')).toBe(true);
    expect(expires('TIMED')).toBe(true);
    expect(expires('LIFETIME')).toBe(false);
    expect(expires('ONE_OFF')).toBe(false);
    expect(expires('INFRA')).toBe(false);
  });

  it('todo lo que no es infraestructura da acceso a formación', () => {
    expect(grantsLearningAccess('LIFETIME')).toBe(true);
    expect(grantsLearningAccess('SUBSCRIPTION')).toBe(true);
    expect(grantsLearningAccess('TIMED')).toBe(true);
    expect(grantsLearningAccess('ONE_OFF')).toBe(true);
    expect(grantsLearningAccess('INFRA')).toBe(false);
  });
});

describe('timedExpiryFrom', () => {
  it('suma meses de calendario, no 30 días', () => {
    expect(timedExpiryFrom(new Date('2026-01-15T10:00:00Z'), 12).toISOString()).toContain(
      '2027-01-15',
    );
  });

  it('no desborda al mes siguiente cuando el destino es más corto', () => {
    // 31-ene + 1 mes debe ser 28-feb, no 3-mar.
    const d = timedExpiryFrom(new Date('2026-01-31T00:00:00Z'), 1);
    expect(d.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('respeta los años bisiestos', () => {
    const d = timedExpiryFrom(new Date('2028-01-31T00:00:00Z'), 1);
    expect(d.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('un acceso anual comprado el 29 de febrero vence el 28', () => {
    const d = timedExpiryFrom(new Date('2028-02-29T00:00:00Z'), 12);
    expect(d.toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('no muta la fecha de entrada', () => {
    const origen = new Date('2026-03-10T00:00:00Z');
    timedExpiryFrom(origen, 6);
    expect(origen.toISOString().slice(0, 10)).toBe('2026-03-10');
  });
});

describe('strongestKind', () => {
  it('un pedido con lifetime y un curso suelto es un lifetime', () => {
    expect(strongestKind(['ONE_OFF', 'LIFETIME'])).toBe('LIFETIME');
  });

  it('la suscripción gana a la compra suelta', () => {
    expect(strongestKind(['ONE_OFF', 'SUBSCRIPTION'])).toBe('SUBSCRIPTION');
  });

  it('el VPS nunca decide por el resto del pedido', () => {
    expect(strongestKind(['INFRA', 'ONE_OFF'])).toBe('ONE_OFF');
    expect(strongestKind(['INFRA', 'SUBSCRIPTION'])).toBe('SUBSCRIPTION');
  });

  it('un pedido vacío se trata como compra suelta', () => {
    expect(strongestKind([])).toBe('ONE_OFF');
  });
});
