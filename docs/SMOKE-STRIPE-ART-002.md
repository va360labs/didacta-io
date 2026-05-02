# Smoke real ART-002 con `stripe listen` (manual operador)

> Cierra ART-002 con un flujo end-to-end real: tarjeta test → Stripe → webhook → bridge → enrollment.
> Tiempo estimado: ~1h. Riesgo: bajo. Pre-req: cuenta Stripe en modo test + Stripe CLI instalado.

## 1. Pre-requisitos locales

```bash
# Stripe CLI instalado (Windows: scoop / choco; macOS: brew install stripe/stripe-cli/stripe)
stripe --version

# Login una vez (interactivo)
stripe login
```

## 2. Configurar `.env` con keys de Stripe (modo test)

Editar `D:\Test\didacta-community\.env` y AÑADIR (no sobreescribir lo que haya):

```env
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxx   # https://dashboard.stripe.com/test/apikeys
STRIPE_WEBHOOK_SECRET=                                # se rellena tras paso 5 con el output de `stripe listen`
BILLING_SUCCESS_URL_BASE=http://localhost:3000/cursos
BILLING_CANCEL_URL_BASE=http://localhost:3000/cursos
```

Después reiniciar el stack para que la API recoja las envs:

```bash
cd /d/Test/didacta-community
docker compose -f docker-compose.alpha.yml down
DIDACTA_IMAGE_TAG=alpha docker compose -f docker-compose.alpha.yml --env-file=.env up -d
until curl -fsS http://localhost:4000/healthz >/dev/null 2>&1; do sleep 2; done
```

## 3. Crear Product + Price en Stripe (test mode)

Dashboard → https://dashboard.stripe.com/test/products → "Add product"

- Name: `Curso de Prueba Didacta`
- Pricing: One-off, EUR 19,99
- Save → copiar `price_xxxxxxx` (lo usamos en el paso 6)

## 4. Login web como tenant_admin

http://localhost:3000/signin

Credenciales = las del setup wizard (BOOTSTRAP_EMAIL / la password que pusiste al inicializar).

## 5. Lanzar `stripe listen` y registrar webhook secret

En una terminal aparte (DEJAR ABIERTA durante todo el smoke):

```bash
stripe listen --forward-to http://localhost:4000/api/v1/modules/billing/webhook
```

Copia el `whsec_xxxxxxxx` que imprime → pégalo en `.env` como `STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxx` y reinicia la API:

```bash
docker compose -f docker-compose.alpha.yml restart didacta-app
```

> Nota: si reinicias `stripe listen`, te dará un secret nuevo. No reinicies hasta acabar el smoke.

## 6. Vincular curso ↔ price desde `/admin/billing/products`

http://localhost:3000/admin/billing/products

- Botón "Vincular producto" / similar
- Seleccionar un curso publicado (debe existir uno; si no, crearlo en `/admin/courses`)
- Pegar `price_xxxxxxx` del paso 3
- Guardar

## 7. Comprar como alumno

1. Crear (o reutilizar) un usuario alumno en `/admin/users` (rol `student`).
2. Logout del tenant_admin → login como alumno.
3. Navegar a `/cursos/<slug-del-curso>` → botón "Comprar curso".
4. Redirige a Stripe Checkout → usar tarjeta test:
   - Número: `4242 4242 4242 4242`
   - Cualquier CVC, fecha futura, ZIP cualquiera.
5. Tras el pago, debe redirigir a `BILLING_SUCCESS_URL_BASE`.

## 8. Verificación

### En la terminal de `stripe listen`

Aparecen los eventos:

```
checkout.session.completed   → forwarded to localhost:4000 → 200 OK
```

### En logs de la API (Docker)

```bash
docker logs didacta-app --tail 100 | grep -iE "billing|order|enroll"
```

Esperado:
- `[billing] order completed: order_xxx`
- `billing.order.completed event emitted`
- `[BillingLearningBridge] enrolling user_xxx into course_xxx`
- `[learning] enrollment created: enrollment_xxx`

### En la BD

```bash
docker exec -it didacta-postgres psql -U didacta -d didacta -c \
  "SELECT id, status, amount_cents, course_id, user_id FROM mod_billing_orders ORDER BY created_at DESC LIMIT 5;"

docker exec -it didacta-postgres psql -U didacta -d didacta -c \
  "SELECT id, user_id, course_id, status FROM mod_learning_enrollments WHERE user_id = '<alumno-id>' ORDER BY created_at DESC LIMIT 5;"
```

Esperado:
- 1 fila en `mod_billing_orders` con `status='COMPLETED'` y `amount_cents=1999`.
- 1 fila en `mod_learning_enrollments` con el alumno y el curso.

### En la UI del alumno

`/mis-cursos` debe mostrar el curso comprado.

## 9. Smoke webhook duplicado (idempotencia)

Re-disparar el evento desde Stripe CLI:

```bash
stripe events resend evt_xxxxxxxx --webhook-endpoint we_xxxx
```

Esperado en logs:
- `AlreadyEnrolledError caught as no-op`
- NO se crea segunda fila en `mod_learning_enrollments`.

## 10. Cierre

- Apagar stack: `docker compose -f docker-compose.alpha.yml down`
- Cerrar `stripe listen` (Ctrl+C).
- Marcar ART-002 con evidencia del smoke en Notion.

## Files de referencia (debug)

- `apps/api/src/modules/billing-webhook.controller.ts` — handler `POST /api/v1/modules/billing/webhook`
- `apps/api/src/modules/billing-learning.bridge.ts` — `billing.order.completed` → `learning.enrollFromPurchase`
- `apps/api/src/modules/billing-error.filter.ts` — captura `AlreadyEnrolledError` como no-op
- `modules/billing/src/service.ts` — `handleWebhookEvent`
