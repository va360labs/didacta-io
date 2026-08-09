import { describe, expect, it } from 'vitest';
import {
  allKnownTemplateKeys,
  applyEmailOverride,
  buildEmailTemplateCatalog,
  emailGreeting,
  fetchEmailOverride,
  interpolate,
  resolveFixedEmailCopy,
  resolveHubDefault,
  resolveRecipientLocale,
  resolveSmtpSettingsPing,
  resolveTransactionalDefault,
  toHubTemplateLang,
  FIXED_EMAIL_COPY,
  HUB_DEFAULT_LOCALE,
  HUB_TEMPLATE_DEFAULTS,
  HUB_TEMPLATE_DEFAULTS_EN,
  HUB_TEMPLATE_LANGS,
  SMTP_SETTINGS_PING,
  TRANSACTIONAL_EMAIL_DEFS,
  TRANSACTIONAL_TEMPLATE_DEFAULTS_EN,
  type FixedEmailCopyKey,
  type TemplateOverridePrisma,
} from '../src/modules/notifications/email-template-catalog';
import {
  buildDecisionEmail,
  buildOtpEmail,
  buildRejectionEmail,
  buildWelcomeEmail,
} from '../src/modules/member-registration/email-templates';
import type { EmailBranding } from '../src/common/branded-email';

// ============================================================================
// Catálogo único de plantillas de email (alpha.83): interpolación compartida,
// resolución de overrides transaccionales y contrato del catálogo que consume
// la UI /admin/emails. Además: los builders de inscripción con override deben
// respetar las partes ESTRUCTURALES (código OTP, botones de decisión, CTA).
// ============================================================================

function branding(tenantName = 'Academia Demo'): EmailBranding {
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
      { name: 'Ana', tenantName: 'Academia Demo' },
      'fallback',
    );
    expect(out.subject).toBe('Hola Ana');
    expect(out.bodyText).toBe('Bienvenido a Academia Demo');
  });

  it('usa el subject por defecto si el override no lo define', () => {
    const out = applyEmailOverride({ subject: null, body: 'Cuerpo' }, {}, 'Asunto por defecto');
    expect(out.subject).toBe('Asunto por defecto');
    const blank = applyEmailOverride({ subject: '   ', body: 'Cuerpo' }, {}, 'Asunto por defecto');
    expect(blank.subject).toBe('Asunto por defecto');
  });
});

describe('catálogo del hub por idioma', () => {
  /** Placeholders `{{var}}`, `{{#var}}` y `{{^var}}` que usa una plantilla. */
  function placeholders(def: { subject: string | null; body: string }): string[] {
    const text = `${def.subject ?? ''}\n${def.body}`;
    return [...text.matchAll(/\{\{[#^/]?\s*(\w+)\s*\}\}/g)].map((m) => m[1] as string).sort();
  }

  it('el inglés cubre exactamente las mismas keys que el español', () => {
    expect(Object.keys(HUB_TEMPLATE_DEFAULTS_EN).sort()).toEqual(
      Object.keys(HUB_TEMPLATE_DEFAULTS).sort(),
    );
  });

  it('cada traducción conserva los placeholders del español', () => {
    for (const [key, es] of Object.entries(HUB_TEMPLATE_DEFAULTS)) {
      const en = HUB_TEMPLATE_DEFAULTS_EN[key];
      expect(en, `falta la traducción de ${key}`).toBeDefined();
      expect(placeholders(en as typeof es), `${key} cambia los placeholders`).toEqual(
        placeholders(es),
      );
      // Un subject nulo (sin asunto) tiene que serlo en los dos idiomas.
      expect(en?.subject === null, `${key} difiere en si tiene asunto`).toBe(es.subject === null);
      expect((en?.body ?? '').length, `${key} tiene cuerpo vacío en inglés`).toBeGreaterThan(0);
    }
  });

  it('toHubTemplateLang normaliza variantes regionales y mayúsculas', () => {
    expect(toHubTemplateLang('en-US')).toBe('en');
    expect(toHubTemplateLang('EN')).toBe('en');
    expect(toHubTemplateLang('en_GB')).toBe('en');
    expect(toHubTemplateLang('es-AR')).toBe('es');
    expect(toHubTemplateLang(HUB_DEFAULT_LOCALE)).toBe('es');
  });

  it('un locale desconocido, vacío o nulo cae al español DELIBERADAMENTE', () => {
    // pt-BR es alcanzable hoy: me.controller.ts lo admite pero no está traducido.
    for (const locale of ['pt-BR', 'zz', '', '   ', null, undefined]) {
      expect(toHubTemplateLang(locale)).toBe('es');
      expect(resolveHubDefault('enrollment.created', locale)).toEqual(
        HUB_TEMPLATE_DEFAULTS['enrollment.created'],
      );
    }
  });

  it('resolveHubDefault devuelve el copy del idioma pedido', () => {
    expect(resolveHubDefault('enrollment.created', 'en-US')).toEqual(
      HUB_TEMPLATE_DEFAULTS_EN['enrollment.created'],
    );
    expect(resolveHubDefault('enrollment.created', 'es-ES')).toEqual(
      HUB_TEMPLATE_DEFAULTS['enrollment.created'],
    );
  });

  it('resolveHubDefault sólo devuelve undefined si la key no existe', () => {
    expect(resolveHubDefault('no.existe', 'en-US')).toBeUndefined();
    expect(resolveHubDefault('no.existe')).toBeUndefined();
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

  /** Prisma que registra cada locale consultado y devuelve fila solo para `hit`. */
  function prismaSpy(hit?: string): { prisma: TemplateOverridePrisma; seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      prisma: {
        notificationTemplate: {
          findUnique: (args: unknown) => {
            const where = (args as { where: { tenantId_key_channel_locale: { locale: string } } })
              .where.tenantId_key_channel_locale;
            seen.push(where.locale);
            return Promise.resolve(
              where.locale === hit ? { subject: `S:${hit}`, body: `B:${hit}` } : null,
            );
          },
        },
      },
    };
  }

  it('sin locale busca SOLO el de referencia: una consulta, comportamiento previo', async () => {
    const { prisma, seen } = prismaSpy();
    await fetchEmailOverride(prisma, 't1', 'auth.password_reset');
    expect(seen).toEqual([HUB_DEFAULT_LOCALE]);
  });

  it('con locale busca el pedido y CAE al de referencia, como el hub', async () => {
    const { prisma, seen } = prismaSpy();
    await fetchEmailOverride(prisma, 't1', 'auth.password_reset', 'en-US');
    expect(seen).toEqual(['en-US', HUB_DEFAULT_LOCALE]);
  });

  it('si el tenant personalizó el idioma pedido, ese gana y no hay 2ª consulta', async () => {
    const { prisma, seen } = prismaSpy('en-US');
    await expect(fetchEmailOverride(prisma, 't1', 'auth.password_reset', 'en-US')).resolves.toEqual(
      {
        subject: 'S:en-US',
        body: 'B:en-US',
      },
    );
    expect(seen).toEqual(['en-US']);
  });

  it('el override en español gana al default inglés del producto (regla del hub)', async () => {
    // Lo que el tenant escribió a mano pesa más que nuestra traducción: es la
    // MISMA precedencia que `renderForTenant`, no una regla nueva.
    const { prisma } = prismaSpy(HUB_DEFAULT_LOCALE);
    await expect(fetchEmailOverride(prisma, 't1', 'auth.password_reset', 'en-US')).resolves.toEqual(
      {
        subject: `S:${HUB_DEFAULT_LOCALE}`,
        body: `B:${HUB_DEFAULT_LOCALE}`,
      },
    );
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

  it('sin locale devuelve byte a byte lo de antes (idioma de referencia)', () => {
    // El endpoint `/catalog` se llamaba sin locale y así lo siguen llamando los
    // clientes viejos: la respuesta no puede moverse ni un byte.
    expect(buildEmailTemplateCatalog()).toEqual(buildEmailTemplateCatalog('es-ES'));
  });

  it('con locale en-US el prefill del editor sale en inglés, no en español', () => {
    // El bug: `/admin/emails` deja elegir el idioma del override y prefilleaba
    // SIEMPRE el copy español, así que crear un override en-US empezaba
    // borrando un texto español.
    const en = buildEmailTemplateCatalog('en-US');
    const es = buildEmailTemplateCatalog('es-ES');
    const distintos = en.filter((e) => {
      const par = es.find((x) => x.key === e.key)!;
      return par.defaultBody !== e.defaultBody;
    });
    // El hub está traducido entero; los transaccionales, parcialmente.
    expect(distintos.length).toBeGreaterThan(20);
    const reset = en.find((e) => e.key === 'auth.password_reset');
    expect(reset?.defaultBody).not.toBe(
      es.find((e) => e.key === 'auth.password_reset')?.defaultBody,
    );
  });

  it('CAMINO DEGRADADO: locale sin catálogo (pt-BR) devuelve el español, nunca vacío', () => {
    const pt = buildEmailTemplateCatalog('pt-BR');
    expect(pt).toEqual(buildEmailTemplateCatalog('es-ES'));
    for (const entry of pt) expect(entry.defaultBody.length, entry.key).toBeGreaterThan(0);
  });

  it('el idioma NO cambia el conjunto de keys ni los metadatos', () => {
    const en = buildEmailTemplateCatalog('en-US');
    const es = buildEmailTemplateCatalog('es-ES');
    expect(en.map((e) => e.key)).toEqual(es.map((e) => e.key));
    // `name`/`description` siguen solo en español a propósito (hueco conocido):
    // si alguien los traduce, este test le recuerda que hay que revisarlo.
    expect(en.map((e) => e.name)).toEqual(es.map((e) => e.name));
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

// ============================================================================
// Copy transaccional por idioma (MUST-FIX 38: composer y catálogo se tocan a
// la vez). El inglés de un transaccional se RENDERIZA desde el catálogo, así
// que estos asserts son los que impiden que composer y catálogo divergan.
// ============================================================================
describe('catálogo transaccional por idioma', () => {
  /** Placeholders `{{var}}`, `{{#var}}` y `{{^var}}` que usa una plantilla. */
  function placeholders(def: { subject: string | null; body: string }): string[] {
    const text = `${def.subject ?? ''}\n${def.body}`;
    return [...text.matchAll(/\{\{[#^/]?\s*(\w+)\s*\}\}/g)].map((m) => m[1] as string).sort();
  }

  const esByKey = new Map(
    TRANSACTIONAL_EMAIL_DEFS.map((d) => [
      d.key,
      { subject: d.defaultSubject, body: d.defaultBody },
    ]),
  );

  it('toda key traducida al inglés existe en el catálogo transaccional', () => {
    for (const key of Object.keys(TRANSACTIONAL_TEMPLATE_DEFAULTS_EN)) {
      expect(esByKey.has(key), `${key} traducido pero sin entrada transaccional`).toBe(true);
    }
  });

  it('cada traducción conserva los placeholders y la presencia de asunto', () => {
    for (const [key, en] of Object.entries(TRANSACTIONAL_TEMPLATE_DEFAULTS_EN)) {
      const es = esByKey.get(key)!;
      expect(placeholders(en), `${key} cambia los placeholders`).toEqual(placeholders(es));
      expect(en.subject === null, `${key} difiere en si tiene asunto`).toBe(es.subject === null);
      expect(en.body.length, `${key} tiene cuerpo vacío en inglés`).toBeGreaterThan(0);
    }
  });

  it('el inglés declara solo variables que el catálogo documenta', () => {
    for (const [key, en] of Object.entries(TRANSACTIONAL_TEMPLATE_DEFAULTS_EN)) {
      const declared = new Set(
        TRANSACTIONAL_EMAIL_DEFS.find((d) => d.key === key)!.variables.map((v) => v.name),
      );
      const used = [...`${en.subject ?? ''}\n${en.body}`.matchAll(/\{\{[#^]?\s*(\w+)\s*\}\}/g)].map(
        (m) => m[1] as string,
      );
      for (const name of used) {
        expect(declared.has(name), `${key} usa {{${name}}} sin declararla`).toBe(true);
      }
    }
  });

  it('resolveTransactionalDefault devuelve el idioma pedido', () => {
    expect(resolveTransactionalDefault('auth.password_reset', 'en-US')).toEqual(
      TRANSACTIONAL_TEMPLATE_DEFAULTS_EN['auth.password_reset'],
    );
    expect(resolveTransactionalDefault('auth.password_reset', 'es-ES')).toEqual(
      esByKey.get('auth.password_reset'),
    );
  });

  it('CAMINO DEGRADADO: idioma sin catálogo o key sin traducir → español', () => {
    // `pt-BR` es alcanzable HOY (ALLOWED_LOCALES en me.controller.ts).
    for (const locale of ['pt-BR', 'zz', '', '   ', null, undefined]) {
      expect(resolveTransactionalDefault('auth.password_reset', locale)).toEqual(
        esByKey.get('auth.password_reset'),
      );
    }
    // Key con composer aún monolingüe: en inglés devuelve el español, nunca
    // undefined ni un cuerpo vacío.
    expect(TRANSACTIONAL_TEMPLATE_DEFAULTS_EN['subscriptions.admin_digest']).toBeUndefined();
    expect(resolveTransactionalDefault('subscriptions.admin_digest', 'en-US')).toEqual(
      esByKey.get('subscriptions.admin_digest'),
    );
  });

  it('una key inexistente sigue devolviendo undefined en los dos idiomas', () => {
    expect(resolveTransactionalDefault('no.existe', 'en-US')).toBeUndefined();
    expect(resolveTransactionalDefault('no.existe')).toBeUndefined();
  });
});

describe('copy fijo de emails (CTA, títulos, rellenos)', () => {
  it('los dos idiomas cubren exactamente las mismas keys y ninguna está vacía', () => {
    const esKeys = Object.keys(FIXED_EMAIL_COPY.es).sort();
    expect(Object.keys(FIXED_EMAIL_COPY.en).sort()).toEqual(esKeys);
    for (const lang of HUB_TEMPLATE_LANGS) {
      for (const [key, value] of Object.entries(FIXED_EMAIL_COPY[lang])) {
        expect(value.trim().length, `${lang}.${key} vacío`).toBeGreaterThan(0);
      }
    }
  });

  it('ninguna etiqueta inglesa se quedó en español (era el bug: cuerpo EN, botón ES)', () => {
    for (const key of Object.keys(FIXED_EMAIL_COPY.es) as FixedEmailCopyKey[]) {
      expect(FIXED_EMAIL_COPY.en[key], `${key} sin traducir`).not.toBe(FIXED_EMAIL_COPY.es[key]);
    }
  });

  it('los dos idiomas declaran los MISMOS placeholders en cada copy fijo', () => {
    // `cta.hub_enter` y `footer.hub_member` llevan `{{tenantName}}`: si una
    // traducción lo pierde, el email sale sin el nombre de la plataforma y
    // nadie lo ve hasta que un miembro anglófono recibe «Go to ».
    const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(FIXED_EMAIL_COPY.es) as FixedEmailCopyKey[]) {
      expect(vars(FIXED_EMAIL_COPY.en[key]), `${key}: placeholders distintos`).toEqual(
        vars(FIXED_EMAIL_COPY.es[key]),
      );
    }
  });

  it('resolveFixedEmailCopy devuelve el idioma pedido y degrada al español', () => {
    expect(resolveFixedEmailCopy('cta.password_reset', 'en-US')).toBe('Reset password');
    expect(resolveFixedEmailCopy('cta.password_reset', 'es-ES')).toBe('Restablecer contraseña');
    for (const locale of ['pt-BR', '', null, undefined]) {
      expect(resolveFixedEmailCopy('cta.set_password', locale)).toBe('Define tu contraseña');
    }
  });
});

describe('emailGreeting', () => {
  it('saluda en el idioma del destinatario, con y sin nombre', () => {
    expect(emailGreeting('Ana', 'es-ES')).toBe('Hola Ana,');
    expect(emailGreeting(null, 'es-ES')).toBe('Hola,');
    expect(emailGreeting('Ana', 'en-US')).toBe('Hi Ana,');
    expect(emailGreeting(null, 'en-US')).toBe('Hi,');
  });

  it('CAMINO DEGRADADO: idioma sin catálogo → español', () => {
    for (const locale of ['pt-BR', '', '  ', null, undefined]) {
      expect(emailGreeting('Ana', locale)).toBe('Hola Ana,');
    }
  });
});

describe('resolveRecipientLocale', () => {
  it('devuelve el locale guardado tal cual, incluso si no está traducido', () => {
    expect(resolveRecipientLocale('en-US')).toBe('en-US');
    expect(resolveRecipientLocale('es-AR')).toBe('es-AR');
    // pt-BR NO se aplana aquí: así un override per-tenant en pt-BR puede ganar.
    expect(resolveRecipientLocale('pt-BR')).toBe('pt-BR');
    expect(toHubTemplateLang(resolveRecipientLocale('pt-BR'))).toBe('es');
  });

  it('CAMINO DEGRADADO: locale vacío, en blanco, null o undefined → el de referencia', () => {
    for (const stored of ['', '   ', null, undefined]) {
      expect(resolveRecipientLocale(stored)).toBe(HUB_DEFAULT_LOCALE);
    }
  });
});

describe('ping de SMTP de /tenant-settings', () => {
  it('tiene asunto y cuerpo en los dos idiomas, con los mismos placeholders', () => {
    for (const lang of HUB_TEMPLATE_LANGS) {
      const def = SMTP_SETTINGS_PING[lang];
      expect(def.subject?.length, lang).toBeGreaterThan(0);
      expect(def.body).toContain('{{tenantSlug}}');
      expect(def.body).toContain('{{timestamp}}');
    }
    expect(SMTP_SETTINGS_PING.en.body).not.toBe(SMTP_SETTINGS_PING.es.body);
  });

  it('el español no cambia byte a byte y el inglés sale en inglés', () => {
    const vars = { tenantSlug: 'demo', timestamp: '2026-08-09T10:00:00.000Z' };
    const es = resolveSmtpSettingsPing('es-ES');
    expect(es.subject).toBe('Prueba de SMTP — Didacta');
    expect(interpolate(es.body, vars)).toBe(
      'Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\nTenant: demo\nFecha: 2026-08-09T10:00:00.000Z',
    );
    const en = resolveSmtpSettingsPing('en-US');
    expect(en.subject).toBe('SMTP test — Didacta');
    expect(interpolate(en.body, vars)).toContain('is working correctly');
  });

  it('CAMINO DEGRADADO: idioma sin catálogo → español', () => {
    for (const locale of ['pt-BR', '', null, undefined]) {
      expect(resolveSmtpSettingsPing(locale)).toEqual(SMTP_SETTINGS_PING.es);
    }
  });
});

describe('builders de inscripción con override', () => {
  it('buildOtpEmail respeta el código como parte estructural', () => {
    const out = buildOtpEmail('482913', branding(), {
      subject: 'Tu código de {{tenantName}}',
      body: 'Este es tu código para entrar.',
    });
    expect(out.subject).toBe('Tu código de Academia Demo');
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
    expect(out.text).toContain('Intro personalizada para Academia Demo.');
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
    expect(out.subject).toBe('Sobre tu inscripción en Academia Demo');
    expect(out.text).toContain('Lo sentimos Ana, esta vez no.');
  });

  it('sin override, los builders mantienen el copy por defecto (regresión)', () => {
    const otp = buildOtpEmail('111222', branding());
    expect(otp.subject).toBe('Tu código de acceso');
    const welcome = buildWelcomeEmail('Ana', 'https://x/signin', branding());
    expect(welcome.subject).toBe('Tu inscripción en Academia Demo ha sido aprobada');
    const rejection = buildRejectionEmail('Ana', branding());
    expect(rejection.text).toContain('Gracias por tu interés en Academia Demo');
  });
});
