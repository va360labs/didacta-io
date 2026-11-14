/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «contas do Brasil», no «contas de Brasil»: en portugués casi todos los
 * países llevan artículo y la preposición se contrae con él (do, da, dos).
 * Un `{country}` suelto en el mensaje no puede saberlo, así que la frase se
 * arma aquí para los países a los que de verdad se les dice «todavía no
 * podemos pagarte» (los de fuera del área de cobros: Latinoamérica y la
 * lusofonía, además de los que se cuelan desde el selector).
 *
 * Un país que no está en la lista no se arriesga a una contracción mal hecha:
 * «deste país (Alemanha)».
 */
const PT_COUNTRY_PHRASE: Record<string, string> = {
  BR: 'do Brasil',
  PT: 'de Portugal',
  MX: 'do México',
  AR: 'da Argentina',
  CO: 'da Colômbia',
  CL: 'do Chile',
  PE: 'do Peru',
  UY: 'do Uruguai',
  PY: 'do Paraguai',
  BO: 'da Bolívia',
  EC: 'do Equador',
  VE: 'da Venezuela',
  AO: 'de Angola',
  MZ: 'de Moçambique',
  CV: 'de Cabo Verde',
  US: 'dos Estados Unidos',
};

export function ptCountryPhrase(code: string | null | undefined, name: string): string {
  const phrase = PT_COUNTRY_PHRASE[(code ?? '').toUpperCase()];
  return phrase ?? `deste país (${name})`;
}
