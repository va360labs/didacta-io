/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Provincias de España ↔ su código ISO 3166-2 (sin el prefijo `ES-`).
 *
 * Por qué existe: Stripe guarda la provincia de una dirección española en
 * `address.state` como código ISO 3166-2 («State, county, province, or region
 * (ISO 3166-2)», referencia de `POST /v1/accounts`), y la devuelve igual: el
 * creador de Cádiz veía «CA» en sus datos fiscales y tenía que corregirlo a
 * mano (prueba real del 14-nov-2026). En Didacta la provincia se escribe con
 * su nombre; hacia Stripe va el código, y de Stripe se trae el nombre.
 *
 * Los nombres bilingües (Alicante/Alacant, A Coruña/La Coruña…) se aceptan en
 * cualquiera de sus formas. Lo que no se reconoce devuelve `null`: mejor no
 * mandar provincia que mandar una que Stripe rechace (`address_state_invalid`).
 */

/** Código → nombre con el que se enseña. */
const NAME_BY_CODE: Readonly<Record<string, string>> = {
  A: 'Alicante',
  AB: 'Albacete',
  AL: 'Almería',
  AV: 'Ávila',
  B: 'Barcelona',
  BA: 'Badajoz',
  BI: 'Bizkaia',
  BU: 'Burgos',
  C: 'A Coruña',
  CA: 'Cádiz',
  CC: 'Cáceres',
  CE: 'Ceuta',
  CO: 'Córdoba',
  CR: 'Ciudad Real',
  CS: 'Castellón',
  CU: 'Cuenca',
  GC: 'Las Palmas',
  GI: 'Girona',
  GR: 'Granada',
  GU: 'Guadalajara',
  H: 'Huelva',
  HU: 'Huesca',
  J: 'Jaén',
  L: 'Lleida',
  LE: 'León',
  LO: 'La Rioja',
  LU: 'Lugo',
  M: 'Madrid',
  MA: 'Málaga',
  ML: 'Melilla',
  MU: 'Murcia',
  NA: 'Navarra',
  O: 'Asturias',
  OR: 'Ourense',
  P: 'Palencia',
  PM: 'Illes Balears',
  PO: 'Pontevedra',
  S: 'Cantabria',
  SA: 'Salamanca',
  SE: 'Sevilla',
  SG: 'Segovia',
  SO: 'Soria',
  SS: 'Gipuzkoa',
  T: 'Tarragona',
  TE: 'Teruel',
  TF: 'Santa Cruz de Tenerife',
  TO: 'Toledo',
  V: 'Valencia',
  VA: 'Valladolid',
  VI: 'Álava',
  Z: 'Zaragoza',
  ZA: 'Zamora',
};

/** Otras formas de escribir el mismo nombre (normalizadas con `key`). */
const ALIASES: Readonly<Record<string, string>> = {
  alacant: 'A',
  'la coruna': 'C',
  coruna: 'C',
  corunna: 'C',
  'a coruna': 'C',
  vizcaya: 'BI',
  biscay: 'BI',
  castello: 'CS',
  'castello de la plana': 'CS',
  'castellon de la plana': 'CS',
  'gran canaria': 'GC',
  gerona: 'GI',
  lerida: 'L',
  rioja: 'LO',
  'region de murcia': 'MU',
  nafarroa: 'NA',
  'comunidad foral de navarra': 'NA',
  orense: 'OR',
  baleares: 'PM',
  'islas baleares': 'PM',
  'balearic islands': 'PM',
  'illes balears': 'PM',
  'principado de asturias': 'O',
  oviedo: 'O',
  santander: 'S',
  guipuzcoa: 'SS',
  tenerife: 'TF',
  'sta cruz de tenerife': 'TF',
  'santa cruz tenerife': 'TF',
  valencia: 'V',
  araba: 'VI',
  alava: 'VI',
  'comunidad de madrid': 'M',
};

/** Minúsculas, sin acentos ni signos: «A Coruña» → «a coruna». */
function key(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^provincia\s+de\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const CODE_BY_KEY: ReadonlyMap<string, string> = new Map([
  ...Object.entries(NAME_BY_CODE).map(([code, name]) => [key(name), code] as const),
  ...Object.entries(ALIASES),
]);

/**
 * Código ISO 3166-2 de una provincia española (sin `ES-`), a partir de su
 * nombre en cualquiera de sus formas o del propio código («CA», «ES-CA»).
 * `null` si no se reconoce.
 */
export function esProvinceCode(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const asCode = raw.toUpperCase().replace(/^ES-/, '');
  if (/^[A-Z]{1,2}$/.test(asCode) && NAME_BY_CODE[asCode]) return asCode;
  // «Alicante/Alacant», «Valencia - València»: vale cualquiera de las partes.
  for (const part of [raw, ...raw.split(/\s*[/|-]\s*/)]) {
    const code = CODE_BY_KEY.get(key(part));
    if (code) return code;
  }
  return null;
}

/**
 * Nombre de la provincia para enseñarlo: del código de Stripe («CA» →
 * «Cádiz») o de un nombre ya escrito (se deja como está si no se reconoce).
 */
export function esProvinceName(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const asCode = raw.toUpperCase().replace(/^ES-/, '');
  if (/^[A-Z]{1,2}$/.test(asCode) && NAME_BY_CODE[asCode]) return NAME_BY_CODE[asCode]!;
  return raw;
}
