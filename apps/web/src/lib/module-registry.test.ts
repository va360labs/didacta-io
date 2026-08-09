import { describe, expect, it } from 'vitest';
import esAdminMarca from '@/i18n/messages/es/adminMarca.json';
import enAdminMarca from '@/i18n/messages/en/adminMarca.json';
import { flatAdminConfigTabs } from '@/modules';
import { resolveModuleText, type ModuleLocalizedText } from './module-registry';
import type { TranslatorLike } from './i18n/labels';

/**
 * `t` de mentira con la forma mínima que consume `resolveModuleText`: resuelve
 * keys anidadas por puntos contra un catálogo plano de namespace.
 */
function makeT(namespace: Record<string, unknown>): TranslatorLike {
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, namespace);
  const t = ((key: string) => String(lookup(key))) as TranslatorLike;
  t.has = (key: string) => typeof lookup(key) === 'string';
  return t;
}

describe('resolveModuleText', () => {
  it('usa el catálogo cuando la key existe (ES y EN dan textos distintos)', () => {
    const text: ModuleLocalizedText = {
      key: 'configTabs.aula-virtual',
      fallback: 'Aula virtual',
    };
    expect(resolveModuleText(makeT(esAdminMarca), text)).toBe('Aula virtual');
    expect(resolveModuleText(makeT(enAdminMarca), text)).toBe('Virtual classroom');
  });

  // CAMINO DEGRADADO: un módulo de terceros que no está en el catálogo del core.
  // El contrato exige pintar su `fallback` crudo, NUNCA la key.
  it('degrada al fallback del módulo cuando la key no está en el catálogo', () => {
    const text: ModuleLocalizedText = {
      key: 'configTabs.modulo-de-un-tercero',
      fallback: 'Third-party module',
    };
    for (const catalog of [esAdminMarca, enAdminMarca]) {
      const resolved = resolveModuleText(makeT(catalog), text);
      expect(resolved).toBe('Third-party module');
      expect(resolved).not.toContain('configTabs.');
    }
  });
});

describe('adminConfigTabs de los módulos del repo', () => {
  // Guarda del MUST-FIX 33: ningún módulo del repo puede volver a declarar copy
  // de pantalla que solo exista en español. Si un tab nuevo no trae su entrada
  // en AMBOS catálogos, la UI inglesa mostraría el fallback castellano.
  it('declaran keys presentes en el catálogo ES y EN', () => {
    const tabs = flatAdminConfigTabs();
    expect(tabs.length).toBeGreaterThan(0);
    for (const { moduleName, tab } of tabs) {
      for (const text of [tab.label, tab.description]) {
        expect(
          makeT(esAdminMarca).has(text.key),
          `${moduleName}: falta ${text.key} en es/adminMarca.json`,
        ).toBe(true);
        expect(
          makeT(enAdminMarca).has(text.key),
          `${moduleName}: falta ${text.key} en en/adminMarca.json`,
        ).toBe(true);
      }
    }
  });
});
