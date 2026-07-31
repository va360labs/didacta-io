/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RegistryClient — cliente del registro de instalaciones contra
 * `registry.didacta.io/registry/*`. Dos niveles:
 *
 *   1. HEARTBEAT anónimo (`sendHeartbeat`, sin token): latido diario que
 *      envía TODA instalación salvo opt-out por env. Solo cuenta
 *      instalaciones vivas: id de instancia aleatorio + versión + edición +
 *      node/OS. Cero PII, cero datos de negocio.
 *   2. Registro OPT-IN (`register` + `sendTelemetry`, con token): el operador
 *      se identifica (email + organización) a cambio de canal directo, y
 *      envía telemetría agregada más rica (usuarios, cursos, módulos…).
 *
 * NO envía PII en ningún nivel de telemetría. Política de reintentos:
 * simple. Si falla, no bloquea. Frecuencia recomendada: nightly.
 */

import { z } from 'zod';

const DEFAULT_REGISTRY_URL = 'https://registry.didacta.io/registry';
const DEFAULT_TIMEOUT_MS = 10_000;

export const registerInputSchema = z.object({
  email: z.string().email(),
  organizationName: z.string().min(1).max(200),
  deploymentUrl: z.string().url().optional(),
  acceptedTermsAt: z.string().datetime(),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;

export interface RegisterResponse {
  installationId: string;
  registryToken: string;
  privacyPolicyUrl: string;
}

export const telemetrySnapshotSchema = z.object({
  installationId: z.string().uuid(),
  version: z.string(),
  node: z.string(),
  os: z.string(),
  users: z.number().int().nonnegative(),
  courses: z.number().int().nonnegative(),
  activeUsers30d: z.number().int().nonnegative(),
  modulesInstalled: z.array(z.string()),
  capabilitiesActive: z.array(z.string()),
  licensePlan: z.string(),
  errorCount24h: z.number().int().nonnegative(),
  takenAt: z.string().datetime(),
});

export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>;

export const heartbeatSchema = z.object({
  /** UUID aleatorio persistido en la instalación. No identifica a nadie. */
  instanceId: z.string().uuid(),
  version: z.string(),
  /** 'community' o el plan de la licencia EE activa. */
  edition: z.string(),
  node: z.string(),
  os: z.string(),
  sentAt: z.string().datetime(),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export interface RegistryClientOptions {
  /** Base URL del servicio registry. Default https://cloud.didacta.io/registry. */
  baseUrl?: string;
  /** Token persistido tras `register()`. Necesario para `sendTelemetry()` y `unregister()`. */
  registryToken?: string;
  /** Timeout HTTP en ms. Default 10s. */
  timeoutMs?: number;
  /** Override de fetch (tests). */
  fetchImpl?: typeof fetch;
}

export class RegistryClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private registryToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RegistryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.registryToken = options.registryToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Registra esta instalación en Cloud god. Devuelve installationId + token
   * que el caller debe persistir para futuras llamadas.
   */
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const parsed = registerInputSchema.parse(input);
    const res = await this.requestJson<RegisterResponse>('POST', '/install', parsed);
    this.registryToken = res.registryToken;
    return res;
  }

  /**
   * Envía un snapshot de telemetría agregada. Idempotente — el servidor
   * deduplica por (installationId, takenAt).
   */
  async sendTelemetry(snapshot: TelemetrySnapshot): Promise<void> {
    const parsed = telemetrySnapshotSchema.parse(snapshot);
    if (!this.registryToken) {
      throw new Error(
        'Cannot send telemetry without a registry token. Call register() first or pass registryToken to the constructor.',
      );
    }
    await this.requestJson('POST', '/telemetry', parsed);
  }

  /**
   * Latido anónimo de instalación viva. NO requiere token ni opt-in: es el
   * contador de instalaciones del producto. El servidor deduplica por
   * instanceId y solo conserva agregados.
   */
  async sendHeartbeat(heartbeat: Heartbeat): Promise<void> {
    const parsed = heartbeatSchema.parse(heartbeat);
    await this.requestJson('POST', '/heartbeat', parsed);
  }

  /**
   * Desregistra esta instalación. Borra todos los datos en Cloud god (RGPD).
   */
  async unregister(): Promise<void> {
    if (!this.registryToken) return;
    await this.requestJson('DELETE', '/install');
    this.registryToken = undefined;
  }

  /**
   * Descarga todos los datos almacenados sobre esta instalación (RGPD).
   */
  async exportMyData(): Promise<unknown> {
    return this.requestJson<unknown>('GET', '/install/export');
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'didacta-license-sdk',
    };
    if (this.registryToken) {
      headers.authorization = `Bearer ${this.registryToken}`;
    }

    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Registry ${method} ${path} failed (${res.status}): ${text || res.statusText}`,
        );
      }

      // DELETE puede no devolver body.
      if (res.status === 204) return undefined as T;

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
