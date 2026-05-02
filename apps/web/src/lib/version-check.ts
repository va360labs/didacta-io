/// Polling para detectar versión nueva publicada en Docker Hub y avisar
/// al operador desde el sidebar.
///
/// Implementación: el frontend pega a `/api/v1/system/version-check`
/// (mismo origen) y el backend hace el fetch real a Docker Hub. Sin
/// proxy server-side teníamos CORS bloqueado — Docker Hub NO sirve
/// `Access-Control-Allow-Origin` desde browser. El backend cachea 4h
/// en memoria; un solo poll global atiende a todos los browsers.
///
/// Ignoramos:
///   - `latest`, `alpha`, `beta`, `stable` (rolling tags, no son versión).
///   - Tags que parezcan SHA short (`^[a-f0-9]{7}$`).
///   - Cualquier tag que no parsee como `<MAJOR>.<MINOR>.<PATCH>(-PRE)?`.

import { APP_VERSION } from './version';

const VERSION_CHECK_ENDPOINT = '/api/v1/system/version-check';
/// 30 min. La cadencia útil la pone el cache server-side (15 min);
/// pollear más seguido desde cada browser solo carga al server sin
/// ganar nada. 30 min asegura que dentro de ~1h tras un release todos
/// los browsers abiertos lo verán.
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const STORAGE_KEY_LAST_CHECK = 'didacta:version-check:last-check';
const STORAGE_KEY_DISMISSED = 'didacta:version-check:dismissed';

interface VersionCheckResponse {
  tags: Array<{ name: string; lastUpdated: string }>;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /// Pre-release identifier (`alpha.20`, `beta.1`, `rc.0`). Vacío si la
  /// versión es estable (`1.2.3`).
  pre: string;
  /// Tag tal cual viene de Docker Hub (`0.0.1-alpha.20`). Útil para
  /// mostrar al user.
  raw: string;
}

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SHA_TAG_REGEX = /^[a-f0-9]{7}$/;
const ROLLING_TAGS = new Set(['alpha', 'beta', 'latest', 'stable']);

export function parseVersion(tag: string): ParsedVersion | null {
  if (ROLLING_TAGS.has(tag)) return null;
  if (SHA_TAG_REGEX.test(tag)) return null;
  const match = tag.match(SEMVER_REGEX);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? '',
    raw: tag,
  };
}

/// Compara dos versiones SemVer. Retorna negativo si `a < b`, 0 si son
/// iguales, positivo si `a > b`. Para pre-releases sigue las reglas
/// SemVer: ausencia de pre > presencia de pre (`1.0.0` > `1.0.0-rc.1`).
/// Entre pre-releases compara lexicográficamente split por `.` con
/// numeric-vs-alpha awareness.
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === '' && b.pre === '') return 0;
  if (a.pre === '') return 1; // a stable > b pre
  if (b.pre === '') return -1;
  // Ambos pre: comparación segmentada.
  const aSeg = a.pre.split('.');
  const bSeg = b.pre.split('.');
  for (let i = 0; i < Math.max(aSeg.length, bSeg.length); i++) {
    const ai = aSeg[i];
    const bi = bSeg[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = Number(ai);
    const bn = Number(bi);
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ai < bi ? -1 : ai > bi ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/// Fetch al proxy server-side (`/api/v1/system/version-check`). Sin
/// auth — endpoint marcado `@Public()`. Devuelve la lista de versiones
/// SemVer publicadas, ordenadas DESC.
export async function fetchPublishedVersions(): Promise<ParsedVersion[]> {
  const res = await fetch(VERSION_CHECK_ENDPOINT, { cache: 'no-store' });
  if (!res.ok) throw new Error(`version-check API: HTTP ${res.status}`);
  const data = (await res.json()) as VersionCheckResponse;
  const versions: ParsedVersion[] = [];
  for (const t of data.tags ?? []) {
    const parsed = parseVersion(t.name);
    if (parsed) versions.push(parsed);
  }
  versions.sort((a, b) => -compareVersions(a, b));
  return versions;
}

export interface VersionCheckResult {
  /// Versión instalada (`APP_VERSION`).
  current: ParsedVersion;
  /// Última versión publicada en el canal del operador (alpha/beta/stable).
  latest: ParsedVersion | null;
  /// True si `latest > current` y el operador NO la descartó.
  hasUpdate: boolean;
}

/// Determina si hay versión nueva. Aplica filtros del lado del cliente
/// para evitar pings excesivos a Docker Hub.
export async function checkForUpdate(): Promise<VersionCheckResult | null> {
  const current = parseVersion(APP_VERSION);
  if (!current) return null; // versión local mal-formada → no chequeamos

  // Cache: si hicimos un poll en las últimas 4h, no volvemos a llamar.
  const lastCheck = readNumber(STORAGE_KEY_LAST_CHECK);
  if (lastCheck && Date.now() - lastCheck < POLL_INTERVAL_MS) {
    return null;
  }

  let published: ParsedVersion[];
  try {
    published = await fetchPublishedVersions();
  } catch {
    // Sin red, sin Docker Hub, sin banner. Silencioso.
    return null;
  }
  writeNumber(STORAGE_KEY_LAST_CHECK, Date.now());

  // Filtramos al canal del operador: si está en alpha, solo le mostramos
  // alphas más nuevas. Si está en beta, beta o stable. Stable solo stable.
  const channel = current.pre.split('.')[0] ?? 'stable';
  const candidates = published.filter((v) => {
    if (channel === 'stable') return v.pre === '';
    if (channel === 'beta') return v.pre === '' || v.pre.startsWith('beta');
    if (channel === 'alpha') return v.pre.startsWith('alpha');
    return v.pre.startsWith(channel);
  });
  const latest = candidates[0] ?? null;
  if (!latest) return { current, latest: null, hasUpdate: false };

  if (compareVersions(latest, current) <= 0) {
    return { current, latest, hasUpdate: false };
  }

  // ¿El operador ya la descartó?
  const dismissed = readString(STORAGE_KEY_DISMISSED);
  if (dismissed === latest.raw) {
    return { current, latest, hasUpdate: false };
  }

  return { current, latest, hasUpdate: true };
}

/// Marca la versión `tag` como descartada por el operador. No volverá a
/// aparecer el banner para ESA versión exacta. Cuando salga una más
/// nueva, el banner reaparece (porque el `dismissed` no matchea).
export function dismissVersion(tag: string): void {
  writeString(STORAGE_KEY_DISMISSED, tag);
}

function readNumber(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

function writeNumber(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Quota / private mode — silencioso.
  }
}

function readString(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(key);
}

function writeString(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
