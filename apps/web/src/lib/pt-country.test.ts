/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { ptCountryPhrase } from './pt-country';

describe('ptCountryPhrase: «contas do Brasil», no «contas de Brasil»', () => {
  it('contrae la preposición con el artículo del país', () => {
    expect(ptCountryPhrase('BR', 'Brasil')).toBe('do Brasil');
    expect(ptCountryPhrase('ar', 'Argentina')).toBe('da Argentina');
    expect(ptCountryPhrase('US', 'Estados Unidos')).toBe('dos Estados Unidos');
    expect(ptCountryPhrase('PT', 'Portugal')).toBe('de Portugal');
  });

  it('un país fuera de la lista no se arriesga a una contracción mal hecha', () => {
    expect(ptCountryPhrase('DE', 'Alemanha')).toBe('deste país (Alemanha)');
    expect(ptCountryPhrase(null, 'Brasil')).toBe('deste país (Brasil)');
  });
});
