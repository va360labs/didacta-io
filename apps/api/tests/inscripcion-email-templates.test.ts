import { describe, expect, it } from 'vitest';
import {
  buildDecisionEmail,
  buildOtpEmail,
  buildRejectionEmail,
  buildWelcomeEmail,
  escapeHtml,
  type DecisionEmailParams,
} from '../src/inscripcion/email-templates';

// ============================================================================
// Tests de las plantillas de email del flujo de inscripción (funciones puras).
// Cubren el escape de HTML, el OTP, y la lógica condicional del email de
// decisión (banner de impago, encabezado por tri-estado, ambos hrefs).
// ============================================================================

function baseDecisionParams(overrides: Partial<DecisionEmailParams> = {}): DecisionEmailParams {
  return {
    name: 'Valen',
    email: 'valen@va360.com',
    telegramId: '424242',
    inGroup: 'true',
    isDelinquent: false,
    approveUrl: 'https://didacta.io/approve?t=AAA',
    rejectUrl: 'https://didacta.io/reject?t=BBB',
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

  it('escapa una cadena de inyección compuesta (orden correcto del &)', () => {
    // El & debe escaparse primero para no duplicar las entidades.
    expect(escapeHtml('<script>alert("x" & 1)</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; 1)&lt;/script&gt;',
    );
  });

  it('deja intacto el texto sin caracteres especiales', () => {
    expect(escapeHtml('Hola mundo 123')).toBe('Hola mundo 123');
  });
});

describe('buildOtpEmail', () => {
  it('incluye el código tanto en text como en html', () => {
    const { subject, text, html } = buildOtpEmail('482913');
    expect(subject).toBe('Tu código de acceso');
    expect(text).toContain('482913');
    expect(html).toContain('482913');
  });

  it('usa el tenantName por defecto Didacta y lo respeta si se pasa otro', () => {
    expect(buildOtpEmail('000000').text).toContain('Didacta');
    const custom = buildOtpEmail('000000', 'VA360 Academy');
    expect(custom.text).toContain('VA360 Academy');
    expect(custom.html).toContain('VA360 Academy');
  });

  it('escapa el tenantName en el html', () => {
    const { html } = buildOtpEmail('000000', 'A & B');
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
    expect(html).toContain('Miembro del grupo VA360');
    expect(text).toContain('Miembro del grupo VA360');
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

  it('escapa los datos del solicitante en el html (anti-inyección)', () => {
    const { html } = buildDecisionEmail(
      baseDecisionParams({ name: 'Va<b>len</b>', email: 'a"b@x.com' }),
    );
    expect(html).toContain('Va&lt;b&gt;len&lt;/b&gt;');
    expect(html).toContain('a&quot;b@x.com');
  });

  it('el subject incluye el nombre del solicitante', () => {
    const { subject } = buildDecisionEmail(baseDecisionParams({ name: 'Valen' }));
    expect(subject).toBe('Nueva inscripción pendiente — Valen');
  });

  it('usa el tenantName por defecto Didacta cuando no se pasa', () => {
    const { text } = buildDecisionEmail(baseDecisionParams());
    expect(text).toContain('Didacta');
  });
});

describe('buildWelcomeEmail', () => {
  it('incluye el saludo con nombre y el signinUrl', () => {
    const { text, html, subject } = buildWelcomeEmail('Valen', 'https://didacta.io/signin');
    expect(subject).toContain('Didacta');
    expect(text).toContain('Hola Valen,');
    expect(html).toContain('href="https://didacta.io/signin"');
  });

  it('usa saludo genérico cuando no hay nombre', () => {
    const { text } = buildWelcomeEmail('', 'https://didacta.io/signin');
    expect(text).toContain('Hola,');
  });
});

describe('buildRejectionEmail', () => {
  it('incluye el saludo con nombre y el tenantName', () => {
    const { text, subject } = buildRejectionEmail('Valen', 'VA360 Academy');
    expect(subject).toContain('VA360 Academy');
    expect(text).toContain('Hola Valen,');
    expect(text).toContain('VA360 Academy');
  });
});
