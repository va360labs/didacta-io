/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * TelemetryHeartbeatService — latido anónimo de instalación viva.
 *
 * TODA instalación (Community o Enterprise) envía un ping diario con un id
 * de instancia ALEATORIO persistido en disco + versión + edición + node/OS.
 * Es lo que permite saber cuántas instalaciones existen. Cero PII, cero
 * datos de negocio: eso es el nivel opt-in (RegistryService), no este.
 *
 * Contrato con el operador (documentado en README § Telemetría):
 *   - Se desactiva con `DIDACTA_TELEMETRY_DISABLED=true`. Sin trucos: un
 *     env y no vuelve a sonar.
 *   - El id (`.didacta-instance-id` en el volumen persistente) es un UUID
 *     generado en la primera ejecución; borrarlo genera otro.
 *   - Los fallos de red son SIEMPRE silenciosos (debug): una instalación
 *     air-gapped funciona exactamente igual.
 */

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LicenseService, RegistryClient, type Heartbeat } from '@didacta/license-sdk';
import { resolvePersistentDataRoot } from '../modules/persistent-data-root';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TelemetryHeartbeatService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelemetryHeartbeatService.name);
  private client: RegistryClient | null = null;
  /** Id efímero si el disco no deja persistir (RO, permisos). */
  private ephemeralId: string | null = null;

  constructor(private readonly license: LicenseService) {}

  onApplicationBootstrap(): void {
    if (!this.enabled()) {
      this.logger.log('Telemetría anónima desactivada (DIDACTA_TELEMETRY_DISABLED).');
      return;
    }
    this.logger.log(
      'Telemetría anónima activada: latido diario sin PII (id de instancia + versión + edición). Se desactiva con DIDACTA_TELEMETRY_DISABLED=true.',
    );
    const first = setTimeout(() => void this.sendNow(), INITIAL_DELAY_MS);
    const daily = setInterval(() => void this.sendNow(), INTERVAL_MS);
    // Los timers no deben mantener vivo el proceso en el shutdown.
    first.unref();
    daily.unref();
  }

  enabled(): boolean {
    const flag = (process.env['DIDACTA_TELEMETRY_DISABLED'] ?? '').trim().toLowerCase();
    if (flag === 'true' || flag === '1' || flag === 'yes') return false;
    return process.env['NODE_ENV'] !== 'test';
  }

  buildHeartbeat(): Heartbeat {
    const state = this.license.getState();
    const edition =
      state.status === 'community' ? 'community' : (state.subject?.plan ?? state.status);
    return {
      instanceId: this.instanceId(),
      version:
        process.env['DIDACTA_CORE_VERSION'] ?? process.env['npm_package_version'] ?? 'unknown',
      edition,
      node: process.version,
      os: `${process.platform}/${process.arch}`,
      sentAt: new Date().toISOString(),
    };
  }

  async sendNow(): Promise<boolean> {
    try {
      if (!this.client) {
        const baseUrl =
          process.env['DIDACTA_TELEMETRY_URL'] ?? process.env['DIDACTA_REGISTRY_URL'] ?? undefined;
        this.client = new RegistryClient({ baseUrl, timeoutMs: 5_000 });
      }
      await this.client.sendHeartbeat(this.buildHeartbeat());
      return true;
    } catch (err) {
      // Nunca ruido: sin receptor desplegado (o air-gapped) esto falla siempre
      // y la instalación no tiene por qué enterarse.
      this.logger.debug(`Latido de telemetría no entregado: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * UUID aleatorio persistido junto al secret de la instalación
   * (`.didacta-instance-id` en el volumen de datos). Fallback efímero si el
   * disco no permite escribir.
   */
  instanceId(): string {
    const filePath = resolve(resolvePersistentDataRoot(), '.didacta-instance-id');
    try {
      if (existsSync(filePath)) {
        const stored = readFileSync(filePath, 'utf8').trim();
        if (UUID_RE.test(stored)) return stored;
      }
      const generated = randomUUID();
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, generated, { encoding: 'utf8', mode: 0o600 });
      return generated;
    } catch {
      this.ephemeralId ??= randomUUID();
      return this.ephemeralId;
    }
  }
}
