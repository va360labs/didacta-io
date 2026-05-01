# mod.billing

Monetización via Stripe Checkout: vincular un curso a un Stripe Price, redirigir al alumno a pagar, y enrollarlo automáticamente al confirmar el pago vía webhook.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Alpha. MVP cubre pago único por curso. Suscripciones recurrentes y marketplace son módulos / sprints distintos.

## Resumen funcional

- Tenant admin liga `courseId` ↔ `stripePriceId` desde el admin panel.
- Alumno autenticado pulsa "Comprar" → backend crea Checkout Session → redirige al hosted checkout de Stripe.
- Al pagar, Stripe envía webhook `checkout.session.completed` → orden a `COMPLETED` + emit `billing.order.completed`.
- `mod.learning` escucha el evento y enrolla al alumno (source `PURCHASE`).
- Idempotencia garantizada: cada `evt_*` de Stripe se persiste y no se reprocesa.

## API pública

- `POST /modules/billing/checkout/:courseId` — alumno autenticado. Devuelve `{ url, sessionId }`. Redirige el front al `url`.
- `POST /modules/billing/webhook` — público (firma HMAC verificada). Cuerpo raw + cabecera `stripe-signature`.
- `GET /modules/billing/products` — admin. Lista productos del tenant.
- `POST /modules/billing/products` — admin. Crea producto `{ courseId, stripePriceId }` (cache de `unit_amount` y `currency` lookups).
- `PATCH /modules/billing/products/:id` — admin. Actualiza `active` o `stripePriceId`.
- `DELETE /modules/billing/products/:id` — admin. Borra producto (no afecta órdenes históricas).

## Modelo de datos

- `mod_billing_product` — un row por curso vendible. `unique(tenantId, courseId)` + `unique(tenantId, stripePriceId)`.
- `mod_billing_order` — una compra. Estado: `PENDING → COMPLETED | CANCELLED | FAILED | REFUNDED`.
- `mod_billing_webhook_event` — log idempotente. PK = `stripe_event_id`.

## Configuración

Set en runtime via env (apps/api):

| ENV                     | Qué                                                                             |
| ----------------------- | ------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | `sk_test_...` o `sk_live_...`. Sin esto, el módulo no bootea.                   |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` para verificar firma del webhook.                                   |
| `BILLING_SUCCESS_URL`   | URL absoluta (`{web_public}/cursos/{courseSlug}?paid=1`). Default sensato.      |
| `BILLING_CANCEL_URL`    | URL absoluta (`{web_public}/cursos/{courseSlug}?cancelled=1`). Default sensato. |

## Dependencias

- `mod.learning` ^1.0.0 — para enrollment tras pago. Listener vive en `mod.learning/src/index.ts`.
- `mod.courses` ^1.0.0 — para resolver `courseId` y mostrar precios en el catálogo.

## Eventos

- **Emite**: `billing.order.created`, `billing.order.completed`, `billing.order.failed`, `billing.order.refunded`.
- **Consume**: ninguno directamente (mod.learning consume `billing.order.completed`).

## Permisos

- `billing:product:read` — admin lee catálogo de productos.
- `billing:product:write` — admin crea/edita.
- `billing:order:read` — admin ve órdenes (audit).
- `billing:checkout:create` — alumno autenticado lanza checkout.

## Riesgos / fuera de alcance MVP

- **Compliance fiscal ES**: sin facturación SII / FacturaScripts. Va en `mod.facturascripts` (Sprint 7).
- **Suscripciones recurrentes**: este módulo solo cubre `mode: 'payment'`. Recurring va en `mod.subscriptions` (Sprint 3).
- **Cupones / descuentos**: no soportados aquí. Van en `mod.promotions` (Sprint 7).
- **Marketplace**: split de revenue requiere Stripe Connect. Va en `mod.marketplace` (Sprint 6).
- **Reembolsos**: el endpoint admin para reembolsar no está en MVP — se hacen desde dashboard Stripe. El webhook `charge.refunded` sí se procesa (marca order como REFUNDED).

## Tests

`pnpm --filter @didacta/mod-billing test` — vitest unit + fixtures de webhook Stripe.

Tests integración con Postgres real: ver `apps/api/tests/integration/billing.integration.test.ts` (suite ART-002 sigue patrón ART-025).
