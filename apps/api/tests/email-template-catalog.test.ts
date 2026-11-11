import { describe, expect, it } from 'vitest';
import {
  allKnownTemplateKeys,
  applyEmailOverride,
  buildEmailTemplateCatalog,
  emailGreeting,
  fetchEmailOverride,
  interpolate,
  emailDateLocale,
  resolveFixedEmailCopy,
  resolveHubDefault,
  resolveInvitationEmailCopy,
  resolveRecipientLocale,
  resolveSmtpSettingsPing,
  resolveTransactionalDefault,
  toHubTemplateLang,
  FIXED_EMAIL_COPY,
  HUB_DEFAULT_LOCALE,
  HUB_TEMPLATE_DEFAULTS,
  HUB_TEMPLATE_DEFAULTS_BY_LOCALE,
  HUB_TEMPLATE_DEFAULTS_EN,
  HUB_TEMPLATE_DEFAULTS_PT,
  HUB_TEMPLATE_LANGS,
  INVITATION_EMAIL_COPY,
  SMTP_SETTINGS_PING,
  TRANSACTIONAL_EMAIL_DEFS,
  TRANSACTIONAL_TEMPLATE_DEFAULTS_EN,
  TRANSACTIONAL_TEMPLATE_DEFAULTS_PT,
  rendersFromCatalog,
  type FixedEmailCopyKey,
  type HubTemplateLang,
  type TemplateDef,
  type TemplateOverridePrisma,
} from '../src/modules/notifications/email-template-catalog';
import {
  buildDecisionEmail,
  buildOtpEmail,
  buildRejectionEmail,
  buildWelcomeEmail,
  type DecisionEmailParams,
} from '../src/modules/member-registration/email-templates';
import {
  classifySubscriptionStatus,
  type MemberSubscriptionMatch,
} from '@didacta/mod-payment-connections';
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

/**
 * Los idiomas TRADUCIDOS (todo lo que no es el de referencia). Los tests de
 * coherencia de abajo recorren esta lista en vez de nombrar el inglés: así el
 * portugués pasa por las mismas aserciones, y un idioma nuevo también.
 */
const TRANSLATED_LANGS = HUB_TEMPLATE_LANGS.filter(
  (l): l is Exclude<HubTemplateLang, 'es'> => l !== 'es',
);

/** Un locale COMPLETO de cada idioma traducido, como lo guarda `user.locale`. */
const LOCALE_OF: Record<Exclude<HubTemplateLang, 'es'>, string> = { en: 'en-US', pt: 'pt-BR' };

/**
 * Locales SIN catálogo, para los caminos degradados. `fr-FR` es el caso real
 * (llega por SCIM, que copia el locale del IdP sin validar). Antes este papel
 * lo hacía `pt-BR`, cuando era guardable y no estaba traducido.
 */
const SIN_CATALOGO = ['fr-FR', 'zz', '', '   '] as const;

describe('idiomas del catálogo', () => {
  it('son exactamente español, inglés y portugués', () => {
    // Si alguien añade un idioma, este test se actualiza A CONCIENCIA: es el
    // recordatorio de que `ALLOWED_LOCALES` (me.controller) y los catálogos de
    // la web tienen que ir a la vez.
    expect([...HUB_TEMPLATE_LANGS]).toEqual(['es', 'en', 'pt']);
    expect([...TRANSLATED_LANGS]).toEqual(['en', 'pt']);
  });

  it('solo el español conserva la maqueta propia del composer', () => {
    expect(rendersFromCatalog('es-ES')).toBe(false);
    expect(rendersFromCatalog('es-AR')).toBe(false);
    expect(rendersFromCatalog('en-US')).toBe(true);
    expect(rendersFromCatalog('pt-BR')).toBe(true);
    // Un locale sin catálogo cae al español, y con él a su maqueta.
    for (const locale of [...SIN_CATALOGO, null, undefined]) {
      expect(rendersFromCatalog(locale), String(locale)).toBe(false);
    }
  });
});

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

  it.each(TRANSLATED_LANGS)('%s cubre exactamente las mismas keys que el español', (lang) => {
    expect(Object.keys(HUB_TEMPLATE_DEFAULTS_BY_LOCALE[lang]).sort()).toEqual(
      Object.keys(HUB_TEMPLATE_DEFAULTS).sort(),
    );
  });

  it.each(TRANSLATED_LANGS)('%s conserva los placeholders del español', (lang) => {
    for (const [key, es] of Object.entries(HUB_TEMPLATE_DEFAULTS)) {
      const translated = HUB_TEMPLATE_DEFAULTS_BY_LOCALE[lang][key];
      expect(translated, `falta la traducción de ${key}`).toBeDefined();
      expect(placeholders(translated as TemplateDef), `${key} cambia los placeholders`).toEqual(
        placeholders(es),
      );
      // Un subject nulo (sin asunto) tiene que serlo en todos los idiomas.
      expect(translated?.subject === null, `${key} difiere en si tiene asunto`).toBe(
        es.subject === null,
      );
      expect((translated?.body ?? '').length, `${key} tiene cuerpo vacío`).toBeGreaterThan(0);
    }
  });

  it.each(TRANSLATED_LANGS)('%s no es el español copiado: cada plantilla difiere', (lang) => {
    // Los placeholders iguales no prueban que haya traducción: el español
    // pegado tal cual los conserva todos. Para el portugués esto NO es
    // redundante —se parece lo bastante como para que una frase sin traducir
    // pase por buena a simple vista—.
    const PASSTHROUGH = new Set(['gamification.perk.handled']); // solo `{{vars}}`, sin copy.
    for (const [key, es] of Object.entries(HUB_TEMPLATE_DEFAULTS)) {
      if (PASSTHROUGH.has(key)) continue;
      expect(HUB_TEMPLATE_DEFAULTS_BY_LOCALE[lang][key]?.body, `${key} sin traducir`).not.toBe(
        es.body,
      );
    }
  });

  it('el portugués no hereda frases del inglés ni del español', () => {
    const pt = HUB_TEMPLATE_DEFAULTS_PT['enrollment.created'];
    expect(pt?.subject).toBe('Você se matriculou em {{course}}');
    expect(pt?.subject).not.toBe(HUB_TEMPLATE_DEFAULTS_EN['enrollment.created']?.subject);
    expect(pt?.subject).not.toBe(HUB_TEMPLATE_DEFAULTS['enrollment.created']?.subject);
  });

  it('toHubTemplateLang normaliza variantes regionales y mayúsculas', () => {
    expect(toHubTemplateLang('en-US')).toBe('en');
    expect(toHubTemplateLang('EN')).toBe('en');
    expect(toHubTemplateLang('en_GB')).toBe('en');
    expect(toHubTemplateLang('es-AR')).toBe('es');
    expect(toHubTemplateLang(HUB_DEFAULT_LOCALE)).toBe('es');
    expect(toHubTemplateLang('pt-BR')).toBe('pt');
    expect(toHubTemplateLang('PT')).toBe('pt');
    expect(toHubTemplateLang('pt_br')).toBe('pt');
    // El portugués europeo (solo llega por SCIM) usa el catálogo `pt`: es
    // brasileño, pero servirle español teniendo portugués sería peor.
    expect(toHubTemplateLang('pt-PT')).toBe('pt');
  });

  it('un locale desconocido, vacío o nulo cae al español DELIBERADAMENTE', () => {
    // `fr-FR` es alcanzable por SCIM, que copia el locale del IdP sin validar.
    for (const locale of [...SIN_CATALOGO, null, undefined]) {
      expect(toHubTemplateLang(locale)).toBe('es');
      expect(resolveHubDefault('enrollment.created', locale)).toEqual(
        HUB_TEMPLATE_DEFAULTS['enrollment.created'],
      );
    }
  });

  it('pt-BR YA NO cae al español (era el camino degradado mientras no tuvo catálogo)', () => {
    expect(toHubTemplateLang('pt-BR')).not.toBe('es');
    expect(resolveHubDefault('enrollment.created', 'pt-BR')).not.toEqual(
      HUB_TEMPLATE_DEFAULTS['enrollment.created'],
    );
  });

  it('resolveHubDefault devuelve el copy del idioma pedido', () => {
    expect(resolveHubDefault('enrollment.created', 'en-US')).toEqual(
      HUB_TEMPLATE_DEFAULTS_EN['enrollment.created'],
    );
    expect(resolveHubDefault('enrollment.created', 'pt-BR')).toEqual(
      HUB_TEMPLATE_DEFAULTS_PT['enrollment.created'],
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

  it('con locale pt-BR el prefill del editor sale en portugués, no en español ni en inglés', () => {
    // Mismo bug que el de arriba, un idioma después: el admin brasileño que
    // crea un override `pt-BR` tiene que partir de un texto en portugués.
    const pt = buildEmailTemplateCatalog('pt-BR');
    const es = buildEmailTemplateCatalog('es-ES');
    const en = buildEmailTemplateCatalog('en-US');
    const igualesAlEspanol = pt.filter(
      (e) => es.find((x) => x.key === e.key)!.defaultBody === e.defaultBody,
    );
    // Solo el passthrough puro (`{{statusText}}…`) se escribe igual.
    expect(igualesAlEspanol.map((e) => e.key)).toEqual(['gamification.perk.handled']);
    const reset = pt.find((e) => e.key === 'auth.password_reset');
    expect(reset?.defaultSubject).toBe('Redefinir sua senha em {{tenantName}}');
    expect(reset?.defaultBody).not.toBe(en.find((e) => e.key === reset?.key)?.defaultBody);
  });

  it('CAMINO DEGRADADO: locale sin catálogo (fr-FR) devuelve el español, nunca vacío', () => {
    const fr = buildEmailTemplateCatalog('fr-FR');
    expect(fr).toEqual(buildEmailTemplateCatalog('es-ES'));
    for (const entry of fr) expect(entry.defaultBody.length, entry.key).toBeGreaterThan(0);
  });

  it('el idioma NO cambia el conjunto de keys ni los metadatos', () => {
    const es = buildEmailTemplateCatalog('es-ES');
    for (const lang of TRANSLATED_LANGS) {
      const translated = buildEmailTemplateCatalog(LOCALE_OF[lang]);
      expect(
        translated.map((e) => e.key),
        lang,
      ).toEqual(es.map((e) => e.key));
      // `name`/`description` siguen solo en español a propósito (hueco conocido):
      // si alguien los traduce, este test le recuerda que hay que revisarlo.
      expect(
        translated.map((e) => e.name),
        lang,
      ).toEqual(es.map((e) => e.name));
    }
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

  /** El mapa de cada idioma traducido, tal como lo exporta el catálogo. */
  const TRANSLATED_MAPS: Record<Exclude<HubTemplateLang, 'es'>, Record<string, TemplateDef>> = {
    en: TRANSACTIONAL_TEMPLATE_DEFAULTS_EN,
    pt: TRANSACTIONAL_TEMPLATE_DEFAULTS_PT,
  };

  it.each(TRANSLATED_LANGS)('toda key traducida a %s existe en el catálogo', (lang) => {
    for (const key of Object.keys(TRANSLATED_MAPS[lang])) {
      expect(esByKey.has(key), `${key} traducido pero sin entrada transaccional`).toBe(true);
    }
  });

  it.each(TRANSLATED_LANGS)('%s conserva los placeholders y la presencia de asunto', (lang) => {
    for (const [key, translated] of Object.entries(TRANSLATED_MAPS[lang])) {
      const es = esByKey.get(key)!;
      expect(placeholders(translated), `${key} cambia los placeholders`).toEqual(placeholders(es));
      expect(translated.subject === null, `${key} difiere en si tiene asunto`).toBe(
        es.subject === null,
      );
      expect(translated.body.length, `${key} tiene cuerpo vacío`).toBeGreaterThan(0);
      // Y no es el español pegado: mismos placeholders, otro texto.
      expect(translated.body, `${key} sin traducir`).not.toBe(es.body);
    }
  });

  it.each(TRANSLATED_LANGS)('%s declara solo variables que el catálogo documenta', (lang) => {
    for (const [key, translated] of Object.entries(TRANSLATED_MAPS[lang])) {
      const declared = new Set(
        TRANSACTIONAL_EMAIL_DEFS.find((d) => d.key === key)!.variables.map((v) => v.name),
      );
      const used = [
        ...`${translated.subject ?? ''}\n${translated.body}`.matchAll(/\{\{[#^]?\s*(\w+)\s*\}\}/g),
      ].map((m) => m[1] as string);
      for (const name of used) {
        expect(declared.has(name), `${key} usa {{${name}}} sin declararla`).toBe(true);
      }
    }
  });

  it('resolveTransactionalDefault devuelve el idioma pedido', () => {
    expect(resolveTransactionalDefault('auth.password_reset', 'en-US')).toEqual(
      TRANSACTIONAL_TEMPLATE_DEFAULTS_EN['auth.password_reset'],
    );
    expect(resolveTransactionalDefault('auth.password_reset', 'pt-BR')).toEqual(
      TRANSACTIONAL_TEMPLATE_DEFAULTS_PT['auth.password_reset'],
    );
    expect(resolveTransactionalDefault('auth.password_reset', 'es-ES')).toEqual(
      esByKey.get('auth.password_reset'),
    );
  });

  it('CAMINO DEGRADADO: idioma sin catálogo o key sin traducir → español', () => {
    // `fr-FR` es alcanzable por SCIM (copia el locale del IdP sin validar).
    for (const locale of [...SIN_CATALOGO, null, undefined]) {
      expect(resolveTransactionalDefault('auth.password_reset', locale)).toEqual(
        esByKey.get('auth.password_reset'),
      );
    }
    // La otra mitad de la degradación —«key SIN traducir cae al español»— ya
    // NO tiene caso vivo: `member_registration.approval_request` era el último
    // y este PR lo cierra. La rama sigue en el código como red para una key
    // NUEVA, y quien la deja sin traducir lo descubre en el test de abajo
    // («cubre TODA key transaccional»), no en la bandeja de un aprobador
    // anglófono o brasileño.
    for (const lang of TRANSLATED_LANGS) {
      for (const def of TRANSACTIONAL_EMAIL_DEFS) {
        const translated = resolveTransactionalDefault(def.key, LOCALE_OF[lang]);
        expect(translated, `${def.key} sin copy en ${lang}`).toBeDefined();
        expect(translated!.body.trim().length, `${def.key} con cuerpo vacío`).toBeGreaterThan(0);
      }
    }
  });

  it.each(TRANSLATED_LANGS)('el mapa %s cubre TODA key transaccional, sin excepciones', (lang) => {
    // Historia de la guarda, porque explica su forma: primero el mapa inglés
    // era parcial con 9 huecos y solo se podía exigir «lo que esté, que sea
    // coherente»; luego quedó UNO declarado
    // (`member_registration.approval_request`, bloqueado por el copy de
    // `modules/payment-connections`); ahora no queda ninguno y la lista de
    // excepciones desaparece. El portugués nació completo y entra en la misma
    // guarda. Cualquier plantilla transaccional NUEVA que llegue sin traducir
    // rompe aquí en vez de colarse y llegarle en español a quien no lo lee.
    const huecos = TRANSACTIONAL_EMAIL_DEFS.filter((d) => !TRANSLATED_MAPS[lang][d.key]).map(
      (d) => d.key,
    );
    expect(huecos, `plantillas transaccionales sin copy ${lang}: ${huecos.join(', ')}`).toEqual([]);
  });

  it('una key inexistente sigue devolviendo undefined en todos los idiomas', () => {
    expect(resolveTransactionalDefault('no.existe', 'en-US')).toBeUndefined();
    expect(resolveTransactionalDefault('no.existe', 'pt-BR')).toBeUndefined();
    expect(resolveTransactionalDefault('no.existe')).toBeUndefined();
  });
});

describe('copy fijo de emails (CTA, títulos, rellenos)', () => {
  it('todos los idiomas cubren exactamente las mismas keys y ninguna está vacía', () => {
    const esKeys = Object.keys(FIXED_EMAIL_COPY.es).sort();
    for (const lang of TRANSLATED_LANGS) {
      expect(Object.keys(FIXED_EMAIL_COPY[lang]).sort(), lang).toEqual(esKeys);
    }
    for (const lang of HUB_TEMPLATE_LANGS) {
      for (const [key, value] of Object.entries(FIXED_EMAIL_COPY[lang])) {
        expect(value.trim().length, `${lang}.${key} vacío`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Rótulos que se escriben IGUAL que en español, por idioma. Van declarados
   * uno a uno y no como un `skip` genérico: la coincidencia tiene que ser una
   * decisión, no el síntoma de una traducción que falta.
   *
   * El portugués declara más que el inglés porque es lengua hermana: «Entrar»,
   * «Compras detectadas» o «Resultado parcial» son la misma grafía en las dos.
   * Por eso mismo su lista es la que más conviene tener cerrada: sin ella, un
   * rótulo portugués olvidado en español no se distinguiría de estos.
   */
  const IGUALES_QUE_EN_ESPANOL: Record<
    Exclude<HubTemplateLang, 'es'>,
    ReadonlySet<FixedEmailCopyKey>
  > = {
    en: new Set<FixedEmailCopyKey>([
      'label.applicant_email', // «Email» es la misma palabra en ES y EN.
      'label.applicant_telegram', // «Telegram ID» es un nombre propio + sigla.
    ]),
    pt: new Set<FixedEmailCopyKey>([
      'label.applicant_telegram', // «Telegram ID» es un nombre propio + sigla.
      'label.otp_code', // «Código».
      'cta.signin', // «Entrar».
      'decision.partial_result', // «⚠ Resultado parcial».
      'decision.purchases', // «Compras detectadas ({{count}})».
    ]),
  };

  it.each(TRANSLATED_LANGS)(
    'ninguna etiqueta de %s se quedó en español (era el bug: cuerpo traducido, botón ES)',
    (lang) => {
      const iguales = IGUALES_QUE_EN_ESPANOL[lang];
      for (const key of Object.keys(FIXED_EMAIL_COPY.es) as FixedEmailCopyKey[]) {
        if (iguales.has(key)) {
          expect(FIXED_EMAIL_COPY[lang][key], `${key} declarada igual pero difiere`).toBe(
            FIXED_EMAIL_COPY.es[key],
          );
          continue;
        }
        expect(FIXED_EMAIL_COPY[lang][key], `${key} sin traducir`).not.toBe(
          FIXED_EMAIL_COPY.es[key],
        );
      }
    },
  );

  it.each(TRANSLATED_LANGS)('%s declara los MISMOS placeholders en cada copy fijo', (lang) => {
    // `cta.hub_enter` y `footer.hub_member` llevan `{{tenantName}}`: si una
    // traducción lo pierde, el email sale sin el nombre de la plataforma y
    // nadie lo ve hasta que un miembro anglófono recibe «Go to ».
    const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(FIXED_EMAIL_COPY.es) as FixedEmailCopyKey[]) {
      expect(vars(FIXED_EMAIL_COPY[lang][key]), `${key}: placeholders distintos`).toEqual(
        vars(FIXED_EMAIL_COPY.es[key]),
      );
    }
  });

  it.each(TRANSLATED_LANGS)('%s conserva el espacio load-bearing de los sufijos', (lang) => {
    // `decision.partial_suffix` se pega detrás de otra frase: su espacio inicial
    // es parte del contrato en español y tiene que seguir en la traducción.
    for (const key of Object.keys(FIXED_EMAIL_COPY.es) as FixedEmailCopyKey[]) {
      const es = FIXED_EMAIL_COPY.es[key];
      const translated: string = FIXED_EMAIL_COPY[lang][key];
      expect(translated.startsWith(' '), `${key}: espacio inicial`).toBe(es.startsWith(' '));
      expect(translated.endsWith(' '), `${key}: espacio final`).toBe(es.endsWith(' '));
    }
  });

  it('resolveFixedEmailCopy devuelve el idioma pedido y degrada al español', () => {
    expect(resolveFixedEmailCopy('cta.password_reset', 'en-US')).toBe('Reset password');
    expect(resolveFixedEmailCopy('cta.password_reset', 'pt-BR')).toBe('Redefinir senha');
    expect(resolveFixedEmailCopy('cta.password_reset', 'es-ES')).toBe('Restablecer contraseña');
    for (const locale of ['fr-FR', '', null, undefined]) {
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
    expect(emailGreeting('Ana', 'pt-BR')).toBe('Olá, Ana!');
    expect(emailGreeting(null, 'pt-BR')).toBe('Olá!');
  });

  it('CAMINO DEGRADADO: idioma sin catálogo → español', () => {
    for (const locale of ['fr-FR', '', '  ', null, undefined]) {
      expect(emailGreeting('Ana', locale)).toBe('Hola Ana,');
    }
  });
});

describe('resolveRecipientLocale', () => {
  it('devuelve el locale guardado tal cual, incluso si no está traducido', () => {
    expect(resolveRecipientLocale('en-US')).toBe('en-US');
    expect(resolveRecipientLocale('es-AR')).toBe('es-AR');
    expect(resolveRecipientLocale('pt-BR')).toBe('pt-BR');
    expect(toHubTemplateLang(resolveRecipientLocale('pt-BR'))).toBe('pt');
    // Un locale sin catálogo NO se aplana aquí: así un override per-tenant en
    // ese locale puede ganar. Lo absorbe `toHubTemplateLang` al elegir catálogo.
    expect(resolveRecipientLocale('fr-FR')).toBe('fr-FR');
    expect(toHubTemplateLang(resolveRecipientLocale('fr-FR'))).toBe('es');
  });

  it('CAMINO DEGRADADO: locale vacío, en blanco, null o undefined → el de referencia', () => {
    for (const stored of ['', '   ', null, undefined]) {
      expect(resolveRecipientLocale(stored)).toBe(HUB_DEFAULT_LOCALE);
    }
  });
});

describe('ping de SMTP de /tenant-settings', () => {
  it('tiene asunto y cuerpo en todos los idiomas, con los mismos placeholders', () => {
    for (const lang of HUB_TEMPLATE_LANGS) {
      const def = SMTP_SETTINGS_PING[lang];
      expect(def.subject?.length, lang).toBeGreaterThan(0);
      expect(def.body).toContain('{{tenantSlug}}');
      expect(def.body).toContain('{{timestamp}}');
    }
    for (const lang of TRANSLATED_LANGS) {
      expect(SMTP_SETTINGS_PING[lang].body, lang).not.toBe(SMTP_SETTINGS_PING.es.body);
    }
    expect(SMTP_SETTINGS_PING.pt.body).not.toBe(SMTP_SETTINGS_PING.en.body);
  });

  it('el español no cambia byte a byte y cada traducción sale en su idioma', () => {
    const vars = { tenantSlug: 'demo', timestamp: '2026-08-09T10:00:00.000Z' };
    const es = resolveSmtpSettingsPing('es-ES');
    expect(es.subject).toBe('Prueba de SMTP — Didacta');
    expect(interpolate(es.body, vars)).toBe(
      'Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\nTenant: demo\nFecha: 2026-08-09T10:00:00.000Z',
    );
    const en = resolveSmtpSettingsPing('en-US');
    expect(en.subject).toBe('SMTP test — Didacta');
    expect(interpolate(en.body, vars)).toContain('is working correctly');
    const pt = resolveSmtpSettingsPing('pt-BR');
    expect(pt.subject).toBe('Teste de SMTP — Didacta');
    expect(interpolate(pt.body, vars)).toBe(
      'Se você recebeu este e-mail, a configuração SMTP do seu tenant na Didacta está funcionando corretamente.\n\nTenant: demo\nData: 2026-08-09T10:00:00.000Z',
    );
  });

  it('CAMINO DEGRADADO: idioma sin catálogo → español', () => {
    for (const locale of ['fr-FR', '', null, undefined]) {
      expect(resolveSmtpSettingsPing(locale)).toEqual(SMTP_SETTINGS_PING.es);
    }
  });
});

describe('builders de inscripción con override', () => {
  it('buildOtpEmail respeta el código como parte estructural', () => {
    const out = buildOtpEmail('482913', branding(), 'es-ES', {
      subject: 'Tu código de {{tenantName}}',
      body: 'Este es tu código para entrar.',
    });
    expect(out.subject).toBe('Tu código de Academia Demo');
    expect(out.text).toContain('482913');
    expect(out.html).toContain('482913');
    expect(out.html).toContain('Este es tu código para entrar.');
  });

  it('buildOtpEmail no duplica el código si el admin usa {{code}}', () => {
    const out = buildOtpEmail('482913', branding(), 'es-ES', {
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
      'es-ES',
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
    const out = buildWelcomeEmail('Ana', 'https://x/signin', branding(), 'es-ES', {
      subject: '¡Dentro, {{name}}!',
      body: '{{greeting}} Ya puedes entrar.',
    });
    expect(out.subject).toBe('¡Dentro, Ana!');
    expect(out.text).toContain('Hola Ana, Ya puedes entrar.');
    expect(out.text).toContain('https://x/signin');
  });

  it('buildRejectionEmail con override usa el texto del admin', () => {
    const out = buildRejectionEmail('Ana', branding(), 'es-ES', {
      subject: null,
      body: 'Lo sentimos {{name}}, esta vez no.',
    });
    expect(out.subject).toBe('Sobre tu inscripción en Academia Demo');
    expect(out.text).toContain('Lo sentimos Ana, esta vez no.');
  });

  it('sin override, los builders mantienen el copy por defecto (regresión)', () => {
    const otp = buildOtpEmail('111222', branding(), 'es-ES');
    expect(otp.subject).toBe('Tu código de acceso');
    const welcome = buildWelcomeEmail('Ana', 'https://x/signin', branding(), 'es-ES');
    expect(welcome.subject).toBe('Tu inscripción en Academia Demo ha sido aprobada');
    const rejection = buildRejectionEmail('Ana', branding(), 'es-ES');
    expect(rejection.text).toContain('Gracias por tu interés en Academia Demo');
  });
});

// ============================================================================
// Idioma del destinatario en las plantillas de mod.member-registration. Antes
// de esto, un miembro con `locale = 'en-US'` recibía el código OTP, la
// aprobación y el rechazo enteros en español.
// ============================================================================
describe('builders de inscripción · idioma del destinatario', () => {
  it('OTP en-US: cuerpo inglés y el código sigue siendo estructural', () => {
    const out = buildOtpEmail('482913', branding(), 'en-US');
    expect(out.subject).toBe('Your access code');
    expect(out.html).toContain('<html lang="en">');
    expect(out.html).toContain('Enter it on the verification screen to continue');
    expect(out.html).toContain('This code expires in 10 minutes');
    // El bloque grande con el código no depende del idioma: es estructural.
    expect(out.html).toContain('482913');
    expect(out.text).toContain('482913');
    // Y en texto plano va etiquetado en inglés, no como «Código».
    expect(out.text).toContain('Code: 482913');
    expect(out.text).not.toContain('Código:');
    expect(out.html).not.toContain('Introdúcelo en la pantalla');
  });

  it('OTP es-ES: byte a byte lo que ya recibía', () => {
    const out = buildOtpEmail('482913', branding(), 'es-ES');
    expect(out.subject).toBe('Tu código de acceso');
    expect(out.html).toContain('<html lang="es">');
    expect(out.html).toContain('Tu código de acceso a Academia Demo es:');
    expect(out.html).toContain(
      'Introdúcelo en la pantalla de verificación para continuar. Este código caduca en 10 minutos.',
    );
    expect(out.html).toContain('Si no has solicitado este acceso, ignora este mensaje.');
  });

  it('aprobación en-US: cuerpo inglés y el CTA deja de estar en español', () => {
    const out = buildWelcomeEmail('Ana', 'https://x/signin', branding(), 'en-US');
    expect(out.subject).toBe('Your registration at Academia Demo has been approved');
    expect(out.html).toContain('<html lang="en">');
    expect(out.text).toContain('Hi Ana,');
    expect(out.text).toContain('your account is now active');
    // El síntoma exacto del bug: cuerpo inglés con botón español.
    expect(out.html).toContain('Sign in');
    expect(out.html).not.toContain('>Entrar<');
    expect(out.html).not.toContain('¡Buenas noticias!');
  });

  it('rechazo en-US: cuerpo y título en inglés', () => {
    const out = buildRejectionEmail('Ana', branding(), 'en-US');
    expect(out.subject).toBe('About your registration at Academia Demo');
    expect(out.html).toContain('<html lang="en">');
    expect(out.text).toContain('Hi Ana,');
    expect(out.text).toContain('we have not been able to approve your registration');
    expect(out.html).not.toContain('Gracias por tu interés');
  });

  it('aprobación y rechazo es-ES: byte a byte lo que ya recibían', () => {
    const welcome = buildWelcomeEmail('Ana', 'https://x/signin', branding(), 'es-ES');
    expect(welcome.subject).toBe('Tu inscripción en Academia Demo ha sido aprobada');
    expect(welcome.text).toContain('Hola Ana,');
    expect(welcome.text).toContain(
      '¡Buenas noticias! Tu inscripción en Academia Demo ha sido aprobada y tu cuenta ya está activa.',
    );
    expect(welcome.html).toContain('>Entrar<');

    const rejection = buildRejectionEmail('Ana', branding(), 'es-ES');
    expect(rejection.subject).toBe('Sobre tu inscripción en Academia Demo');
    expect(rejection.text).toContain(
      'Gracias por tu interés en Academia Demo. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.',
    );
  });

  it('con override, el botón sigue el idioma aunque el texto lo escriba el tenant', () => {
    // Un tenant que personaliza el copy en inglés no puede quedarse con el
    // botón en español: el CTA es estructural y lo pone el producto.
    const out = buildWelcomeEmail('Ana', 'https://x/signin', branding(), 'en-US', {
      subject: 'You are in, {{name}}!',
      body: '{{greeting}} Come on in.',
    });
    expect(out.subject).toBe('You are in, Ana!');
    expect(out.html).toContain('Sign in');
    expect(out.html).not.toContain('>Entrar<');
  });

  // ── Portugués: los tres builders, con las mismas piezas que se afirman en
  //    inglés. Aquí vivía el camino degradado «pt-BR → español»; ahora el
  //    degradado se prueba con `fr-FR` más abajo y estos tests afirman lo
  //    contrario para `pt-BR`.
  it('OTP pt-BR: cuerpo portugués y el código sigue siendo estructural', () => {
    const out = buildOtpEmail('482913', branding(), 'pt-BR');
    expect(out.subject).toBe('Seu código de acesso');
    expect(out.html).toContain('<html lang="pt">');
    expect(out.html).toContain('Digite-o na tela de verificação para continuar');
    expect(out.html).toContain('Este código expira em 10 minutos');
    expect(out.html).toContain('482913');
    // En texto plano va etiquetado en portugués («Código» se escribe igual que
    // en español, así que lo que distingue es el cuerpo, no la etiqueta).
    expect(out.text).toContain('Código: 482913');
    expect(out.html).not.toContain('Introdúcelo en la pantalla');
    expect(out.html).not.toContain('Enter it on the verification screen');
  });

  it('aprobación pt-BR: cuerpo portugués, saludo portugués y título sin marca de género', () => {
    const out = buildWelcomeEmail('Ana', 'https://x/signin', branding(), 'pt-BR');
    expect(out.subject).toBe('Sua inscrição em Academia Demo foi aprovada');
    expect(out.html).toContain('<html lang="pt">');
    expect(out.text).toContain('Olá, Ana!');
    expect(out.text).toContain('Boas notícias! Sua inscrição em Academia Demo foi aprovada');
    expect(out.html).toContain('Boas-vindas!');
    expect(out.html).toContain('>Entrar<');
    // Ni el español ni el inglés se cuelan en el cuerpo.
    expect(out.text).not.toContain('Hola Ana,');
    expect(out.html).not.toContain('¡Buenas noticias!');
    expect(out.html).not.toContain('Sign in');
  });

  it('rechazo pt-BR: cuerpo y título en portugués', () => {
    const out = buildRejectionEmail('Ana', branding(), 'pt-BR');
    expect(out.subject).toBe('Sobre sua inscrição em Academia Demo');
    expect(out.html).toContain('<html lang="pt">');
    expect(out.text).toContain('Olá, Ana!');
    expect(out.text).toContain('não foi possível aprovar sua inscrição neste momento');
    expect(out.html).not.toContain('Gracias por tu interés');
    expect(out.html).not.toContain('Thank you for your interest');
  });

  it('con override en pt-BR, el botón sigue en portugués aunque el texto lo escriba el tenant', () => {
    const out = buildOtpEmail('482913', branding(), 'pt-BR', {
      subject: 'Seu código da {{tenantName}}',
      body: 'Use este código para entrar.',
    });
    expect(out.subject).toBe('Seu código da Academia Demo');
    expect(out.html).toContain('<html lang="pt">');
    expect(out.text).toContain('Código: 482913');
  });

  it('CAMINO DEGRADADO: locale sin catálogo (fr-FR) → español en los tres builders', () => {
    for (const locale of SIN_CATALOGO) {
      expect(buildOtpEmail('1', branding(), locale).subject, locale).toBe('Tu código de acceso');
      expect(buildWelcomeEmail('Ana', 'https://x/s', branding(), locale).subject, locale).toBe(
        'Tu inscripción en Academia Demo ha sido aprobada',
      );
      expect(buildRejectionEmail('Ana', branding(), locale).subject, locale).toBe(
        'Sobre tu inscripción en Academia Demo',
      );
    }
  });

  // ── El email de decisión al aprobador: era la ÚLTIMA plantilla monolingüe ──
  // Lo que la bloqueaba: las etiquetas de estado de suscripción las redacta
  // `classifySubscriptionStatus` en `modules/payment-connections`, así que
  // traducir solo la intro dejaba un email mitad inglés mitad español. Estos
  // tests fijan las dos mitades: el ES no cambia y el EN sale ENTERO.
  const decisionParams = (over: Partial<DecisionEmailParams> = {}): DecisionEmailParams => ({
    name: 'Ana',
    email: 'ana@example.test',
    telegramId: null,
    inGroup: 'true',
    isDelinquent: false,
    approveUrl: 'https://x/a',
    rejectUrl: 'https://x/r',
    branding: branding(),
    ...over,
  });

  const match = (over: Partial<MemberSubscriptionMatch> = {}): MemberSubscriptionMatch =>
    ({
      provider: 'stripe',
      planName: 'Plan Anual',
      status: 'active',
      unitAmount: 9900,
      currency: 'eur',
      ...over,
    }) as MemberSubscriptionMatch;

  it('decisión es-ES: byte a byte lo que ya recibía el aprobador', () => {
    const out = buildDecisionEmail(
      decisionParams({
        telegramId: '42',
        isDelinquent: true,
        subscriptionMatches: [match()],
        subscriptionFailures: [{ connectionName: 'Woo viejo' }] as never,
      }),
      'es-ES',
    );
    expect(out.subject).toBe('Nueva inscripción pendiente — Ana');
    expect(out.html).toContain('<html lang="es">');
    expect(out.text).toContain('Hay una nueva inscripción pendiente de tu aprobación en Academia Demo.'); // prettier-ignore
    expect(out.text).toContain('Estado: Miembro del grupo de Academia Demo');
    expect(out.text).toContain('⚠ CONSTA COMO IMPAGO');
    expect(out.text).toContain('  Nombre: Ana');
    expect(out.text).toContain('  Email: ana@example.test');
    expect(out.text).toContain('  Telegram ID: 42');
    expect(out.text).toContain('Suscripción vigente:');
    expect(out.text).toContain('  • Stripe: Plan Anual — Activa — 99.00 EUR');
    expect(out.text).toContain('⚠ Resultado parcial (no se pudo consultar 1 cuenta(s) de pago: Woo viejo).'); // prettier-ignore
    expect(out.text).toContain('Aprobar: https://x/a');
    expect(out.text).toContain('Rechazar: https://x/r');
  });

  it('decisión en-US: sale ENTERO en inglés, sin una sola pieza en español', () => {
    const out = buildDecisionEmail(
      decisionParams({
        telegramId: '42',
        isDelinquent: true,
        subscriptionMatches: [match({ status: 'past_due' })],
        purchases: [
          {
            orderId: 'o1',
            orderNumber: '1001',
            createdAt: '2026-03-14T10:00:00.000Z',
            status: 'completed',
            total: 4900,
            currency: 'eur',
            products: ['Curso de TS'],
          } as never,
        ],
      }),
      'en-US',
    );
    expect(out.subject).toBe('New registration pending — Ana');
    expect(out.html).toContain('<html lang="en">');
    expect(out.text).toContain('There is a new registration waiting for your approval');
    expect(out.text).toContain('Status: Member of the Academia Demo group');
    expect(out.text).toContain('⚠ RECORDED AS UNPAID');
    expect(out.text).toContain('  Name: Ana');
    // La suscripción de este aspirante está en impago (`past_due`). Este test
    // esperaba «Active subscription:» —el fallo fijado como contrato: al
    // aprobador se le decía que estaba vigente en el mismo correo que avisa
    // de que consta como impago—. Un impago es «no vigente», que es
    // justo lo que dice esa cabecera («cancelled or unpaid»).
    expect(out.text).toContain('⚠ Subscription NOT active (cancelled or unpaid):');
    expect(out.text).not.toContain('Active subscription:');
    // La pieza que bloqueaba la traducción: la etiqueta de estado vive en
    // `modules/payment-connections` y ahora sale en el idioma del aprobador.
    expect(out.text).toContain('Payment overdue (unpaid)');
    expect(out.text).toContain('Purchases found (1)');
    expect(out.text).toContain('Approve: https://x/a');
    expect(out.text).toContain('Reject: https://x/r');

    // Y NINGUNA pieza española suelta — el «mitad y mitad» que se declaró.
    for (const espanol of [
      'Estado:',
      'IMPAGO',
      'Nombre:',
      'Suscripción',
      'Pago atrasado',
      'Compras detectadas',
      'Aprobar:',
      'Rechazar:',
      'pendiente de tu aprobación',
    ]) {
      expect(out.text, `sigue en español: ${espanol}`).not.toContain(espanol);
    }
  });

  it('decisión en-US: la fecha del pedido usa el formato inglés', () => {
    const out = buildDecisionEmail(
      decisionParams({
        purchases: [
          {
            orderId: 'o1',
            orderNumber: '1001',
            createdAt: '2026-03-14T10:00:00.000Z',
            status: 'completed',
            total: 4900,
            currency: 'eur',
            products: [],
          } as never,
        ],
      }),
      'en-US',
    );
    // `toLocaleDateString('es-ES')` da 14/3/2026; el inglés, 3/14/2026.
    expect(out.text).toContain('3/14/2026');
    expect(out.text).not.toContain('14/3/2026');
  });

  it('decisión: los 4 casos del bloque de suscripción salen en inglés', () => {
    const casos: Array<[Partial<DecisionEmailParams>, string]> = [
      [{ subscriptionMatches: [match()] }, 'Active subscription'],
      [{ subscriptionMatches: [match({ status: 'canceled' })] }, 'Subscription NOT active'],
      [
        { subscriptionFailures: [{ connectionName: 'Woo' }] as never },
        'The subscription could not be verified',
      ],
      [{}, 'Subscriptions found: none in the connected payment accounts.'],
    ];
    for (const [over, esperado] of casos) {
      const out = buildDecisionEmail(decisionParams(over), 'en-US');
      expect(out.text, esperado).toContain(esperado);
    }
  });

  it('decisión: un estado de suscripción DESCONOCIDO pinta el valor crudo, nunca la key', () => {
    // `classifySubscriptionStatus` se decidió como espejo del enum del backend,
    // no como copy de pantalla: ante un estado nuevo del proveedor, al aprobador
    // le sirve más el valor crudo que un identificador interno o «Desconocido».
    const out = buildDecisionEmail(
      decisionParams({ subscriptionMatches: [match({ status: 'paused_indefinitely' })] }),
      'en-US',
    );
    expect(out.text).toContain('paused_indefinitely');
    expect(out.text).not.toContain('unknown');
  });

  it('decisión pt-BR: sale ENTERA en portugués, sin una sola pieza en español ni en inglés', () => {
    const out = buildDecisionEmail(
      decisionParams({
        telegramId: '42',
        isDelinquent: true,
        subscriptionMatches: [match({ status: 'past_due' })],
        purchases: [
          {
            orderId: 'o1',
            orderNumber: '1001',
            createdAt: '2026-03-14T10:00:00.000Z',
            status: 'completed',
            total: 4900,
            currency: 'eur',
            products: ['Curso de TS'],
          } as never,
        ],
      }),
      'pt-BR',
    );
    expect(out.subject).toBe('Nova inscrição pendente — Ana');
    expect(out.html).toContain('<html lang="pt">');
    expect(out.text).toContain('Há uma nova inscrição aguardando sua aprovação em Academia Demo.');
    expect(out.text).toContain('Status: Membro do grupo de Academia Demo');
    expect(out.text).toContain('⚠ CONSTA COMO INADIMPLENTE');
    expect(out.text).toContain('  Nome: Ana');
    expect(out.text).toContain('  E-mail: ana@example.test');
    expect(out.text).toContain('Assinatura ativa:');
    // La etiqueta de estado sale de `modules/payment-connections`, en portugués.
    expect(out.text).toContain('Pagamento em atraso (inadimplente)');
    expect(out.text).toContain('Compras detectadas (1)');
    expect(out.text).toContain('Aprovar: https://x/a');
    expect(out.text).toContain('Rejeitar: https://x/r');
    // La fecha del pedido, en formato brasileño (día/mes con cero a la izquierda).
    expect(out.text).toContain('14/03/2026');

    // Ninguna pieza española suelta. La lista es la del test inglés MENOS lo que
    // se escribe igual en portugués («Compras detectadas»), y con las formas
    // españolas exactas: «Suscripción» lleva «sc» y «Aprobar» lleva «b».
    for (const espanol of [
      'Estado:',
      'IMPAGO',
      'Nombre:',
      'Suscripción',
      'Pago atrasado',
      'Aprobar:',
      'Rechazar:',
      'pendiente de tu aprobación',
    ]) {
      expect(out.text, `sigue en español: ${espanol}`).not.toContain(espanol);
    }
    // Ni inglesa.
    for (const ingles of ['Name:', 'Approve:', 'Reject:', 'Payment overdue', 'Purchases found']) {
      expect(out.text, `sigue en inglés: ${ingles}`).not.toContain(ingles);
    }
  });

  it('decisión: los 4 casos del bloque de suscripción salen en portugués', () => {
    const casos: Array<[Partial<DecisionEmailParams>, string]> = [
      [{ subscriptionMatches: [match()] }, 'Assinatura ativa'],
      [{ subscriptionMatches: [match({ status: 'canceled' })] }, 'Assinatura NÃO ativa'],
      [
        { subscriptionFailures: [{ connectionName: 'Woo' }] as never },
        'Não foi possível verificar a assinatura',
      ],
      [{}, 'Assinatura detectada: nenhuma nas contas de pagamento conectadas.'],
    ];
    for (const [over, esperado] of casos) {
      const out = buildDecisionEmail(decisionParams(over), 'pt-BR');
      expect(out.text, esperado).toContain(esperado);
    }
  });

  it('CAMINO DEGRADADO: la decisión en un locale sin catálogo sale en español', () => {
    for (const locale of SIN_CATALOGO) {
      expect(buildDecisionEmail(decisionParams(), locale).subject, locale).toBe(
        'Nueva inscripción pendiente — Ana',
      );
    }
  });

  it('los idiomas de `classifySubscriptionStatus` son los MISMOS del catálogo', () => {
    // La lista de idiomas se redeclara en `modules/payment-connections` porque
    // un módulo no puede importar de `apps/api`. Sin esta guarda, añadir un
    // idioma al catálogo dejaría las etiquetas de suscripción atrás y el email
    // volvería a salir a medias — el bug exacto que este cabo cierra.
    for (const lang of HUB_TEMPLATE_LANGS) {
      const info = classifySubscriptionStatus('active', lang);
      expect(info.label.trim().length, `sin etiqueta de suscripción en ${lang}`).toBeGreaterThan(0);
      expect(info.entitled, lang).toBe(true);
    }
    const etiquetas = HUB_TEMPLATE_LANGS.map((l) => classifySubscriptionStatus('active', l).label);
    expect(new Set(etiquetas).size, 'dos idiomas comparten etiqueta').toBe(etiquetas.length);
  });
});

describe('copy fijo nuevo · CTA, títulos y valores de relleno', () => {
  it('las etiquetas estructurales de los emails traducidos existen en todos los idiomas', () => {
    const nuevas: FixedEmailCopyKey[] = [
      'cta.manage_subscription',
      'cta.set_my_password',
      'cta.signin',
      'footer.signin_hint',
      'label.otp_code',
      'title.member_rejection',
      'title.member_welcome',
      'title.otp_code',
      'title.subscriptions_digest',
      'value.no_upcoming_renewals',
      'value.subscription',
      'value.your_access',
    ];
    for (const key of nuevas) {
      for (const lang of HUB_TEMPLATE_LANGS) {
        expect(FIXED_EMAIL_COPY[lang][key], `${key} sin ${lang}`).toBeTruthy();
      }
    }
  });

  it('el pie con la URL de acceso conserva su placeholder en todos los idiomas', () => {
    const vars = { signinUrl: 'https://x/signin' };
    expect(interpolate(resolveFixedEmailCopy('footer.signin_hint', 'es-ES'), vars)).toBe(
      'Después podrás iniciar sesión desde https://x/signin con tu email.',
    );
    expect(interpolate(resolveFixedEmailCopy('footer.signin_hint', 'en-US'), vars)).toContain(
      'https://x/signin',
    );
    expect(interpolate(resolveFixedEmailCopy('footer.signin_hint', 'pt-BR'), vars)).toBe(
      'Depois, você poderá entrar em https://x/signin com seu e-mail.',
    );
  });
});

describe('copy de la invitación al aula', () => {
  type InvitationKey = keyof typeof INVITATION_EMAIL_COPY.es;

  it.each(TRANSLATED_LANGS)('%s cubre las mismas piezas y ninguna se quedó en español', (lang) => {
    const esKeys = Object.keys(INVITATION_EMAIL_COPY.es).sort();
    expect(Object.keys(INVITATION_EMAIL_COPY[lang]).sort()).toEqual(esKeys);
    for (const key of esKeys as InvitationKey[]) {
      expect(INVITATION_EMAIL_COPY[lang][key], `${key} sin traducir`).not.toBe(
        INVITATION_EMAIL_COPY.es[key],
      );
      expect(INVITATION_EMAIL_COPY[lang][key].trim().length, `${key} vacío`).toBeGreaterThan(0);
    }
  });

  it.each(TRANSLATED_LANGS)('%s declara los MISMOS placeholders en cada pieza', (lang) => {
    // Si la traducción pierde `{{tenantName}}` o `{{validez}}`, el invitado
    // recibe «has invited you to their classroom» sin saber quién, o una
    // validez en blanco. Nadie lo ve hasta que llega el email.
    const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(INVITATION_EMAIL_COPY.es) as InvitationKey[]) {
      expect(vars(INVITATION_EMAIL_COPY[lang][key]), `${key}: placeholders distintos`).toEqual(
        vars(INVITATION_EMAIL_COPY.es[key]),
      );
    }
  });

  it.each(TRANSLATED_LANGS)('%s conserva el <strong> de la maqueta en la intro', (lang) => {
    // `introHtml` es la única pieza con HTML: la maqueta resalta el nombre del
    // tenant y «tu cuenta ya está creada». Una traducción que pierda una
    // etiqueta de cierre deja en negrita el resto del email.
    const tags = (s: string) => [...s.matchAll(/<\/?[a-z]+>/g)].map((m) => m[0]);
    expect(tags(INVITATION_EMAIL_COPY[lang].introHtml)).toEqual(
      tags(INVITATION_EMAIL_COPY.es.introHtml),
    );
    expect(tags(INVITATION_EMAIL_COPY[lang].introText)).toEqual([]);
  });

  it('resolveInvitationEmailCopy devuelve el idioma pedido y degrada al español', () => {
    expect(resolveInvitationEmailCopy('en-US')).toEqual(INVITATION_EMAIL_COPY.en);
    expect(resolveInvitationEmailCopy('pt-BR')).toEqual(INVITATION_EMAIL_COPY.pt);
    for (const locale of ['fr-FR', '', '  ', null, undefined]) {
      expect(resolveInvitationEmailCopy(locale)).toEqual(INVITATION_EMAIL_COPY.es);
    }
    expect(resolveInvitationEmailCopy(HUB_DEFAULT_LOCALE)).toEqual(INVITATION_EMAIL_COPY.es);
  });
});

describe('emailDateLocale', () => {
  it('las fechas del email se formatean en el idioma del destinatario', () => {
    const d = new Date('2026-07-24T10:00:00.000Z');
    const fmt = (locale: string) =>
      d.toLocaleDateString(emailDateLocale(locale), {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
    // El bug: «24 de julio de 2026» en mitad de una frase en inglés.
    expect(fmt('es-ES')).toContain('julio');
    expect(fmt('en-US')).toContain('July');
    // Y en portugués: «julho», no «julio».
    expect(fmt('pt-BR')).toBe('24 de julho de 2026');
  });

  it('devuelve un locale COMPLETO por idioma (Intl necesita la región)', () => {
    expect(emailDateLocale('pt-BR')).toBe('pt-BR');
    expect(emailDateLocale('pt')).toBe('pt-BR');
    expect(emailDateLocale('en-GB')).toBe('en-US');
    expect(emailDateLocale('es-AR')).toBe(HUB_DEFAULT_LOCALE);
  });

  it('CAMINO DEGRADADO: idioma sin catálogo → el locale de referencia', () => {
    for (const locale of ['fr-FR', 'zz', '', null, undefined]) {
      expect(emailDateLocale(locale)).toBe(HUB_DEFAULT_LOCALE);
    }
  });
});
