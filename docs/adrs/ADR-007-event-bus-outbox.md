# ADR-007 — Event bus: outbox + BullMQ + webhooks

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa

## Contexto

LearnShip emite eventos de dominio que otros módulos pueden consumir internamente y que también se proyectan como **webhooks externos** (integración principal: n8n). Requisitos:

- Garantía de entrega **at-least-once** con deduplicación por `idempotencyKey`.
- Eventos atómicos con la transacción de dominio: "si el curso se publica, el evento se emite; si no, no".
- Retry con backoff en caso de fallo del consumidor.
- Firma HMAC en webhooks outgoing.
- Observabilidad: saber cuántos eventos se emitieron y cuántos se entregaron.

Candidatos evaluados: Kafka, NATS, AWS EventBridge, Postgres-outbox.

## Decisión

**Outbox pattern** sobre Postgres + **BullMQ** (Redis) para workers + **webhooks HMAC**.

### Flujo

1. La lógica de dominio escribe el evento a `outbox_event` **en la misma transacción** que modifica el estado de negocio.
2. Un worker BullMQ poolea la tabla outbox, marca filas `processed_at` y despacha:
   - A handlers internos registrados en el `EventBus` del core.
   - A webhooks externos configurados por tenant (con firma HMAC).
3. En fallo, reencolar con backoff exponencial. Tras N reintentos, mover a dead letter queue.
4. Handlers son idempotentes por contrato (usan `idempotencyKey` para deduplicar).

### Estructura del evento

```ts
interface DomainEvent<T> {
  name: string; // 'courses.course.published'
  version: number; // 1
  data: T;
  metadata: {
    tenantId: string;
    userId?: string;
    timestamp: string;
    traceId: string;
    idempotencyKey: string;
  };
}
```

## Consecuencias

Positivas:

- **Transaccionalmente correcto**: no hay ventana donde el estado cambió pero el evento se perdió.
- **Retry robusto**: BullMQ provee backoff, dead letters y observabilidad out-of-the-box.
- **Idempotencia por contrato**: un handler que recibe dos veces el mismo `idempotencyKey` no duplica efectos.
- **Sin infra nueva**: Redis y Postgres ya están en el stack. Cero operativas extra.
- **Integración n8n natural**: webhooks + catálogo de eventos documentado.

Negativas / riesgos:

- **Latencia del polling**: el worker poolea la outbox periódicamente (configurable, default 1s). Para eventos casi-síncronos (ej. notificar en UI al emitir) hay latencia perceptible. **Mitigación**: `LISTEN/NOTIFY` de Postgres para despertar al worker inmediatamente.
- **Query extra al outbox** en cada transacción con eventos: coste aceptable (un INSERT).
- **Escalado del worker**: si la tasa de eventos supera lo que un worker procesa, escalar horizontal. BullMQ soporta múltiples workers en paralelo.

## Alternativas consideradas

- **Kafka**: rechazado para Fase 1 por overhead operacional (Zookeeper/KRaft, topics, consumers). Excelente para Fase 3+ si la escala lo requiere.
- **AWS EventBridge**: rechazado: estamos en Hetzner, no en AWS.
- **NATS / RabbitMQ**: interesantes pero añaden infra. Outbox sobre Postgres cubre los requisitos de Fase 1-2.
- **Event streams directos sin outbox**: rechazado por la ventana de inconsistencia (estado commiteado sin evento emitido).

## Observabilidad

- Métricas por evento: cuántos en la outbox, processed, failed, avg latency.
- Dashboard Grafana (Fase 1.A) con volumen diario por `eventName`.
- Alertas si dead letter queue crece por encima de umbral.

## Referencias

- `packages/database/prisma/schema.prisma` (modelos `OutboxEvent`, `Webhook`)
- `@learnship/core-kernel` (interfaz `EventBus`)
- `docs/PRD.md` §11
- [Microservices.io – Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)
