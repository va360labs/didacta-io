/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';

/**
 * Ajustes de la biblioteca de Bunny Stream de Didacta Cloud y de su zona de
 * CDN. Los usa SOLO el script `scripts/bunny-cloud-library.ts`, que corre a
 * mano con la clave de la CUENTA de Bunny (la de la API core, no la de la
 * biblioteca): el servidor nunca tiene esa clave.
 *
 * Llamadas contrastadas con el OpenAPI de la API core
 * (https://bunny.net/docs/api-reference/core/openapi.json):
 *  - `GET/POST https://api.bunny.net/videolibrary/{id}` (VideoLibraryPublic_Index2 / _Update)
 *  - `GET/POST https://api.bunny.net/pullzone/{id}` (PullZonePublic_Index2 / _UpdatePullZone)
 *  - `POST https://api.bunny.net/pullzone/{id}/edgerules/addOrUpdate` (PullZonePublic_AddEdgeRule)
 */

export const DESIRED_RESOLUTIONS = '240p,360p,480p,720p,1080p';

/** Reglas que cierran la descarga directa (las mismas que la biblioteca de VA360). */
export const EDGE_RULES = [
  {
    Description: 'block_original',
    pattern: '*/original*',
  },
  {
    Description: 'block_mp4',
    pattern: '*play_*.mp4',
  },
] as const;

export interface LibraryState {
  EnabledResolutions?: string;
  KeepOriginalFiles?: boolean;
  EnableMP4Fallback?: boolean;
  AllowDirectPlay?: boolean;
  PlayerTokenAuthenticationEnabled?: boolean;
  EnableTokenAuthentication?: boolean;
  WebhookUrl?: string | null;
  PullZoneId?: number;
  ApiKey?: string;
  ReadOnlyApiKey?: string;
}

export interface PullZoneState {
  Type?: number | string;
  ZoneSecurityKey?: string;
  EdgeRules?: Array<{ Description?: string; ActionType?: number | string; Enabled?: boolean }>;
  Hostnames?: Array<{ Value?: string }>;
}

export interface SetupPlan {
  /** Cambios a mandar a `POST /videolibrary/{id}`. */
  library: Record<string, unknown>;
  /** Cambios a mandar a `POST /pullzone/{id}`. */
  pullZone: Record<string, unknown>;
  /** Reglas que faltan. */
  edgeRules: Array<Record<string, unknown>>;
  /** Comprobaciones de las variables contra lo que dice Bunny (sin secretos). */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

function fingerprint(value: string | undefined): string {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : '—';
}

const isBlock = (a: number | string | undefined) => a === 4 || a === 'BlockRequest';
const isVolume = (t: number | string | undefined) => t === 1 || t === 'Volume';

/** Qué hay que cambiar para dejar la biblioteca como la quiere Cloud. Puro. */
export function planLibrarySetup(input: {
  library: LibraryState;
  pullZone: PullZoneState;
  webhookUrl: string;
  env: { apiKey: string; webhookSecret: string; tokenKey: string; cdnHostname: string };
}): SetupPlan {
  const { library: lib, pullZone: pz } = input;
  const library: Record<string, unknown> = {};
  if ((lib.EnabledResolutions ?? '') !== DESIRED_RESOLUTIONS) {
    library['EnabledResolutions'] = DESIRED_RESOLUTIONS;
  }
  // El original no se guarda nunca, ni MP4 descargables, ni reproducción directa.
  if (lib.KeepOriginalFiles !== false) library['KeepOriginalFiles'] = false;
  if (lib.EnableMP4Fallback !== false) library['EnableMP4Fallback'] = false;
  if (lib.AllowDirectPlay !== false) library['AllowDirectPlay'] = false;
  // Embed firmado (lo firma la API, 30 min) y CDN con token.
  if (lib.PlayerTokenAuthenticationEnabled !== true) {
    library['PlayerTokenAuthenticationEnabled'] = true;
  }
  if (lib.EnableTokenAuthentication !== true) library['EnableTokenAuthentication'] = true;
  if ((lib.WebhookUrl ?? '') !== input.webhookUrl) library['WebhookUrl'] = input.webhookUrl;

  const pullZone: Record<string, unknown> = {};
  // Red «volumen»: más barata, sobre todo en Latinoamérica.
  if (!isVolume(pz.Type)) pullZone['Type'] = 1;

  const edgeRules = EDGE_RULES.filter(
    (rule) =>
      !(pz.EdgeRules ?? []).some(
        (r) => r.Description === rule.Description && isBlock(r.ActionType) && r.Enabled !== false,
      ),
  ).map((rule) => ({
    ActionType: 4,
    ActionParameter1: '',
    ActionParameter2: '',
    Triggers: [{ Type: 0, PatternMatches: [rule.pattern], PatternMatchingType: 0 }],
    TriggerMatchingType: 0,
    Description: rule.Description,
    Enabled: true,
  }));

  const hostnames = (pz.Hostnames ?? []).map((h) => (h.Value ?? '').toLowerCase());
  const checks = [
    {
      name: 'BUNNY_STREAM_API_KEY es la API key de la biblioteca',
      ok: lib.ApiKey === input.env.apiKey,
      detail: `huella variable ${fingerprint(input.env.apiKey)} · Bunny ${fingerprint(lib.ApiKey)}`,
    },
    {
      name: 'BUNNY_STREAM_WEBHOOK_SECRET es la Read-only API key',
      ok: lib.ReadOnlyApiKey === input.env.webhookSecret,
      detail: `huella variable ${fingerprint(input.env.webhookSecret)} · Bunny ${fingerprint(lib.ReadOnlyApiKey)}`,
    },
    {
      name: 'BUNNY_STREAM_TOKEN_KEY es la clave de token de la CDN/embed',
      ok: pz.ZoneSecurityKey === input.env.tokenKey,
      detail: `huella variable ${fingerprint(input.env.tokenKey)} · Bunny ${fingerprint(pz.ZoneSecurityKey)}`,
    },
    {
      name: 'BUNNY_STREAM_CDN_HOSTNAME es un host de la zona',
      ok: hostnames.includes(input.env.cdnHostname.toLowerCase()),
      detail: `zona: ${hostnames.join(', ') || '—'}`,
    },
  ];
  return { library, pullZone, edgeRules, checks };
}

type FetchLike = typeof fetch;

export class BunnyAccountClient {
  constructor(
    private readonly accountKey: string,
    private readonly f: FetchLike = fetch,
    private readonly base = 'https://api.bunny.net',
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        AccessKey: this.accountKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bunny ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  getLibrary(id: string): Promise<LibraryState> {
    return this.call('GET', `/videolibrary/${id}`) as Promise<LibraryState>;
  }
  updateLibrary(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `/videolibrary/${id}`, patch);
  }
  getPullZone(id: number): Promise<PullZoneState> {
    return this.call('GET', `/pullzone/${id}`) as Promise<PullZoneState>;
  }
  updatePullZone(id: number, patch: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `/pullzone/${id}`, patch);
  }
  addEdgeRule(pullZoneId: number, rule: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `/pullzone/${pullZoneId}/edgerules/addOrUpdate`, rule);
  }
}
