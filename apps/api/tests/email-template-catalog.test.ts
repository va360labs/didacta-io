import { describe, expect, it } from 'vitest';
import {
  allKnownTemplateKeys,
  applyEmailOverride,
  buildEmailTemplateCatalog,
  fetchEmailOverride,
  interpolate,
  HUB_TEMPLATE_DEFAULTS,
  TRANSACTIONAL_EMAIL_DEFS,
  type TemplateOverridePrisma,
} from '../src/modules/notifications/email-template-catalog';
import {
  buildDecisionEmail,
  buildOtpEmail,
  buildRejectionEmail,
  buildWelcomeEmail,
} from '../src/inscripcion/email-templates';
import type { EmailBranding } from '../src/common/branded-email';

// ============================================================================
// Catálogo único de plantillas de email (alpha.83): interpolación compartida,
// resolución de overrides transaccionales y contrato del catálogo que consume
// la UI /admin/emails. Además: los builders de inscripción con override deben
// respetar las partes ESTRUCTURALES (código OTP, botones de decisión, CTA).
// ============================================================================

function branding(tenantName = 'VA360.pro'): EmailBranding {
  return { tenantName, logoUrl: null, brandColor: '#1E5AA8' };
}

/** Prisma mínimo: devuelve el override fijado o lanza, según el modo. */
function prismaWithOverride(
  row: { subject: string | null; body: string } | null,
  opts: { throws?: boolean } = {},
): TemplateOverridePrisma {
  return {
    notificationTemplate: {
      findUnique: () => {
        if (opts.throws) return Promise.reject(new Error('db down'));
        return Promise.resolve(row);
      },
    },
  };
}

describe('interpolate', () => {
  it('reemplaza variables simples y deja vacías las no resueltas', () => {
    expect(interpolate('Hola {{name}}, bienvenido a {{tenantName}}', { name: 'Ana' })).toBe(
      'Hola Ana, bienvenido a ',
    );
  });

  it('resuelve secciones condicionales {{#var}} y {{^var}}', () => {
    const tpl = '{{#plan}}Plan: {{plan}}.{{/plan}}{{^plan}}Sin plan.{{/plan}}';
    expect(interpolate(tpl, { plan: 'Mensual' })).toBe('Plan: Mensual.');
    expect(interpolate(tpl, { plan: '' })).toBe('Sin plan.');
  });
});

describe('applyEmailOverride', () => {
  it('interpola subject y body del override', () => {
    const out = applyEmailOverride(
      { subject: 'Hola {{name}}', body: 'Bienvenido a {{tenantName}}' },
      { name: 'Ana', tenantName: 'VA360.pro' },
      'fallback',
    );
    expect(out.subject).toBe('Hola Ana');
    expect(out.bodyText).toBe('Bienvenido a VA360.pro');
  });

  it('usa el subject por defecto si el override no lo define', () => {
    const out = applyEmailOverride({ subject: null, body: 'Cuerpo' }, {}, 'Asunto por defecto');
    expect(out.subject).toBe('Asunto por defecto');
    const blank = applyEmailOverride({ subject: '   ', body: 'Cuerpo' }, {}, 'Asunto por defecto');
    expect(blank.subject).toBe('Asunto por defecto');
  });
});

describe('fetchEmailOverride', () => {
  it('devuelve el override cuando existe', async () => {
    const prisma = prismaWithOverride({ subject: 'S', body: 'B' });
    await expect(fetchEmailOverride(prisma, 't1', 'auth.password_reset')).resolves.toEqual({
      subject: 'S',
      body: 'B',
    });
  });

  it('devuelve null si no hay override', async () => {
    const prisma = prismaWithOverride(null);
    await expect(fetchEmailOverride(prisma, 't1', 'auth.password_reset')).resolves.toBeNull();
  });

  it('nunca lanza: un fallo de BD devuelve null (el email sale con el default)', async () => {
    const prisma = prismaWithOverride(null, { throws: true });
    await expect(fetchEmailOverride(prisma, 't1', 'auth.password_reset')).resolves.toBeNull();
  });
});

describe('buildEmailTemplateCatalog', () => {
  it('incluye todas las keys transaccionales y todas las del hub, sin duplicados', () => {
    const keys = allKnownTemplateKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of TRANSACTIONAL_EMAIL_DEFS) expect(keys).toContain(def.key);
    for (const hubKey of Object.keys(HUB_TEMPLATE_DEFAULTS)) expect(keys).toContain(hubKey);
  });

  it('toda entrada tiene nombre humano, descripción, body por defecto y variables', () => {
    for (const entry of buildEmailTemplateCatalog()) {
      expect(entry.name.length, entry.key).toBeGreaterThan(0);
      expect(entry.defaultBody.length, entry.key).toBeGreaterThan(0);
      expect(entry.channels.length, entry.key).toBeGreaterThan(0);
      // community.broadcast es passthrough puro; el resto documenta variables.
      if (entry.key !== 'community.broadcast') {
        expect(entry.variables.length, entry.key).toBeGreaterThan(0);
      }
    }
  });

  it('los transaccionales declaran las variables que usan sus defaults', () => {
    for (const def of TRANSACTIONAL_EMAIL_DEFS) {
      const declared = new Set(def.variables.map((v) => v.name));
      const used = [
        ...`${def.defaultSubject ?? ''}\n${def.defaultBody}`.matchAll(/\{\{[#^]?\s*(\w+)\s*\}\}/g),
      ].map((m) => m[1] as string);
      for (const name of used) {
        expect(declared.has(name), `${def.key} usa {{${name}}} sin declararla`).toBe(true);
      }
    }
  });
});

describe('builders de inscripción con override', () => {
  it('buildOtpEmail respeta el código como parte estructural', () => {
    const out = buildOtpEmail('482913', branding(), {
      subject: 'Tu código de {{tenantName}}',
      body: 'Este es tu código para entrar.',
    });
    expect(out.subject).toBe('Tu código de VA360.pro');
    expect(out.text).toContain('482913');
    expect(out.html).toContain('482913');
    expect(out.html).toContain('Este es tu código para entrar.');
  });

  it('buildOtpEmail no duplica el código si el admin usa {{code}}', () => {
    const out = buildOtpEmail('482913', branding(), {
      subject: null,
      body: 'Código: {{code}}',
    });
    expect(out.text.match(/482913/g)?.length).toBe(1);
  });

  it('buildDecisionEmail con override mantiene los botones Aprobar/Rechazar y los datos', () => {
    const out = buildDecisionEmail(
      {
        name: 'Ana',
        email: 'ana@example.test',
        telegramId: '42',
        inGroup: 'true',
        isDelinquent: false,
        approveUrl: 'https://x/approve?t=AAA',
        rejectUrl: 'https://x/reject?t=BBB',
        branding: branding(),
      },
      { subject: 'Solicitud de {{name}}', body: 'Intro personalizada para {{tenantName}}.' },
    );
    expect(out.subject).toBe('Solicitud de Ana');
    expect(out.text).toContain('Intro personalizada para VA360.pro.');
    expect(out.text).toContain('https://x/approve?t=AAA');
    expect(out.text).toContain('https://x/reject?t=BBB');
    expect(out.html).toContain('https://x/approve?t=AAA');
    expect(out.text).toContain('ana@example.test');
  });

  it('buildWelcomeEmail con override mantiene el CTA Entrar', () => {
    const out = buildWelcomeEmail('Ana', 'https://x/signin', branding(), {
      subject: '¡Dentro, {{name}}!',
      body: '{{greeting}} Ya puedes entrar.',
    });
    expect(out.subject).toBe('¡Dentro, Ana!');
    expect(out.text).toContain('Hola Ana, Ya puedes entrar.');
    expect(out.text).toContain('https://x/signin');
  });

  it('buildRejectionEmail con override usa el texto del admin', () => {
    const out = buildRejectionEmail('Ana', branding(), {
      subject: null,
      body: 'Lo sentimos {{name}}, esta vez no.',
    });
    expect(out.subject).toBe('Sobre tu inscripción en VA360.pro');
    expect(out.text).toContain('Lo sentimos Ana, esta vez no.');
  });

  it('sin override, los builders mantienen el copy por defecto (regresión)', () => {
    const otp = buildOtpEmail('111222', branding());
    expect(otp.subject).toBe('Tu código de acceso');
    const welcome = buildWelcomeEmail('Ana', 'https://x/signin', branding());
    expect(welcome.subject).toBe('Tu inscripción en VA360.pro ha sido aprobada');
    const rejection = buildRejectionEmail('Ana', branding());
    expect(rejection.text).toContain('Gracias por tu interés en VA360.pro');
  });
});
