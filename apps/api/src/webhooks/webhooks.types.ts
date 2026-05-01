/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos y DTOs del 10º piloto License SDK — gate
 * `feat:api.webhooks.high_throughput`.
 *
 * Modelo:
 *   - Plan Community: 1 endpoint por tenant, 3 tipos de eventos suscribibles
 *     como máximo. Envío naive síncrono (fetch + 1 reintento). Sin firma HMAC,
 *     sin dead-letter.
 *   - Plan Enterprise (capability `feat:api.webhooks.high_throughput`):
 *     20 endpoints por tenant, eventos ilimitados. Cola BullMQ
 *     `didacta.webhooks.outbound`, reintentos exponenciales, dead-letter
 *     persistido en `webhook_dead_letter`, firma HMAC-SHA256.
 *
 * Configurable vía env (todas opcionales):
 *   - WEBHOOKS_TIMEOUT_MS                 (default 5000)
 *   - WEBHOOKS_COMMUNITY_MAX_ENDPOINTS    (default 1)
 *   - WEBHOOKS_COMMUNITY_MAX_EVENTS       (default 3)
 *   - WEBHOOKS_ENTERPRISE_MAX_ENDPOINTS   (default 20)
 */

import { z } from 'zod';
import { LICENSE_CAPABILITIES, type LicenseCapability } from '@didacta/license-sdk';

/** Capability EE asociada al piloto. */
export const WEBHOOKS_HIGH_THROUGHPUT_CAPABILITY: LicenseCapability =
  LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT;

/** Tier efectivo del request — comunidad o enterprise. */
export type WebhooksTier = 'community' | 'enterprise';

/**
 * Configuración runtime resuelta desde env. Pensada para que tests construyan
 * variantes deterministas sin tocar process.env.
 */
export interface WebhooksConfig {
  community: {
    /** Máximo de endpoints por tenant en plan community. */
    maxEndpoints: number;
    /** Máximo de tipos de eventos suscribibles por endpoint. */
    maxEventsPerEndpoint: number;
  };
  enterprise: {
    maxEndpoints: number;
    /** EE no limita event types; el campo existe para simetría. */
    maxEventsPerEndpoint: number;
  };
  /** Timeout del HTTP POST a un endpoint (ms). */
  timeoutMs: number;
  /** Reintentos community (path naive). EE usa los del worker BullMQ. */
  communityRetries: number;
  /** Backoff entre intento 1 y reintento community (ms). */
  communityRetryDelayMs: number;
}

export const DEFAULT_WEBHOOKS_CONFIG: WebhooksConfig = {
  community: {
    maxEndpoints: 1,
    maxEventsPerEndpoint: 3,
  },
  enterprise: {
    maxEndpoints: 20,
    // 0 == sin límite. El service trata <=0 como ilimitado.
    maxEventsPerEndpoint: 0,
  },
  timeoutMs: 5_000,
  communityRetries: 1,
  communityRetryDelayMs: 250,
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveWebhooksConfig(): WebhooksConfig {
  return {
    community: {
      maxEndpoints: readPositiveIntEnv(
        'WEBHOOKS_COMMUNITY_MAX_ENDPOINTS',
        DEFAULT_WEBHOOKS_CONFIG.community.maxEndpoints,
      ),
      maxEventsPerEndpoint: readPositiveIntEnv(
        'WEBHOOKS_COMMUNITY_MAX_EVENTS',
        DEFAULT_WEBHOOKS_CONFIG.community.maxEventsPerEndpoint,
      ),
    },
    enterprise: {
      maxEndpoints: readPositiveIntEnv(
        'WEBHOOKS_ENTERPRISE_MAX_ENDPOINTS',
        DEFAULT_WEBHOOKS_CONFIG.enterprise.maxEndpoints,
      ),
      maxEventsPerEndpoint: DEFAULT_WEBHOOKS_CONFIG.enterprise.maxEventsPerEndpoint,
    },
    timeoutMs: readPositiveIntEnv('WEBHOOKS_TIMEOUT_MS', DEFAULT_WEBHOOKS_CONFIG.timeoutMs),
    communityRetries: DEFAULT_WEBHOOKS_CONFIG.communityRetries,
    communityRetryDelayMs: DEFAULT_WEBHOOKS_CONFIG.communityRetryDelayMs,
  };
}

// ---------------------------------------------------------------------------
// Zod schemas (DTO + validación entrada)
// ---------------------------------------------------------------------------

/**
 * URL HTTPS válida para el endpoint del webhook. Toleramos `http://` solo
 * cuando apunta a `localhost` / `127.0.0.1` para facilitar dev local.
 */
const webhookUrlSchema = z
  .string()
  .url('La URL debe ser absoluta (https://...).')
  .max(2048)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        if (u.protocol === 'https:') return true;
        if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    { message: 'Solo se permiten URLs https:// (o http://localhost para desarrollo).' },
  );

/** Lista de tipos de eventos. `'*'` = todos. */
const eventTypesSchema = z
  .array(z.string().min(1).max(120))
  .min(1, 'Suscríbete al menos a un tipo de evento (o ["*"] para todos).')
  .max(64);

/** DTO POST /webhooks/endpoints. */
export const createEndpointDtoSchema = z.object({
  url: webhookUrlSchema,
  eventTypes: eventTypesSchema,
  /**
   * Secret opcional. Si no lo manda el cliente, lo generamos en el backend
   * con `randomBytes(32).toString('hex')`. Es responsabilidad del cliente
   * guardarlo: tras este POST, el GET solo devuelve un sufijo enmascarado.
   */
  secret: z.string().min(16).max(256).optional(),
  active: z.boolean().optional(),
});
export type CreateEndpointDto = z.infer<typeof createEndpointDtoSchema>;

/** DTO PUT /webhooks/endpoints/:id. */
export const updateEndpointDtoSchema = z.object({
  url: webhookUrlSchema.optional(),
  eventTypes: eventTypesSchema.optional(),
  secret: z.string().min(16).max(256).optional(),
  active: z.boolean().optional(),
});
export type UpdateEndpointDto = z.infer<typeof updateEndpointDtoSchema>;

// ---------------------------------------------------------------------------
// Tipos de respuesta
// ---------------------------------------------------------------------------

/**
 * Vista pública de un endpoint — el secret NO se expone en GETs (solo
 * sufijo enmascarado). Tras crear/rotar el secret, el POST sí lo devuelve
 * one-shot para que el cliente lo guarde.
 */
export interface WebhookEndpointPublic {
  id: string;
  tenantId: string;
  url: string;
  /** Sufijo enmascarado del secret (últimos 4 chars). */
  secretMasked: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpointPublic {
  /** Secret en plano. Solo presente en la respuesta de POST/rotación. */
  secret: string;
}

/**
 * Resultado del envío naive (community). El path EE encola en BullMQ y no
 * devuelve resultado síncrono.
 */
export interface WebhookDeliveryResult {
  endpointId: string;
  url: string;
  eventType: string;
  status: 'success' | 'failure';
  httpStatus?: number;
  attempts: number;
  durationMs: number;
  error?: string;
}

export interface WebhooksInfoResponse {
  tier: WebhooksTier;
  capability: string;
  limits: {
    maxEndpoints: number;
    /** 0 = sin límite (solo aplica al tier enterprise). */
    maxEventsPerEndpoint: number;
  };
  community: {
    maxEndpoints: number;
    maxEventsPerEndpoint: number;
  };
  enterprise: {
    maxEndpoints: number;
    maxEventsPerEndpoint: number;
  };
  /**
   * Eventos conocidos por la plataforma a los que un endpoint puede
   * suscribirse. La lista se mantiene aquí para que la UI pueda renderizar
   * un multi-select sin segundo round-trip.
   */
  knownEventTypes: string[];
}

/**
 * Catálogo de eventos publicados por los bridges existentes. Mantenerlo
 * sincronizado a mano es aceptable para el piloto — cuando crezca, el
 * registry de módulos puede declarar sus events y este array se autogenera.
 */
export const KNOWN_EVENT_TYPES = [
  '*',
  'learning.enrollment.created',
  'learning.course.completed',
  'learning.lesson.completed',
  'community.post.created',
  'community.comment.created',
  'billing.subscription.created',
  'billing.subscription.cancelled',
  'fundae.group.closed',
  'assessments.attempt.submitted',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/**
 * Token DI para el dispatcher EE opcional. El community service lo inyecta
 * con `@Optional()`. Si está inyectado y la capability está activa, el
 * service delega la entrega; si no, usa el path naive.
 */
export const WEBHOOKS_EE_DISPATCHER_TOKEN = 'DIDACTA_WEBHOOKS_EE_DISPATCHER';

/**
 * Contrato mínimo que el dispatcher EE expone al community service.
 * El service NO importa el archivo `.ee.ts` directamente (eso violaría la
 * convención de open-core). Inyecta el dispatcher por token.
 */
export interface WebhooksEEDispatcher {
  dispatch(input: {
    tenantId: string;
    endpointId: string;
    url: string;
    secret: string;
    eventType: string;
    payload: unknown;
  }): Promise<void>;
}
