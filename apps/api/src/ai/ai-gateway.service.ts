import { Injectable } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AiConfigResolver } from './config-resolver';
import { ProviderRegistry } from './provider-registry';
import {
  AiGatewayError,
  ProviderUnsupportedCapabilityError,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type EmbedInput,
  type EmbedResult,
} from './types/contracts';

/**
 * Punto de entrada único para todas las llamadas IA del backend (LMS-90.B).
 *
 * Cualquier service de un módulo (mod.ai-tutor, mod.ai-grader, mod.ai-content)
 * llama a `gateway.chat({ tenantId, ... })` o `gateway.embed({ tenantId, ... })`
 * sin saber qué provider real responde — el gateway resuelve la config del
 * tenant, escoge el adapter correcto y devuelve la respuesta normalizada.
 *
 * Centralización útil para:
 *   - Telemetría / logs / métricas Prometheus por provider+modelo+tenant.
 *   - Cost tracking unificado.
 *   - Rate limit / circuit breaker (futuro).
 *   - Fallback a otro provider si el primario está caído (futuro).
 */
@Injectable()
export class AiGatewayService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly resolver: AiConfigResolver,
    private readonly logger: Logger,
  ) {}

  async chat(args: {
    tenantId: string;
    input: ChatCompletionInput;
  }): Promise<ChatCompletionResult> {
    const config = await this.resolver.resolve(args.tenantId, 'chat');
    const adapter = this.registry.get(config.provider);
    if (!adapter) {
      throw new AiGatewayError(
        'AI_PROVIDER_UNKNOWN',
        `Provider ${config.provider} no está registrado en el gateway.`,
        config.provider,
      );
    }
    if (!adapter.capabilities.includes('chat')) {
      throw new ProviderUnsupportedCapabilityError(config.provider, 'chat');
    }

    const start = Date.now();
    try {
      const result = await adapter.chat(args.input, config);
      this.logger.log(
        {
          tenantId: args.tenantId,
          provider: result.provider,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: Date.now() - start,
        },
        'ai-gateway.chat ok',
      );
      return result;
    } catch (err) {
      this.logger.error(
        {
          tenantId: args.tenantId,
          provider: config.provider,
          err: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        },
        'ai-gateway.chat fail',
      );
      throw err;
    }
  }

  async embed(args: { tenantId: string; input: EmbedInput }): Promise<EmbedResult> {
    const config = await this.resolver.resolve(args.tenantId, 'embed');
    const adapter = this.registry.get(config.provider);
    if (!adapter) {
      throw new AiGatewayError(
        'AI_PROVIDER_UNKNOWN',
        `Provider ${config.provider} no está registrado en el gateway.`,
        config.provider,
      );
    }
    if (!adapter.capabilities.includes('embed')) {
      throw new ProviderUnsupportedCapabilityError(config.provider, 'embed');
    }

    const start = Date.now();
    try {
      const result = await adapter.embed(args.input, config);
      this.logger.log(
        {
          tenantId: args.tenantId,
          provider: result.provider,
          model: result.model,
          dimension: result.dimension,
          totalTokens: result.usage.totalTokens,
          batchSize: args.input.texts.length,
          durationMs: Date.now() - start,
        },
        'ai-gateway.embed ok',
      );
      return result;
    } catch (err) {
      this.logger.error(
        {
          tenantId: args.tenantId,
          provider: config.provider,
          err: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        },
        'ai-gateway.embed fail',
      );
      throw err;
    }
  }
}
