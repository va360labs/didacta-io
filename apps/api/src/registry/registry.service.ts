/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RegistryService — gestiona el opt-in de la instalación Community contra
 * Cloud god (didacta.io). Persistencia local en `core_installation_registry`.
 *
 * Diseño:
 *   - Es singleton lógico: solo una fila NO-opted-out a la vez.
 *   - El admin hace opt-in con email + organización. Aceptación de términos
 *     se persiste con timestamp.
 *   - Si REGISTRY_URL está configurada (env DIDACTA_REGISTRY_URL), llamamos
 *     al RegistryClient del SDK para registrar contra Cloud god.
 *   - Si NO está configurada (típico durante alpha cerrada antes de que el
 *     servicio Cloud god exista), persistimos local y dejamos un TODO para
 *     reintentar cuando el endpoint esté operativo.
 *   - Telemetry diaria pendiente: cron real se añadirá cuando Cloud god
 *     tenga endpoint de ingesta. Por ahora `buildTelemetrySnapshot()` está
 *     listo para ser invocado.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  RegistryClient,
  type TelemetrySnapshot,
} from '@didacta/license-sdk';
import { LicenseService } from '@didacta/license-sdk';

export interface OptInInput {
  email: string;
  organizationName: string;
  deploymentUrl?: string;
  acceptTerms: true;
}

export interface RegistryStatus {
  registered: boolean;
  installationId: string | null;
  email: string | null;
  organizationName: string | null;
  deploymentUrl: string | null;
  optInAt: string | null;
  optedOutAt: string | null;
  lastTelemetryAt: string | null;
  telemetryEnabled: boolean;
  registryUrl: string | null;
  registryConnected: boolean;
}

@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);
  private client: RegistryClient | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly license: LicenseService,
  ) {}

  /**
   * Devuelve el estado actual del registro. Si hay registro activo (no
   * opted-out), devuelve sus campos. Si no, devuelve `registered: false`.
   */
  async getStatus(): Promise<RegistryStatus> {
    const row = await this.prisma.installationRegistry.findFirst({
      where: { optedOutAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const registryUrl = process.env['DIDACTA_REGISTRY_URL'] ?? null;

    if (!row) {
      return {
        registered: false,
        installationId: null,
        email: null,
        organizationName: null,
        deploymentUrl: null,
        optInAt: null,
        optedOutAt: null,
        lastTelemetryAt: null,
        telemetryEnabled: true,
        registryUrl,
        registryConnected: false,
      };
    }

    return {
      registered: true,
      installationId: row.installationId,
      email: row.email,
      organizationName: row.organizationName,
      deploymentUrl: row.deploymentUrl,
      optInAt: row.optInAt.toISOString(),
      optedOutAt: row.optedOutAt ? row.optedOutAt.toISOString() : null,
      lastTelemetryAt: row.lastTelemetryAt
        ? row.lastTelemetryAt.toISOString()
        : null,
      telemetryEnabled: row.telemetryEnabled,
      registryUrl,
      registryConnected: !!row.registryToken,
    };
  }

  /**
   * Activa el opt-in. Si ya existía un registro activo, lo reemplaza
   * (opted-out el anterior, crea nuevo) — caso típico: cambio de admin.
   */
  async optIn(input: OptInInput): Promise<RegistryStatus> {
    if (!input.acceptTerms) {
      throw new Error('Terms must be accepted to opt-in.');
    }

    const installationId = randomUUID();
    const now = new Date();

    // Si hay un registro activo, lo dejamos opt-out con motivo "replaced".
    await this.prisma.installationRegistry.updateMany({
      where: { optedOutAt: null },
      data: { optedOutAt: now, updatedAt: now },
    });

    const registryUrl = process.env['DIDACTA_REGISTRY_URL'];
    let registryToken: string | null = null;

    if (registryUrl) {
      try {
        if (!this.client) {
          this.client = new RegistryClient({ baseUrl: registryUrl });
        }
        const res = await this.client.register({
          email: input.email,
          organizationName: input.organizationName,
          deploymentUrl: input.deploymentUrl,
          acceptedTermsAt: now.toISOString(),
        });
        registryToken = res.registryToken;
        this.logger.log(
          `Registry: opt-in successful with Cloud god (installationId=${installationId}).`,
        );
      } catch (err) {
        this.logger.warn(
          `Registry: opt-in stored locally but Cloud god unreachable: ${(err as Error).message}. Will retry on next telemetry attempt.`,
        );
      }
    } else {
      this.logger.log(
        'Registry: opt-in stored locally. DIDACTA_REGISTRY_URL not set — telemetry will activate when Cloud god is configured.',
      );
    }

    await this.prisma.installationRegistry.create({
      data: {
        installationId,
        email: input.email,
        organizationName: input.organizationName,
        deploymentUrl: input.deploymentUrl ?? null,
        registryToken,
        termsAcceptedAt: now,
        optInAt: now,
      },
    });

    return this.getStatus();
  }

  /**
   * Opt-out RGPD. Marca el registro como opted-out + intenta notificar a
   * Cloud god para que borre los datos remotos (best-effort).
   */
  async optOut(): Promise<RegistryStatus> {
    const row = await this.prisma.installationRegistry.findFirst({
      where: { optedOutAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) {
      return this.getStatus();
    }

    const registryUrl = process.env['DIDACTA_REGISTRY_URL'];
    if (registryUrl && row.registryToken) {
      try {
        if (!this.client) {
          this.client = new RegistryClient({
            baseUrl: registryUrl,
            registryToken: row.registryToken,
          });
        }
        await this.client.unregister();
      } catch (err) {
        this.logger.warn(
          `Registry: opt-out applied locally but Cloud god unreachable for remote delete: ${(err as Error).message}. Manual cleanup may be needed.`,
        );
      }
    }

    await this.prisma.installationRegistry.update({
      where: { id: row.id },
      data: { optedOutAt: new Date() },
    });

    return this.getStatus();
  }

  /**
   * Construye un snapshot de telemetría agregada (sin PII). Se invoca
   * desde el cron diario (no implementado aún) o manualmente desde admin
   * para validar el flujo.
   */
  async buildTelemetrySnapshot(): Promise<TelemetrySnapshot | null> {
    const row = await this.prisma.installationRegistry.findFirst({
      where: { optedOutAt: null, telemetryEnabled: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) return null;

    // Métricas básicas — agregadas, sin nombres ni emails.
    const [users, courses] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.modCoursesCourse?.count?.({}).catch(() => 0) ?? 0,
    ]);

    const license = this.license.getState();

    return {
      installationId: row.installationId,
      version: process.env['npm_package_version'] ?? 'unknown',
      node: process.version,
      os: `${process.platform}/${process.arch}`,
      users,
      courses: typeof courses === 'number' ? courses : 0,
      activeUsers30d: 0, // TODO: query con login en 30d
      modulesInstalled: [], // TODO: leer de @didacta/core-registry
      capabilitiesActive: [...license.subject?.capabilities ?? []],
      licensePlan: license.subject?.plan ?? 'community',
      errorCount24h: 0, // TODO: query logs
      takenAt: new Date().toISOString(),
    };
  }
}
