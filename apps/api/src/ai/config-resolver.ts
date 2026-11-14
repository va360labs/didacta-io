/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyCipher } from './api-key-cipher';
import {
  ProviderNotConfiguredError,
  type ProviderId,
  type Purpose,
  type ResolvedProviderConfig,
} from './types/contracts';

/**
 * Resuelve la `ResolvedProviderConfig` para un (tenant, purpose).
 *
 * Orden:
 *   1. Fila en `tenant_ai_provider_config` con `enabled=true` para ese tenant+purpose.
 *   2. Default global del env (DEFAULT_AI_<PURPOSE>_PROVIDER + ..._API_KEY + opcional ..._MODEL + ..._BASE_URL).
 *   3. Si nada → ProviderNotConfiguredError.
 */
@Injectable()
export class AiConfigResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: ApiKeyCipher,
    private readonly logger: Logger,
  ) {}

  /**
   * ¿Tiene el aula de dónde sacar un proveedor para `purpose`? Mismo orden
   * que `resolve` (fila propia activa → default global del entorno), pero sin
   * descifrar nada ni lanzar: es la pregunta que se hace ANTES de intentar
   * algo que, sin proveedor, solo puede fallar (indexar para el tutor) o
   * enseñar una herramienta que no responde (el tutor al alumno).
   */
  async isConfigured(tenantId: string, purpose: Purpose): Promise<boolean> {
    const row = await this.prisma.tenantAiProviderConfig.findFirst({
      where: { tenantId, purpose, enabled: true },
      select: { id: true },
    });
    if (row) return true;
    const upper = purpose.toUpperCase();
    return Boolean(
      process.env[`DEFAULT_AI_${upper}_PROVIDER`] && process.env[`DEFAULT_AI_${upper}_API_KEY`],
    );
  }

  async resolve(tenantId: string, purpose: Purpose): Promise<ResolvedProviderConfig> {
    // 1. Tenant config
    const row = await this.prisma.tenantAiProviderConfig.findFirst({
      where: { tenantId, purpose, enabled: true },
    });

    if (row) {
      try {
        const apiKey = this.cipher.decrypt({
          cipher: row.apiKeyCipher,
          iv: row.apiKeyIv,
          tag: row.apiKeyTag,
        });
        const extraHeaders = (row.extraHeaders as Record<string, string>) ?? {};
        return {
          provider: row.provider as ProviderId,
          model: row.model,
          apiKey,
          baseUrl: row.baseUrl ?? undefined,
          extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        };
      } catch (err) {
        this.logger.error(
          { tenantId, purpose, err: err instanceof Error ? err.message : String(err) },
          'Fallo al descifrar API key del tenant. Cayendo a default global.',
        );
      }
    }

    // 2. Default global
    const upper = purpose.toUpperCase();
    const provider = process.env[`DEFAULT_AI_${upper}_PROVIDER`] as ProviderId | undefined;
    const apiKey = process.env[`DEFAULT_AI_${upper}_API_KEY`];
    const model = process.env[`DEFAULT_AI_${upper}_MODEL`] ?? '';
    const baseUrl = process.env[`DEFAULT_AI_${upper}_BASE_URL`];

    if (!provider || !apiKey) {
      throw new ProviderNotConfiguredError(tenantId, purpose);
    }

    return {
      provider,
      model,
      apiKey,
      baseUrl,
    };
  }
}
