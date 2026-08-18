/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * WebhooksService — 10º piloto License SDK
 * (capability `feat:api.webhooks.high_throughput`).
 *
 * Responsabilidades:
 *   - CRUD de endpoints con límites según tier.
 *   - Envío outbound: comunidad → naive síncrono (fetch + 1 reintento, sin
 *     firma); enterprise → delega al `WebhooksEEDispatcher` si está inyectado
 *     y la capability está activa (cola BullMQ + HMAC + dead-letter).
 *
 * Decisiones de diseño:
 *   - El service NO importa el archivo `.ee.ts` directamente — el dispatcher
 *     EE se inyecta por token (`WEBHOOKS_EE_DISPATCHER_TOKEN`). Esto preserva
 *     la convención de open-core (un archivo CE no puede `import` estático
 *     de un EE) y permite tests donde se inyecta el dispatcher para verificar
 *     el routing.
 *   - El secret se genera con `randomBytes(32)` si el cliente no lo provee.
 *     Se guarda en plano (necesario para HMAC en path EE). La RLS por
 *     tenant_id es la barrera de aislamiento.
 *   - El gating runtime se evalúa por dispatch: cambiar la licencia en runtime
 *     cambia el comportamiento sin reinicio. Patrón idéntico al
 *     RateLimitService del 6º piloto.
 *   - Los CRUD endpoints están autenticados a nivel controller (JwtAuthGuard).
 *     El service confía en el caller — recibe `tenantId` como parámetro y NO
 *     re-verifica permisos. Mantener consistente con
 *     RateLimitService / SamlService / WhiteLabelService.
 */

import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { LicenseService } from '@didacta/license-sdk';
import { Logger as PinoLogger } from 'nestjs-pino';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  KNOWN_EVENT_TYPES,
  WEBHOOKS_EE_DISPATCHER_TOKEN,
  WEBHOOKS_HIGH_THROUGHPUT_CAPABILITY,
  resolveWebhooksConfig,
  type CreateEndpointDto,
  type UpdateEndpointDto,
  type WebhookDeliveryResult,
  type WebhookDispatchMeta,
  type WebhookEndpointPublic,
  type WebhookEndpointWithSecret,
  type WebhookEnvelope,
  type WebhookLearner,
  type WebhooksConfig,
  type WebhooksEEDispatcher,
  type WebhooksInfoResponse,
  type WebhooksTier,
} from './webhooks.types';

/** Limit excedido — el controller lo traduce a 422. */
export class WebhookLimitExceededError extends Error {
  constructor(
    public readonly limit: 'endpoints' | 'eventTypes',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookLimitExceededError';
  }
}

/** URL ya registrada para este tenant — el controller lo traduce a 409. */
export class WebhookDuplicateUrlError extends Error {
  constructor(url: string) {
    super(`Ya existe un endpoint para la URL ${url} en este tenant.`);
    this.name = 'WebhookDuplicateUrlError';
  }
}

@Injectable()
export class WebhooksService {
  private readonly config: WebhooksConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly license: LicenseService,
    @Optional()
    @Inject(WEBHOOKS_EE_DISPATCHER_TOKEN)
    private readonly eeDispatcher: WebhooksEEDispatcher | null = null,
    @Optional() private readonly logger?: PinoLogger,
  ) {
    this.config = resolveWebhooksConfig();
  }

  // -----------------------------------------------------------------------
  // Tier resolution
  // -----------------------------------------------------------------------

  getCurrentTier(): WebhooksTier {
    return this.license.isCapabilityEnabled(WEBHOOKS_HIGH_THROUGHPUT_CAPABILITY)
      ? 'enterprise'
      : 'community';
  }

  getConfig(): WebhooksConfig {
    return this.config;
  }

  /** Info para `GET /webhooks/info` (UI lo consume al pintar el panel). */
  getInfo(): WebhooksInfoResponse {
    const tier = this.getCurrentTier();
    const limits = tier === 'enterprise' ? this.config.enterprise : this.config.community;
    return {
      tier,
      capability: WEBHOOKS_HIGH_THROUGHPUT_CAPABILITY,
      limits: {
        maxEndpoints: limits.maxEndpoints,
        maxEventsPerEndpoint: limits.maxEventsPerEndpoint,
      },
      community: {
        maxEndpoints: this.config.community.maxEndpoints,
        maxEventsPerEndpoint: this.config.community.maxEventsPerEndpoint,
      },
      enterprise: {
        maxEndpoints: this.config.enterprise.maxEndpoints,
        maxEventsPerEndpoint: this.config.enterprise.maxEventsPerEndpoint,
      },
      knownEventTypes: [...KNOWN_EVENT_TYPES],
    };
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  async listEndpoints(tenantId: string): Promise<WebhookEndpointPublic[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toPublic(r));
  }

  async getEndpoint(tenantId: string, id: string): Promise<WebhookEndpointPublic> {
    const row = await this.prisma.webhookEndpoint.findFirst({
      where: { id, tenantId },
    });
    if (!row)
      throw new NotFoundException({
        message: 'Endpoint no encontrado',
        code: 'WEBHOOKS_ENDPOINT_NOT_FOUND',
      });
    return this.toPublic(row);
  }

  async createEndpoint(
    tenantId: string,
    dto: CreateEndpointDto,
  ): Promise<WebhookEndpointWithSecret> {
    const tier = this.getCurrentTier();
    const limits = tier === 'enterprise' ? this.config.enterprise : this.config.community;

    // 1. Límite de endpoints por tenant.
    const existing = await this.prisma.webhookEndpoint.count({ where: { tenantId } });
    if (existing >= limits.maxEndpoints) {
      throw new WebhookLimitExceededError(
        'endpoints',
        `Tu plan ${tier} permite máximo ${limits.maxEndpoints} endpoint(s) por tenant. ` +
          (tier === 'community'
            ? 'Actualiza a Enterprise para aumentar el límite.'
            : 'Borra alguno para liberar cupo.'),
      );
    }

    // 2. Límite de event types por endpoint (community).
    if (
      limits.maxEventsPerEndpoint > 0 &&
      dto.eventTypes.length > limits.maxEventsPerEndpoint &&
      // Si solo es '*' lo permitimos siempre — es 1 entrada lógica.
      !(dto.eventTypes.length === 1 && dto.eventTypes[0] === '*')
    ) {
      throw new WebhookLimitExceededError(
        'eventTypes',
        `Tu plan ${tier} permite máximo ${limits.maxEventsPerEndpoint} tipos de eventos ` +
          `por endpoint. Actualiza a Enterprise para suscribirte a más.`,
      );
    }

    // 3. URL duplicada por tenant.
    const dup = await this.prisma.webhookEndpoint.findFirst({
      where: { tenantId, url: dto.url },
      select: { id: true },
    });
    if (dup) throw new WebhookDuplicateUrlError(dto.url);

    const secret = dto.secret ?? this.generateSecret();
    const created = await this.prisma.webhookEndpoint.create({
      data: {
        tenantId,
        url: dto.url,
        secret,
        eventTypes: dto.eventTypes,
        active: dto.active ?? true,
      },
    });

    return {
      ...this.toPublic(created),
      secret,
    };
  }

  async updateEndpoint(
    tenantId: string,
    id: string,
    dto: UpdateEndpointDto,
  ): Promise<WebhookEndpointWithSecret | WebhookEndpointPublic> {
    const tier = this.getCurrentTier();
    const limits = tier === 'enterprise' ? this.config.enterprise : this.config.community;

    const current = await this.prisma.webhookEndpoint.findFirst({
      where: { id, tenantId },
    });
    if (!current)
      throw new NotFoundException({
        message: 'Endpoint no encontrado',
        code: 'WEBHOOKS_ENDPOINT_NOT_FOUND',
      });

    // Validaciones cuando hay cambios sensibles.
    if (dto.eventTypes) {
      if (
        limits.maxEventsPerEndpoint > 0 &&
        dto.eventTypes.length > limits.maxEventsPerEndpoint &&
        !(dto.eventTypes.length === 1 && dto.eventTypes[0] === '*')
      ) {
        throw new WebhookLimitExceededError(
          'eventTypes',
          `Tu plan ${tier} permite máximo ${limits.maxEventsPerEndpoint} tipos de eventos ` +
            `por endpoint.`,
        );
      }
    }

    if (dto.url && dto.url !== current.url) {
      const dup = await this.prisma.webhookEndpoint.findFirst({
        where: { tenantId, url: dto.url, NOT: { id } },
        select: { id: true },
      });
      if (dup) throw new WebhookDuplicateUrlError(dto.url);
    }

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        url: dto.url ?? undefined,
        eventTypes: dto.eventTypes ?? undefined,
        secret: dto.secret ?? undefined,
        active: dto.active ?? undefined,
      },
    });

    // Si rotó secret, devolverlo en plano (one-shot para que el cliente lo guarde).
    if (dto.secret) {
      return { ...this.toPublic(updated), secret: dto.secret };
    }
    return this.toPublic(updated);
  }

  async deleteEndpoint(tenantId: string, id: string): Promise<void> {
    // Idempotente: si ya no existe, devuelve 204 igual.
    await this.prisma.webhookEndpoint.deleteMany({ where: { id, tenantId } });
  }

  // -----------------------------------------------------------------------
  // Dispatch — entry point que llama el bridge tras cada evento del bus.
  // -----------------------------------------------------------------------

  /**
   * Reenvía un evento de dominio a TODOS los endpoints suscritos del tenant.
   * El comportamiento depende del tier:
   *
   *   - tier=enterprise + dispatcher EE inyectado → encola en BullMQ.
   *   - tier=community o EE no inyectado → envío naive síncrono best-effort.
   *
   * Errores en envíos individuales se loggean pero NO propagan (un endpoint
   * caído no debe romper el procesamiento del resto).
   *
   * Devuelve los resultados del path naive (útil para tests). Path EE devuelve
   * arr vacío — la entrega es asíncrona via worker.
   */
  async dispatch(
    tenantId: string,
    eventType: string,
    payload: unknown,
    meta: WebhookDispatchMeta = {},
  ): Promise<WebhookDeliveryResult[]> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { tenantId, active: true },
    });
    if (endpoints.length === 0) return [];

    // Filtramos por suscripción al tipo de evento.
    const matching = endpoints.filter((e) => this.endpointMatches(e.eventTypes, eventType));
    if (matching.length === 0) return [];

    const tier = this.getCurrentTier();

    // La identidad se resuelve UNA vez por evento, no una por endpoint: el
    // lookup es el mismo para todos los suscritos.
    const learner = await this.resolveLearner(tenantId, payload, meta.actorUserId);
    const occurredAt = meta.occurredAt ?? new Date().toISOString();

    // Path EE: cola asíncrona. Importante: solo si dispatcher inyectado.
    if (tier === 'enterprise' && this.eeDispatcher) {
      for (const e of matching) {
        const envelope = this.buildEnvelope({
          tenantId,
          endpointId: e.id,
          eventType,
          payload,
          learner,
          occurredAt,
          idempotencyKey: meta.idempotencyKey,
        });
        try {
          await this.eeDispatcher.dispatch({
            tenantId,
            endpointId: e.id,
            url: e.url,
            secret: e.secret,
            eventType,
            payload,
            envelope,
          });
        } catch (err) {
          this.logger?.warn(
            { err: (err as Error).message, endpointId: e.id, eventType },
            'Webhook EE dispatch enqueue falló — fallback naive',
          );
          // Si el dispatcher EE falla al encolar (Redis caído), caemos al
          // path naive para no perder el evento.
          await this.deliverNaive(e.id, e.url, eventType, envelope);
        }
      }
      return [];
    }

    // Path community: naive síncrono.
    const results: WebhookDeliveryResult[] = [];
    for (const e of matching) {
      const envelope = this.buildEnvelope({
        tenantId,
        endpointId: e.id,
        eventType,
        payload,
        learner,
        occurredAt,
        idempotencyKey: meta.idempotencyKey,
      });
      const r = await this.deliverNaive(e.id, e.url, eventType, envelope);
      results.push(r);
    }
    return results;
  }

  /**
   * Compone el sobre que viaja por el cable. Igual en los dos tiers — el EE
   * solo le anade `attempt` al serializar.
   */
  private buildEnvelope(input: {
    tenantId: string;
    endpointId: string;
    eventType: string;
    payload: unknown;
    learner: WebhookLearner | null;
    occurredAt: string;
    idempotencyKey?: string;
  }): WebhookEnvelope {
    return {
      event: input.eventType,
      data: input.payload,
      occurredAt: input.occurredAt,
      tenantId: input.tenantId,
      deliveryId: this.buildDeliveryId(input.endpointId, input.idempotencyKey),
      learner: input.learner,
    };
  }

  /**
   * Identificador de entrega, ESTABLE entre reintentos y entre reentregas del
   * outbox: es lo que permite al receptor deduplicar. Se deriva del
   * `idempotencyKey` del evento —que el outbox ya usa como clave— acotado al
   * endpoint, para que dos endpoints suscritos al mismo evento no compartan
   * id. Sin idempotencyKey (dispatch manual o test) cae a un uuid: no hay
   * nada de lo que derivar estabilidad.
   */
  private buildDeliveryId(endpointId: string, idempotencyKey?: string): string {
    if (!idempotencyKey) return `wd_${randomUUID().replace(/-/g, '')}`;
    const hex = createHash('sha256').update(`${endpointId}:${idempotencyKey}`).digest('hex');
    return `wd_${hex.slice(0, 32)}`;
  }

  /**
   * Resuelve la persona del evento a `{id, email, name, externalSource,
   * externalId}`.
   *
   * El sujeto es `data.userId` cuando el payload lo trae, y solo si no,
   * `metadata.userId`. El orden importa y no es intercambiable: en
   * `learning.enrollment.created` el publisher pasa el ACTOR en los metadatos
   * (un admin, o nadie si vino de `/inscribe`) y el ALUMNO dentro del payload.
   * Al reves se le atribuiria la matricula al administrador que la creo.
   *
   * Nunca lanza: un webhook que no puede decir quien es sigue siendo mejor
   * que un webhook que no sale. `learner: null` es un estado legitimo — hay
   * eventos sin persona (`subscriptions.invoice.refunded` se publica con
   * `userId: null`).
   */
  private async resolveLearner(
    tenantId: string,
    payload: unknown,
    actorUserId?: string,
  ): Promise<WebhookLearner | null> {
    const fromPayload =
      payload !== null &&
      typeof payload === 'object' &&
      typeof (payload as { userId?: unknown }).userId === 'string'
        ? (payload as { userId: string }).userId
        : null;
    const userId = fromPayload ?? actorUserId ?? null;
    if (!userId) return null;

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          tenantId: true,
          email: true,
          name: true,
          externalSource: true,
          externalId: true,
        },
      });
      // Fila de otro tenant: no se filtra fuera del tenant que la pidio.
      if (!user || user.tenantId !== tenantId) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        externalSource: user.externalSource ?? null,
        externalId: user.externalId ?? null,
      };
    } catch (err) {
      this.logger?.warn(
        { err: (err as Error).message, tenantId, userId },
        'Webhooks: no se pudo resolver la identidad del alumno — se envia learner: null',
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Naive sender: POST JSON con timeout 5s y un reintento inmediato. Sin
   * firma HMAC (eso es path EE). Errores se silencian — el caller no
   * debe romper si un endpoint está caído.
   *
   * El cuerpo es el sobre completo (`WebhookEnvelope`), idéntico al del path
   * EE salvo `attempt`: quien integre contra community no tiene que reescribir
   * el parser al pasar a Enterprise.
   */
  private async deliverNaive(
    endpointId: string,
    url: string,
    eventType: string,
    envelope: WebhookEnvelope,
  ): Promise<WebhookDeliveryResult> {
    const start = Date.now();
    const body = JSON.stringify(envelope);
    const maxAttempts = 1 + this.config.communityRetries;
    let lastError: string | undefined;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Didacta-Event': eventType,
            // Estable entre reintentos — es la clave de deduplicacion del
            // receptor. El numero de intento va en su propia cabecera.
            'X-Didacta-Delivery': envelope.deliveryId,
            'X-Didacta-Attempt': String(attempt),
            'X-Didacta-Tenant': envelope.tenantId,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastStatus = res.status;
        if (res.ok) {
          return {
            endpointId,
            url,
            eventType,
            status: 'success',
            httpStatus: res.status,
            attempts: attempt,
            durationMs: Date.now() - start,
          };
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        clearTimeout(timer);
        lastError = (err as Error).message;
      }

      // Backoff entre intentos (solo si quedan).
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, this.config.communityRetryDelayMs));
      }
    }

    this.logger?.warn(
      { endpointId, url, eventType, lastError, attempts: maxAttempts },
      'Webhook delivery falló tras todos los reintentos (community)',
    );

    return {
      endpointId,
      url,
      eventType,
      status: 'failure',
      httpStatus: lastStatus,
      attempts: maxAttempts,
      durationMs: Date.now() - start,
      error: lastError,
    };
  }

  /**
   * Determina si la lista de eventTypes suscritos cubre `eventType`.
   * Reglas:
   *   - lista vacía → no hace match (NO enviamos por defecto).
   *   - `'*'` → match cualquier evento.
   *   - prefix wildcard `'learning.*'` → match cualquier evento que empiece por `learning.`.
   *   - exact match → caso normal.
   */
  endpointMatches(eventTypes: string[], eventType: string): boolean {
    if (!eventTypes || eventTypes.length === 0) return false;
    for (const sub of eventTypes) {
      if (sub === '*') return true;
      if (sub === eventType) return true;
      if (sub.endsWith('.*')) {
        const prefix = sub.slice(0, -2);
        if (eventType.startsWith(`${prefix}.`)) return true;
      }
    }
    return false;
  }

  private generateSecret(): string {
    return `whsec_${randomBytes(32).toString('hex')}`;
  }

  private toPublic(row: {
    id: string;
    tenantId: string;
    url: string;
    secret: string;
    eventTypes: string[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): WebhookEndpointPublic {
    return {
      id: row.id,
      tenantId: row.tenantId,
      url: row.url,
      secretMasked: this.maskSecret(row.secret),
      eventTypes: row.eventTypes,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private maskSecret(secret: string): string {
    if (!secret) return '';
    if (secret.length <= 4) return '*'.repeat(secret.length);
    return `${'*'.repeat(Math.min(8, secret.length - 4))}${secret.slice(-4)}`;
  }
}
