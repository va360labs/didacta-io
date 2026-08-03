# mod.subscriptions

Suscripciones recurrentes (mensuales/anuales) con Stripe. Extiende `mod.billing` (pago único) sin compartir tablas — comunicación por eventos.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Alpha. MVP cubre suscripción recurrente por curso, grace period configurable tras impago, dunning vía reintentos automáticos de Stripe, y cancelación al final del periodo o inmediata.

## Resumen funcional

- Admin liga `courseId` ↔ `stripePriceId` recurring (igual que mod.billing pero con price recurring).
- Alumno autenticado pulsa "Suscribirme" → backend crea Checkout Session `mode='subscription'` → redirige al hosted checkout.
- Stripe envía webhooks (`customer.subscription.*`, `invoice.*`) → service actualiza estado local + emite eventos.
- `mod.learning` escucha:
  - `subscriptions.subscription.activated` → enrolla.
  - `subscriptions.subscription.unpaid` → pausa enrollment (grace expirado).
  - `subscriptions.subscription.canceled` (immediate=true) → desenrolla.
- Grace period (default 3 días) tras `invoice.payment_failed`. Si Stripe cobra antes de que expire → vuelve a ACTIVE. Si expira sin pago → UNPAID + bridge pausa.
- Cron horario recorre subs PAST_DUE con `gracePeriodEndsAt < now`: barrido `findTenantsWithExpiredGrace()` + `expireGracePeriodsForTenant()` por tenant (el worker del host escopa cada tenant en su contexto RLS); `expireGracePeriods()` conserva la composición global.

## API pública

- `POST /modules/subscriptions/checkout/:courseId` — alumno autenticado. Body `{ stripePriceId }`. Devuelve `{ url, sessionId }`.
- `GET /modules/subscriptions/me` — alumno. Lista sus suscripciones (todas, incluyendo CANCELED para historial).
- `GET /modules/subscriptions/me/:id/invoices` — alumno. Lista facturas de una sub propia.
- `POST /modules/subscriptions/me/:id/cancel` — alumno. Body `{ immediate?: boolean }`. Default cancela al final del periodo (mantiene acceso hasta currentPeriodEnd).
- `POST /modules/subscriptions/webhook` — público, firma HMAC.

## Modelo de datos

- `mod_subscriptions_subscription` — una row por (tenant, user, course) viva. Status enum: `PENDING | ACTIVE | PAST_DUE | UNPAID | CANCELED`.
- `mod_subscriptions_invoice` — una row por invoice de Stripe (FK lógica a subscription).
- `mod_subscriptions_webhook_event` — log idempotente.

## Configuración

| ENV                               | Qué                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`               | `sk_test_...` o `sk_live_...`. Compartida con mod.billing si activos a la vez.                    |
| `STRIPE_WEBHOOK_SECRET`           | `whsec_...` específico del endpoint webhook de subscriptions (puede ser distinto del de billing). |
| `SUBSCRIPTIONS_SUCCESS_URL_BASE`  | Default `${WEB_PUBLIC_URL}/cuenta/suscripciones?status=success`.                                  |
| `SUBSCRIPTIONS_CANCEL_URL_BASE`   | Default `${WEB_PUBLIC_URL}/cuenta/suscripciones?status=cancel`.                                   |
| `SUBSCRIPTIONS_GRACE_PERIOD_DAYS` | Default 3. Días desde primer fallo de cobro hasta `UNPAID`.                                       |

Sin `STRIPE_SECRET_KEY` o `STRIPE_WEBHOOK_SECRET`, el módulo NO arranca y los endpoints devuelven 503.

## Dependencias

- `mod.learning` ^1.0.0 — bridge enrolla/pausa/desenrolla escuchando eventos.
- `mod.courses` ^1.0.0 — resolver courseId.

## Eventos

**Emite**:

- `subscriptions.subscription.created` — al crear checkout session (estado PENDING).
- `subscriptions.subscription.activated` — al recibir `customer.subscription.created` con status ACTIVE, o tras recovery desde PAST_DUE/UNPAID.
- `subscriptions.subscription.past_due` — primer fallo de invoice.
- `subscriptions.subscription.unpaid` — grace expirado sin pago. **Bridge: pausa enrollment.**
- `subscriptions.subscription.canceled` — cancelación efectiva inmediata. **Bridge: desenrolla.**
- `subscriptions.invoice.paid` — factura cobrada (recovery o renovación normal).
- `subscriptions.invoice.payment_failed` — Stripe falló cobro de un invoice.

**Consume**: ninguno.

## Permisos

- `subscriptions:subscription:read` — alumno ve sus suscripciones; admin ve todas (admin endpoint en roadmap).
- `subscriptions:subscription:create` — alumno autenticado lanza checkout.
- `subscriptions:subscription:cancel` — alumno cancela las suyas; admin cualquiera.

## Diferencia con mod.billing

|                     | mod.billing                                     | mod.subscriptions                                   |
| ------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Modo Stripe         | `payment`                                       | `subscription`                                      |
| Frecuencia          | one-shot                                        | mensual / anual                                     |
| Estado              | order PENDING → COMPLETED                       | sub PENDING → ACTIVE → (PAST_DUE) → UNPAID/CANCELED |
| Grace period        | N/A                                             | configurable (default 3 días)                       |
| Webhooks consumidos | `checkout.session.completed`, `charge.refunded` | `customer.subscription.*`, `invoice.*`              |
| Bridge mod.learning | enrolla single                                  | enrolla/pausa/desenrolla                            |

Ambos módulos pueden estar activos a la vez en el mismo tenant: distintos cursos pueden venderse one-shot o por suscripción. NO se comparten tablas (regla del contrato modular).

## Riesgos / fuera de alcance MVP

- **Cambio de plan en mid-cycle** (upgrade/downgrade): requiere proration. No en MVP.
- **Trials**: Stripe los soporta vía `trial_period_days` en checkout, pero la UI admin no lo expone aún. Roadmap.
- **Pagos B2B con factura corporativa**: pasa por `mod.facturascripts` cuando esté.
- **Email dunning custom**: dependemos de los emails que Stripe envía por defecto desde el dashboard. Roadmap: emails propios via `mod.smtp`.
- **Pause/Resume API de Stripe**: no usamos. Cancelación es la única salida.

## Tests

`pnpm --filter @didacta/mod-subscriptions test` — vitest unit con mocks Prisma + Stripe stub.
