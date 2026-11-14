/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { perIntervalSuffix } from './interval';
import type { TranslatorLike } from './labels';

const MESSAGES = path.resolve(__dirname, '..', '..', 'i18n', 'messages');

/** `t` de verdad sobre el `common.json` del idioma (sin montar next-intl). */
function commonT(locale: 'es' | 'en' | 'pt'): TranslatorLike {
  const common = JSON.parse(
    readFileSync(path.join(MESSAGES, locale, 'common.json'), 'utf8'),
  ) as Record<string, unknown>;
  const lookup = (key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], common);
  const t = ((key: string) => String(lookup(key))) as TranslatorLike;
  t.has = (key: string) => typeof lookup(key) === 'string';
  return t;
}

describe('perIntervalSuffix', () => {
  it('en español el panel dice «/mes», no «/month»', () => {
    const t = commonT('es');
    expect(perIntervalSuffix(t, 'month')).toBe('/mes');
    expect(perIntervalSuffix(t, 'year')).toBe('/año');
    expect(perIntervalSuffix(t, 'week')).toBe('/semana');
    expect(perIntervalSuffix(t, 'day')).toBe('/día');
  });

  it('en inglés y en portugués, el suyo', () => {
    expect(perIntervalSuffix(commonT('en'), 'month')).toBe('/month');
    expect(perIntervalSuffix(commonT('pt'), 'month')).toBe('/mês');
    expect(perIntervalSuffix(commonT('pt'), 'year')).toBe('/ano');
  });

  it('un intervalo que el catálogo no conoce se pinta tal cual; sin intervalo, nada', () => {
    const t = commonT('es');
    expect(perIntervalSuffix(t, 'fortnight')).toBe('/fortnight');
    expect(perIntervalSuffix(t, null)).toBe('');
    expect(perIntervalSuffix(t, '')).toBe('');
  });
});
