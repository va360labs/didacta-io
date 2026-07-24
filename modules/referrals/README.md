# mod.referrals

## Edición

Community (first-party core).

## Estado

v1 — en desarrollo (spec SpecBox: board ff-df14c0b4d8e3, 5 US / 10 UC / 36 AC).

## Resumen funcional

Programa de referidos de la membresía: cada miembro tiene un código/enlace propio
(`/unete?ref=CODE`). Si alguien entra por ese enlace y **paga**, el referidor
devenga un % del cobro real. El operador configura comisión, ámbito, ventanas y
mínimos desde `/admin/referidos` sin tocar código.

Flujo: clic (dedupe por código+día+IP) → checkout con `referralCode` en la
metadata de Stripe → atribución en el fulfillment del webhook (idempotente,
anti-auto-referido) → comisión `PENDING` por cada `invoice.paid > 0` dentro del
ámbito → `APPROVED` al vencer la garantía (worker) → liquidación **manual** del
admin con referencia externa (v1 sin Stripe Connect) → `PAID`.

## Modelo de datos

Tablas propias (prefijo `mod_referrals_`, todas con `tenant_id`, sin FKs
cross-module):

- `mod_referrals_config` — 1 fila por tenant (bps, scope, ventanas, mínimo, copy).
- `mod_referrals_code` — código único por (tenant, user).
- `mod_referrals_click` — clics con dedupe `(code, day, ip_hash)`.
- `mod_referrals_referral` — atribución; unique por `(tenant, referred_user)` y
  por `stripe_subscription_id`.
- `mod_referrals_commission` — unique por `stripe_invoice_id`; estados
  `PENDING → APPROVED → PAID`, `REVOKED` con motivo.
- `mod_referrals_payout` — liquidaciones manuales con referencia externa.

## API pública

Service: `ReferralsService` (`getOrCreateCode`, `registerClick`, `attribute`,
`accrueCommission`, `approveDueCommissions`, `approveCommissionNow`,
`revokeCommission`, `recordPayout`, `memberStats`, `listCommissions`,
`listReferrers`, `getConfig`, `updateConfig`).

HTTP (host, `apps/api/src/modules/referrals/`): namespace `/modules/referrals`
(`GET me`, `GET me/stats`, `POST track` público, `GET|PUT admin/config`,
`GET admin/commissions`, `GET admin/referrers`,
`POST admin/commissions/:id/approve|revoke`, `POST admin/payouts`).

## Eventos

Emitidos (declarados en manifest): `referrals.referral.attributed`,
`referrals.commission.created`, `referrals.commission.approved`,
`referrals.commission.revoked`, `referrals.payout.recorded`.

Consumidos (vía bridge del host): `subscriptions.membership.activated`
(atribución, con `attribution.referralCode` en el payload) y
`subscriptions.invoice.paid` (devengo).

## Configuración

Todo per-tenant en `mod_referrals_config` (editable en `/admin/referidos`):
activo, `commissionBps` (3000 = 30 %), `scope` (`FIRST_PAYMENT`/`RECURRING`),
`recurringMonths` (null = ilimitado), `attributionWindowDays`, `guaranteeDays`,
`minPayoutCents`, `requireActiveMembership`, `memberCopy`. Sin variables de
entorno propias.

## Dependencias

- `optionalModules`: `mod.subscriptions` — lectura acotada de
  `mod_subscriptions_subscription` (¿membresía viva del referidor?) filtrando
  por `tenant_id` (ADR-016). El módulo NUNCA escribe tablas ajenas; el email de
  los users lo resuelve el host vía callback (`UserEmailLookup`).
