# mod.payment-connections

Conecta **varias cuentas de Stripe en modo solo lectura** y reconcilia sus suscripciones activas contra los usuarios de Didacta por email.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Alpha. V1 cubre: conectar/verificar/desconectar cuentas Stripe (clave restringida read-only, cifrada), y reconciliar las suscripciones activas en dos listas — usuarios de Didacta con sub activa / suscriptores que aún no están en Didacta. Acción de invitar (cuenta PENDING + email) la orquesta el host. Cancelar = deep-link al dashboard de Stripe (no se cancela vía API: el modelo es 100% read-only).

## Qué NO es

No crea cobros: para vender cursos por Stripe están `mod.billing` (pago único) y `mod.subscriptions` (recurrente). Este módulo solo **lee** cuentas externas. No comparte tablas con ellos (regla del contrato modular).

## API pública (admin · super_admin)

- `POST /modules/payment-connections/connections` — conectar `{ provider:'stripe', displayName, apiKey }`. Valida con `accounts.retrieve`, cifra la key, persiste fila VERIFIED.
- `GET /modules/payment-connections/connections` — listar conexiones (metadata + status, sin la key).
- `POST /modules/payment-connections/connections/:id/verify` — re-validar credenciales.
- `DELETE /modules/payment-connections/connections/:id` — desconectar (borra fila + secret).
- `GET /modules/payment-connections/connections/:id/reconcile` — dos listas (en Didacta / no en Didacta).
- `POST /modules/payment-connections/connections/:id/invite` — invitar (bulk) a los no-registrados.

## Modelo de datos

- `mod_payment_connections_connection` — una fila por cuenta conectada (metadata, **sin** la key).
- `mod_payment_connections_log` — auditoría opcional de verify/invite.
- La API key cifrada vive en `tenant_setting` (módulo `payment-connections`, key `stripe:<connectionId>:api_key`, `isSecret`).

## Scopes mínimos de la restricted key

`Customers = Read` + `Subscriptions = Read` (obligatorios). `Invoices = Read` opcional.

## Reconciliación

Match por email **normalizado** (lowercase + trim) en ambos lados. Estados Stripe que cuentan como activa: `active`, `trialing`, `past_due`. Paginación con tope defensivo (50 páginas/estado) → marca `truncated` si se excede.

## Tests

`pnpm --filter @didacta/mod-payment-connections test` — vitest unit con Stripe/DB/usuarios mockeados.
