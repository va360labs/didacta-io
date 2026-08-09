import { describe, expect, it } from 'vitest';
import {
  buildDecisionEmail,
  buildOtpEmail,
  buildRejectionEmail,
  buildWelcomeEmail,
  escapeHtml,
  type DecisionEmailParams,
} from '../src/modules/member-registration/email-templates';
import type { EmailBranding } from '../src/common/branded-email';

// ============================================================================
// Tests de las plantillas de email del flujo de inscripción (funciones puras).
// Cubren el escape de HTML, el OTP, y la lógica condicional del email de
// decisión (banner de impago, encabezado por tri-estado, ambos hrefs). Todas
// las plantillas se firman con el nombre del tenant (branding), no "Didacta".
// ============================================================================

/** Branding de prueba: sin logo (fallback al nombre en el header). */
function branding(tenantName = 'Didacta'): EmailBranding {
  return { tenantName, logoUrl: null, brandColor: '#1E5AA8' };
}

function baseDecisionParams(overrides: Partial<DecisionEmailParams> = {}): DecisionEmailParams {
  return {
    name: 'Alex',
    email: 'solicitante@example.com',
    telegramId: '424242',
    inGroup: 'true',
    isDelinquent: false,
    approveUrl: 'https://didacta.io/approve?t=AAA',
    rejectUrl: 'https://didacta.io/reject?t=BBB',
    branding: branding(),
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapa & < > y comillas dobles', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
  });

  it('deja intacto el texto sin caracteres especiales', () => {
    expect(escapeHtml('Hola mundo 123')).toBe('Hola mundo 123');
  });
});

describe('buildOtpEmail', () => {
  it('incluye el código tanto en text como en html', () => {
    const { subject, text, html } = buildOtpEmail('482913', branding(), 'es-ES');
    expect(subject).toBe('Tu código de acceso');
    expect(text).toContain('482913');
    expect(html).toContain('482913');
  });

  it('firma con el nombre del tenant', () => {
    const custom = buildOtpEmail('000000', branding('Academia Demo'), 'es-ES');
    expect(custom.text).toContain('Academia Demo');
    expect(custom.html).toContain('Academia Demo');
    // Footer discreto con la marca de la plataforma.
    expect(custom.html).toContain('Powered by Didacta');
  });

  it('escapa el tenantName en el html', () => {
    const { html } = buildOtpEmail('000000', branding('A & B'), 'es-ES');
    expect(html).toContain('A &amp; B');
  });
});

describe('buildDecisionEmail', () => {
  it('incluye AMBOS hrefs (approveUrl y rejectUrl) en el html', () => {
    const params = baseDecisionParams();
    const { html } = buildDecisionEmail(params);
    expect(html).toContain(`href="${params.approveUrl}"`);
    expect(html).toContain(`href="${params.rejectUrl}"`);
  });

  it('incluye ambas URLs también en la versión texto', () => {
    const params = baseDecisionParams();
    const { text } = buildDecisionEmail(params);
    expect(text).toContain(params.approveUrl);
    expect(text).toContain(params.rejectUrl);
  });

  it('muestra el banner de impago SOLO si isDelinquent', () => {
    const con = buildDecisionEmail(baseDecisionParams({ isDelinquent: true }));
    expect(con.html).toContain('CONSTA COMO IMPAGO');
    expect(con.text).toContain('CONSTA COMO IMPAGO');

    const sin = buildDecisionEmail(baseDecisionParams({ isDelinquent: false }));
    expect(sin.html).not.toContain('CONSTA COMO IMPAGO');
    expect(sin.text).not.toContain('CONSTA COMO IMPAGO');
  });

  it("encabezado cuando inGroup = 'true'", () => {
    const { html, text } = buildDecisionEmail(baseDecisionParams({ inGroup: 'true' }));
    // El nombre del grupo se deriva del tenant (branding), sin marca fija.
    expect(html).toContain('Miembro del grupo de Didacta');
    expect(text).toContain('Miembro del grupo de Didacta');
  });

  it("encabezado cuando inGroup = 'false'", () => {
    const { html, text } = buildDecisionEmail(baseDecisionParams({ inGroup: 'false' }));
    expect(html).toContain('NO está en el grupo - revisar caso');
    expect(text).toContain('NO está en el grupo - revisar caso');
  });

  it("encabezado cuando inGroup = 'unknown'", () => {
    const { html, text } = buildDecisionEmail(baseDecisionParams({ inGroup: 'unknown' }));
    expect(html).toContain('Pertenencia NO verificable');
    expect(text).toContain('Pertenencia NO verificable');
  });

  it('sin Telegram (telegramId null): omite el encabezado de pertenencia y la fila Telegram ID', () => {
    const { html, text } = buildDecisionEmail(
      baseDecisionParams({ telegramId: null, inGroup: 'unknown' }),
    );
    expect(html).not.toContain('Telegram ID');
    expect(text).not.toContain('Telegram ID');
    expect(html).not.toContain('Pertenencia NO verificable');
    expect(text).not.toContain('Estado:');
    // Los datos y los enlaces de decisión siguen presentes.
    expect(text).toContain('Nombre:');
    expect(text).toContain('Aprobar:');
  });

  it('escapa los datos del solicitante en el html (anti-inyección)', () => {
    const { html } = buildDecisionEmail(
      baseDecisionParams({ name: 'Al<b>ex</b>', email: 'a"b@x.com' }),
    );
    expect(html).toContain('Al&lt;b&gt;ex&lt;/b&gt;');
    expect(html).toContain('a&quot;b@x.com');
  });

  it('el subject incluye el nombre del solicitante', () => {
    const { subject } = buildDecisionEmail(baseDecisionParams({ name: 'Alex' }));
    expect(subject).toBe('Nueva inscripción pendiente — Alex');
  });

  it('firma con el nombre del tenant', () => {
    const { text } = buildDecisionEmail(
      baseDecisionParams({ branding: branding('Academia Demo') }),
    );
    expect(text).toContain('aprobación en Academia Demo');
    expect(text).toContain('— Academia Demo');
  });

  // ── Sección de suscripción detectada ────────────────────────────────────
  const MATCH = {
    provider: 'stripe',
    connectionId: 'conn_1',
    connectionName: 'Stripe ES',
    planName: 'Plan Pro',
    status: 'active',
    unitAmount: 1999,
    currency: 'eur',
    subscriptionId: 'sub_1',
  };

  it('sin matches ni fallos: dice "ninguna" (negativo honesto)', () => {
    const { text, html } = buildDecisionEmail(
      baseDecisionParams({ subscriptionMatches: [], subscriptionFailures: [] }),
    );
    expect(text).toContain('ninguna en las cuentas de pago conectadas');
    expect(html).toContain('Sin suscripción detectada');
  });

  it('con match vigente: muestra proveedor, plan, estado legible e importe en text y html', () => {
    const { text, html } = buildDecisionEmail(baseDecisionParams({ subscriptionMatches: [MATCH] }));
    // El estado crudo (active) se muestra clasificado y legible ("Activa").
    expect(text).toContain('Stripe: Plan Pro — Activa');
    expect(text).toContain('19.99 EUR');
    expect(text).toContain('Suscripción vigente');
    expect(html).toContain('Suscripción vigente');
    expect(html).toContain('Stripe: Plan Pro — Activa');
  });

  it('con match NO vigente (baja/impago): lo destaca como no vigente, no como detectada', () => {
    const canceled = { ...MATCH, status: 'canceled', subscriptionId: 'sub_cancel' };
    const { text, html } = buildDecisionEmail(
      baseDecisionParams({ subscriptionMatches: [canceled] }),
    );
    expect(text).toContain('Suscripción NO vigente');
    expect(text).toContain('Stripe: Plan Pro — Dada de baja');
    expect(html).toContain('Suscripción no vigente');
    expect(html).toContain('Dada de baja');
  });

  it('sin match pero con fallo: NO afirma "ninguna" — avisa de no verificable', () => {
    const { text, html } = buildDecisionEmail(
      baseDecisionParams({
        subscriptionMatches: [],
        subscriptionFailures: [
          { provider: 'paypal', connectionName: 'PayPal Main', message: 'timeout' },
        ],
      }),
    );
    expect(text).not.toContain('ninguna en las cuentas de pago conectadas');
    expect(text).toContain('No se pudo verificar');
    expect(text).toContain('PayPal Main');
    expect(html).toContain('No se pudo verificar');
    expect(html).toContain('Revisar manualmente');
  });

  it('con match y además un fallo: marca resultado parcial', () => {
    const { text, html } = buildDecisionEmail(
      baseDecisionParams({
        subscriptionMatches: [MATCH],
        subscriptionFailures: [
          { provider: 'woocommerce', connectionName: 'Tienda', message: 'down' },
        ],
      }),
    );
    expect(text).toContain('Resultado parcial');
    expect(html).toContain('Resultado parcial');
  });

  it('escapa los datos de la suscripción/fallos en el html (anti-inyección)', () => {
    const { html } = buildDecisionEmail(
      baseDecisionParams({
        subscriptionMatches: [{ ...MATCH, planName: 'Plan <b>X</b>' }],
        subscriptionFailures: [
          { provider: 'stripe', connectionName: 'A & <b>B</b>', message: 'x' },
        ],
      }),
    );
    expect(html).toContain('Plan &lt;b&gt;X&lt;/b&gt;');
    expect(html).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
    expect(html).not.toContain('Plan <b>X</b>');
  });
});

/**
 * Compras PUNTUALES en el email de decisión. Quien compró un "acceso lifetime"
 * no tiene suscripción viva: sin este bloque el aprobador solo leería "sin
 * suscripción detectada" y rechazaría a un cliente que sí pagó.
 */
describe('buildDecisionEmail · compras puntuales', () => {
  const PURCHASE = {
    provider: 'woocommerce',
    connectionId: 'conn-1',
    connectionName: 'Woo Demo',
    orderId: '8801',
    orderNumber: '8801',
    status: 'completed',
    total: 99_700,
    currency: 'EUR',
    createdAt: '2023-04-11T09:15:00Z',
    products: ['Acceso Lifetime'],
  };

  it('lista las compras con nº, estado, importe y productos en text y html', () => {
    const { text, html } = buildDecisionEmail(baseDecisionParams({ purchases: [PURCHASE] }));
    for (const body of [text, html]) {
      expect(body).toContain('Compras detectadas (1)');
      expect(body).toContain('#8801');
      expect(body).toContain('completed');
      expect(body).toContain('997.00 EUR');
      expect(body).toContain('Acceso Lifetime');
    }
  });

  it('convive con "sin suscripción detectada" (es justo el caso lifetime)', () => {
    const { text } = buildDecisionEmail(
      baseDecisionParams({ subscriptionMatches: [], purchases: [PURCHASE] }),
    );
    expect(text).toContain('Suscripción detectada: ninguna');
    expect(text).toContain('Acceso Lifetime');
  });

  it('sin compras no añade el bloque (no mete ruido en las solicitudes normales)', () => {
    const { text, html } = buildDecisionEmail(baseDecisionParams({ purchases: [] }));
    expect(text).not.toContain('Compras detectadas');
    expect(html).not.toContain('Compras detectadas');
  });

  it('escapa el nombre del producto en el HTML', () => {
    const { html } = buildDecisionEmail(
      baseDecisionParams({ purchases: [{ ...PURCHASE, products: ['Curso <b>X</b>'] }] }),
    );
    expect(html).toContain('Curso &lt;b&gt;X&lt;/b&gt;');
    expect(html).not.toContain('Curso <b>X</b>');
  });

  it('un pedido sin fecha ni importe no rompe la línea', () => {
    const { text } = buildDecisionEmail(
      baseDecisionParams({
        purchases: [{ ...PURCHASE, createdAt: null, total: null, currency: null, products: [] }],
      }),
    );
    expect(text).toContain('#8801 · completed');
  });
});

describe('buildWelcomeEmail', () => {
  it('incluye el saludo con nombre y el signinUrl', () => {
    const { text, html, subject } = buildWelcomeEmail(
      'Alex',
      'https://didacta.io/signin',
      branding('Academia Demo'),
      'es-ES',
    );
    expect(subject).toContain('Academia Demo');
    expect(text).toContain('Hola Alex,');
    expect(html).toContain('href="https://didacta.io/signin"');
  });

  it('usa saludo genérico cuando no hay nombre', () => {
    const { text } = buildWelcomeEmail('', 'https://didacta.io/signin', branding(), 'es-ES');
    expect(text).toContain('Hola,');
  });
});

describe('buildRejectionEmail', () => {
  it('incluye el saludo con nombre y el tenantName', () => {
    const { text, subject } = buildRejectionEmail('Alex', branding('Academia Demo'), 'es-ES');
    expect(subject).toContain('Academia Demo');
    expect(text).toContain('Hola Alex,');
    expect(text).toContain('Academia Demo');
  });
});
