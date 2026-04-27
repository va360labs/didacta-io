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
}

/**
 * Cliente real (placeholder). Si se construye sin credenciales, todas las
 * operaciones lanzan `ZoomApiError`. La implementación viva llega en el PR
 * de integración Zoom S2S.
 */
export class RealZoomApiClient implements ZoomApiClient {
  constructor(
    private readonly _opts: {
      accountId: string;
      clientId: string;
      clientSecret: string;
    },
  ) {}

  async createMeeting(): Promise<ZoomMeetingCreateResult> {
    throw new ZoomApiError('Integración Zoom S2S no implementada todavía (placeholder).');
  }

  async deleteMeeting(): Promise<void> {
    throw new ZoomApiError('Integración Zoom S2S no implementada todavía (placeholder).');
  }

  async updateMeeting(): Promise<void> {
    throw new ZoomApiError('Integración Zoom S2S no implementada todavía (placeholder).');
  }
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
