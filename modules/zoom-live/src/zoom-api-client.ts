/**
 * Cliente de la Zoom API (Server-to-Server OAuth).
 *
 * Stub por ahora: devuelve un meetingId determinístico y URLs `stub-zoom/`
 * para que el flujo end-to-end funcione en dev sin credenciales reales.
 *
 * La implementación real (PR siguiente) leerá `tenant_settings` (clave
 * `zoom-live.credentials`) con AES-256-GCM at-rest, generará un access token
 * via `https://zoom.us/oauth/token` con grant `account_credentials` y llamará
 * a `https://api.zoom.us/v2/users/{email}/meetings`.
 */

import { ZoomApiError } from './errors.js';

export interface ZoomMeetingCreateInput {
  hostEmail: string;
  topic: string;
  startTime: string;
  durationMinutes: number;
  timezone: string;
  description?: string;
}

export interface ZoomMeetingCreateResult {
  meetingId: string;
  joinUrl: string;
  startUrl: string;
}

export interface ZoomApiClient {
  createMeeting(input: ZoomMeetingCreateInput): Promise<ZoomMeetingCreateResult>;
  deleteMeeting(meetingId: string): Promise<void>;
  updateMeeting(meetingId: string, patch: Partial<ZoomMeetingCreateInput>): Promise<void>;
  /**
   * Smoke test: verifica que las credenciales son válidas haciendo el OAuth
   * handshake sin crear ningún meeting. Devuelve `accountId` echo para que
   * el admin confirme que matchea lo que configuró. Lanza `ZoomApiError` si
   * Zoom rechaza las credenciales.
   *
   * El stub responde con un accountId fake. El cliente real hace el OAuth
   * de verdad — útil para validar credenciales antes de operar.
   */
  testCredentials(): Promise<{ accountId: string }>;
}

/**
 * Stub determinístico: el meetingId es un hash del email + topic, las URLs
 * apuntan a un host falso. Útil en dev y tests.
 */
export class StubZoomApiClient implements ZoomApiClient {
  async createMeeting(input: ZoomMeetingCreateInput): Promise<ZoomMeetingCreateResult> {
    const meetingId = stableId(`${input.hostEmail}|${input.topic}|${input.startTime}`);
    return {
      meetingId,
      joinUrl: `https://stub-zoom.didacta.dev/j/${meetingId}`,
      startUrl: `https://stub-zoom.didacta.dev/s/${meetingId}?host=1`,
    };
  }

  async deleteMeeting(): Promise<void> {
    // Stub: no-op.
  }

  async updateMeeting(): Promise<void> {
    // Stub: no-op.
  }

  async testCredentials(): Promise<{ accountId: string }> {
    return { accountId: 'stub-account' };
  }
}

export interface ZoomS2SCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Cliente real Zoom Server-to-Server OAuth.
 *
 * Flow:
 *  1. POST `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=...`
 *     con `Authorization: Basic base64(clientId:clientSecret)` → devuelve
 *     access token con TTL 60 min. Cacheamos en memoria con expiry para no
 *     pedirlo en cada call.
 *  2. POST `https://api.zoom.us/v2/users/{hostEmail}/meetings` con bearer
 *     token y body `{ topic, type: 2 (scheduled), start_time, duration,
 *     timezone, agenda }` → devuelve `{ id, join_url, start_url }`.
 *
 * **Tipo 2 = scheduled meeting**. Otros tipos: 1 instant, 3 recurring no
 * fixed time, 8 recurring fixed time. Para Didacta usamos solo 2 en v0.2.
 *
 * Errores HTTP de Zoom se traducen a `ZoomApiError` con el mensaje legible.
 * Token rotation: si recibimos 401 Invalid token, limpiamos el cache y
 * reintentamos UNA vez antes de propagar el error.
 */
export class RealZoomApiClient implements ZoomApiClient {
  private cachedToken?: { token: string; expiresAt: number };

  constructor(private readonly creds: ZoomS2SCredentials) {}

  async createMeeting(input: ZoomMeetingCreateInput): Promise<ZoomMeetingCreateResult> {
    const body = {
      topic: input.topic,
      type: 2, // scheduled
      start_time: input.startTime,
      duration: input.durationMinutes,
      timezone: input.timezone,
      agenda: input.description ?? undefined,
      settings: {
        join_before_host: false,
        waiting_room: true,
        approval_type: 2, // no registration required
      },
    };
    const res = await this.zoomFetch(`/users/${encodeURIComponent(input.hostEmail)}/meetings`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      id: number;
      join_url: string;
      start_url: string;
    };
    return {
      meetingId: String(json.id),
      joinUrl: json.join_url,
      startUrl: json.start_url,
    };
  }

  async deleteMeeting(meetingId: string): Promise<void> {
    await this.zoomFetch(`/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
    });
  }

  async updateMeeting(meetingId: string, patch: Partial<ZoomMeetingCreateInput>): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.topic !== undefined) body['topic'] = patch.topic;
    if (patch.startTime !== undefined) body['start_time'] = patch.startTime;
    if (patch.durationMinutes !== undefined) body['duration'] = patch.durationMinutes;
    if (patch.timezone !== undefined) body['timezone'] = patch.timezone;
    if (patch.description !== undefined) body['agenda'] = patch.description;
    if (Object.keys(body).length === 0) return;
    await this.zoomFetch(`/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async testCredentials(): Promise<{ accountId: string }> {
    // Forzamos refresh del token para que sea un test real (no servir
    // un cached) y devolvemos el accountId que vino en las creds para
    // que el caller pueda mostrar feedback "vinculado a cuenta X".
    this.cachedToken = undefined;
    await this.getAccessToken();
    return { accountId: this.creds.accountId };
  }

  // ---- internals ----

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString(
      'base64',
    );
    const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(
      this.creds.accountId,
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ZoomApiError(`OAuth token request failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // 60s de margen para evitar usar un token a punto de expirar.
    this.cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    };
    return json.access_token;
  }

  private async zoomFetch(path: string, init: RequestInit): Promise<Response> {
    const doFetch = async (token: string): Promise<Response> =>
      fetch(`https://api.zoom.us/v2${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });

    let token = await this.getAccessToken();
    let res = await doFetch(token);

    // Token rotation: si Zoom dice "invalid token", refresh y reintenta una vez.
    if (res.status === 401) {
      this.cachedToken = undefined;
      token = await this.getAccessToken();
      res = await doFetch(token);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ZoomApiError(
        `Zoom API ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res;
  }
}

/**
 * Factory: si el tenant tiene credenciales válidas, devuelve `RealZoomApiClient`.
 * Si no, `StubZoomApiClient`. Validación es estructural; Zoom solo dice si
 * son válidas en el primer call (que se traduce a `ZoomApiError`).
 */
export function buildZoomApiClient(creds: unknown): ZoomApiClient {
  if (
    creds &&
    typeof creds === 'object' &&
    'accountId' in creds &&
    'clientId' in creds &&
    'clientSecret' in creds &&
    typeof (creds as ZoomS2SCredentials).accountId === 'string' &&
    typeof (creds as ZoomS2SCredentials).clientId === 'string' &&
    typeof (creds as ZoomS2SCredentials).clientSecret === 'string'
  ) {
    return new RealZoomApiClient(creds as ZoomS2SCredentials);
  }
  return new StubZoomApiClient();
}

/**
 * Hash determinístico → string de 11 dígitos (parecido al meetingId real
 * de Zoom). Usado por el stub para que la misma combinación
 * email+topic+startTime devuelva siempre el mismo meetingId.
 */
function stableId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  // Combina con un segundo round para que cubra los 11 dígitos.
  const second = (hash * 2654435761) >>> 0;
  return `${hash}${second}`.slice(0, 11);
}
