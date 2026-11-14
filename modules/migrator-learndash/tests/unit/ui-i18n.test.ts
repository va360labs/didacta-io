import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LANGS,
  MESSAGES,
  formatDay,
  formatNumber,
  resolveLang,
  setActiveLocale,
  t,
  tParts,
  type MessageKey,
} from '../../src/ui/i18n.js';

/// Textos del bundle UI del migrador (es / en / pt-BR).
///
/// El bundle se pinta dentro del aula del host, que puede estar en inglés o en
/// portugués: hasta ahora el wizard estaba escrito solo en español y un aula en
/// otro idioma lo veía en español. Este test vigila las tres cosas que rompen
/// una traducción sin que nadie lo vea en una pantalla en español: una clave
/// que falta en un idioma, un `{marcador}` o una etiqueta que no coincide, y un
/// texto nuevo escrito a mano en un `.tsx` en lugar de pasar por el diccionario.

const UI_DIR = resolve(__dirname, '..', '..', 'src', 'ui');
const UI_FILES = ['admin.tsx', 'wizard.tsx', 'jobs-monitor.tsx', 'i18n-rich.tsx'] as const;

type FakeGlobal = {
  __didacta__?: { i18n?: { getLocale?: () => string } };
  document?: { documentElement?: { lang?: string } };
};
const g = globalThis as FakeGlobal;

/// Simula el host: runtime 1.1.0 (con `i18n.getLocale`) o 1.0.0 (solo `<html lang>`).
function hostWith(opts: { runtime?: string; htmlLang?: string }): void {
  if (opts.runtime !== undefined) {
    const tag = opts.runtime;
    g.__didacta__ = { i18n: { getLocale: () => tag } };
  }
  if (opts.htmlLang !== undefined) g.document = { documentElement: { lang: opts.htmlLang } };
}

afterEach(() => {
  setActiveLocale(null);
  delete g.__didacta__;
  delete g.document;
});

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const tags = (s: string): string[] => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();

describe('diccionario del bundle UI: paridad es / en / pt', () => {
  const esKeys = Object.keys(MESSAGES.es).sort();

  it.each(LANGS)('%s tiene exactamente las mismas claves que es', (lang) => {
    expect(Object.keys(MESSAGES[lang]).sort()).toEqual(esKeys);
  });

  it.each(LANGS)('%s: ningún texto vacío', (lang) => {
    const empty = Object.entries(MESSAGES[lang]).filter(([, v]) => v.trim() === '');
    expect(empty).toEqual([]);
  });

  it('cada clave lleva los mismos {marcadores} en los tres idiomas', () => {
    const mismatches = esKeys.flatMap((key) => {
      const k = key as MessageKey;
      const ref = placeholders(MESSAGES.es[k]);
      return LANGS.filter((l) => placeholders(MESSAGES[l][k]).join() !== ref.join()).map(
        (l) => `${l}:${key}`,
      );
    });
    expect(mismatches).toEqual([]);
  });

  it('cada clave lleva las mismas etiquetas (<b>, <strong>, <code>) en los tres idiomas', () => {
    const mismatches = esKeys.flatMap((key) => {
      const k = key as MessageKey;
      const ref = tags(MESSAGES.es[k]);
      return LANGS.filter((l) => tags(MESSAGES[l][k]).join() !== ref.join()).map(
        (l) => `${l}:${key}`,
      );
    });
    expect(mismatches).toEqual([]);
  });

  it('pt es portugués y en es inglés: sin signos ni letras del español', () => {
    const spanishPt = Object.entries(MESSAGES.pt).filter(([, v]) => /[¿¡ñ]/.test(v));
    const spanishEn = Object.entries(MESSAGES.en).filter(([, v]) => /[¿¡ñáéíóú]/.test(v));
    expect(spanishPt).toEqual([]);
    expect(spanishEn).toEqual([]);
  });
});

describe('resolveLang: tag del host → tabla', () => {
  it.each([
    ['es-ES', 'es'],
    ['es-AR', 'es'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['pt-BR', 'pt'],
    ['pt-PT', 'pt'],
    ['pt_br', 'pt'],
    ['EN', 'en'],
    // Control: un idioma sin tabla se pinta en español.
    ['fr-FR', 'es'],
    ['', 'es'],
    [null, 'es'],
    [undefined, 'es'],
  ] as const)('%s → %s', (tag, lang) => {
    expect(resolveLang(tag)).toBe(lang);
  });
});

describe('t(): elige el idioma del runtime del host', () => {
  it('runtime 1.1.0 en pt-BR → portugués', () => {
    hostWith({ runtime: 'pt-BR' });
    expect(t('admin.tabs.wizard')).toBe('Criar migração');
    expect(t('entity.lessons')).toBe('Aulas');
    expect(t('wizard.options.passwordActivation')).toBe('Enviar e-mail de ativação (recomendado)');
  });

  it('runtime 1.1.0 en en-US → inglés', () => {
    hostWith({ runtime: 'en-US' });
    expect(t('admin.tabs.wizard')).toBe('Create migration');
  });

  it('control: fr-FR → español, igual byte a byte que el texto original', () => {
    hostWith({ runtime: 'fr-FR' });
    expect(t('admin.tabs.wizard')).toBe('Crear migración');
    expect(t('wizard.welcome.title')).toBe('¿Listo para traer tu academia a Didacta?');
    expect(t('monitor.activeSummary', { count: 2, seconds: 3 })).toBe(
      '2 migración(es) en curso · auto-refresh cada 3s',
    );
  });

  it('host 1.0.0 (sin i18n en el runtime) → lee <html lang>', () => {
    hostWith({ htmlLang: 'pt-BR' });
    expect(t('admin.tabs.monitor')).toBe('Monitor de migrações');
  });

  it('sin runtime ni <html lang> → español', () => {
    expect(t('admin.tabs.monitor')).toBe('Monitor de migraciones');
  });

  it('el idioma que fija AdminSurface (useLocale) manda sobre la lectura del host', () => {
    hostWith({ runtime: 'es-ES' });
    setActiveLocale('en-US');
    expect(t('common.back')).toBe('Back');
    setActiveLocale(null);
    expect(t('common.back')).toBe('Volver');
  });

  it('un {marcador} que no llega se queda visible (no se pinta "undefined")', () => {
    expect(t('wizard.done.fullReport')).toBe('Reporte completo (job {jobId})');
  });
});

describe('tParts(): etiquetas del texto', () => {
  it('trocea el texto por <b> y sustituye los valores', () => {
    hostWith({ runtime: 'es-ES' });
    expect(tParts('wizard.options.howBody', { users: 5 })).toEqual([
      'Primero hacemos una ',
      { tag: 'b', text: 'prueba' },
      ': importamos un curso de tu academia con hasta 5 alumnos para que verifiques que todo se ve bien en Didacta. Si te convence, te preguntamos si seguir con la ',
      { tag: 'b', text: 'integración completa' },
      '; el curso de la prueba no se vuelve a importar (se reutiliza lo ya cargado), solo añadimos lo que falta.',
    ]);
  });

  it('un dato con etiquetas se pinta como texto, nunca como etiqueta', () => {
    expect(tParts('wizard.running.status', { jobId: '<b>x</b>', status: 'pending' })).toEqual([
      'Job ',
      { tag: 'code', text: '<b>x</b>' },
      ' · pending',
    ]);
  });

  it('pt: la variable va dentro de <strong>', () => {
    hostWith({ runtime: 'pt-BR' });
    expect(tParts('monitor.emptyHint', { tab: t('admin.tabs.wizard') })).toEqual([
      'Crie uma na aba ',
      { tag: 'strong', text: 'Criar migração' },
      '.',
    ]);
  });
});

describe('números y fechas con el locale activo', () => {
  it('los marcadores numéricos se formatean por idioma', () => {
    hostWith({ runtime: 'pt-BR' });
    expect(t('monitor.dlq.count', { total: 12345, shown: 20 })).toBe(
      '(12.345 linha(s), mostrando 20)',
    );
    setActiveLocale('en-US');
    expect(t('monitor.dlq.count', { total: 12345, shown: 20 })).toBe('(12,345 row(s), showing 20)');
  });

  it('el día de una fecha de WordPress, sin que la zona horaria lo mueva', () => {
    setActiveLocale('es-ES');
    expect(formatDay('2024-05-01T23:30:00')).toBe('01/05/2024');
    setActiveLocale('en-US');
    expect(formatDay('2024-05-01T23:30:00')).toBe('05/01/2024');
    setActiveLocale('pt-BR');
    expect(formatDay('2024-05-01T23:30:00')).toBe('01/05/2024');
    expect(formatDay('sin fecha')).toBe('sin fecha');
  });

  it('control: fr-FR formatea como el español que se pinta', () => {
    setActiveLocale('fr-FR');
    expect(formatNumber(12345)).toBe('12.345');
  });
});

describe('los .tsx del bundle no llevan textos escritos a mano', () => {
  const sources = UI_FILES.map((f) => ({
    file: f,
    code: readFileSync(resolve(UI_DIR, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }));

  it('sin letras ni signos del español fuera de los comentarios', () => {
    const offenders = sources.flatMap(({ file, code }) =>
      code
        .split('\n')
        .filter((line) => /[¿¡ñáéíóúÁÉÍÓÚÑ]/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('toda clave del diccionario se usa en algún .tsx (sin claves muertas)', () => {
    const all = sources.map((s) => s.code).join('\n');
    const unused = Object.keys(MESSAGES.es).filter((key) => !all.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });
});
