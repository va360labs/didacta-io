# Marketplace Web ↔ Instancia Didacta — Especificación de integración

> Documento dirigido al **equipo de la web pública de Didacta** (didacta.io).
> Define el contrato que debe respetar la web para que un usuario pueda navegar el marketplace, hacer click en "Instalar" sobre un módulo y disparar la instalación contra una de sus instancias self-host registradas.
>
> **Contrato runtime de los módulos** (formato `*.zip`, firma RSA, lifecycle, aislamiento VM): ver [`docs/adrs/ADR-009-module-marketplace.md`](adrs/ADR-009-module-marketplace.md). Este doc se centra en el **canal web ↔ instancia**, no en la ejecución del módulo dentro de la instancia.
>
> Estado: **propuesta v1**. Pendiente de validación con el equipo web. Última revisión: 2026-05-02.

---

## 1. Resumen ejecutivo

Hoy el flujo previsto en ADR-009 es: el operador descarga manualmente un `*.zip` desde un canal privado (Drive/Notion) y lo sube en `/admin/modules/install`. Esto es el **fallback offline** y queda intocado.

A esto añadimos un segundo flujo, inspirado en n8n Cloud → instancia self-hosted:

1. El usuario se loguea en `didacta.io`, registra sus instancias self-host (pairing una vez por instancia).
2. Navega el catálogo público de módulos en la web.
3. Hace click en "Instalar" sobre un módulo, ve la lista de sus instancias registradas, elige una.
4. La web hace **push** firmado a la instancia con la URL del ZIP + manifest + firma; la instancia descarga, valida (ADR-009) e instala.
5. La instancia notifica de vuelta a la web el resultado (job status) para mostrar feedback al usuario.

Beneficio: misma promesa de self-host (la instancia decide si acepta y valida todo localmente), con UX comparable a un SaaS.

---

## 2. Glosario

- **Web** o **didacta.io**: la web pública que construye este equipo. Aloja cuentas de usuario, catálogo de módulos, panel "My Instances".
- **Instancia**: un deployment de Didacta (Docker `didactaio/community`) corriendo en infra del cliente. URL ejemplo: `https://lms.acme.com`.
- **Operador / super_admin**: usuario con rol `super_admin` dentro de su instancia.
- **Cuenta web**: usuario en didacta.io. Puede tener N instancias enlazadas.
- **Pairing**: proceso one-time de enlazar una instancia con una cuenta web.
- **Push install**: la web inicia la instalación de un módulo en una instancia ya pareada.
- **Paquete `*.zip`**: ZIP firmado por Didacta con el módulo. Definido en ADR-009 §1.

---

## 3. Modelo de datos (lado web)

Tablas mínimas que necesita la web. Esquema sugerido — adaptar a vuestro stack:

### `users`
Cuentas de la web. Auth con email + password o SSO. Fuera de scope aquí.

### `instances`
```
id              uuid PK
user_id         uuid FK → users.id
display_name    text                      -- "LMS de Acme"
base_url        text                      -- "https://lms.acme.com" (sin trailing slash)
public_key_pem  text                      -- clave pública de la instancia (Ed25519)
api_token_hash  text                      -- HMAC-SHA256 del token compartido (no guardar plain)
paired_at       timestamptz
last_seen_at    timestamptz NULL          -- última vez que la instancia hizo heartbeat
status          enum('active','revoked','unreachable')
```

Una cuenta puede tener N instancias. Una instancia se identifica unívocamente por `base_url` + `user_id` (un usuario no puede registrar dos veces la misma URL).

### `modules` (catálogo público)
```
id                  uuid PK
slug                text UNIQUE              -- "mod.gamification"
name                text                     -- "Gamification"
vendor              enum('va360','community')
latest_version      text                     -- "1.2.0"
description         text
long_description    md
category            text                     -- "engagement", "compliance", ...
screenshots         text[]                   -- URLs CDN
license             text                     -- "SUL-1.0", "EE-1.0"
required_core_range text                     -- "^1.0.0"
required_capabilities text[]                 -- ["feat:scim"]
is_published        bool
created_at, updated_at
```

### `module_versions`
```
id                  uuid PK
module_id           uuid FK
version             text                     -- "1.2.0"
zip_url             text                     -- "https://cdn.didacta.io/modules/mod.gamification-1.2.0.zip"
zip_sha256          text                     -- hex
manifest_json       jsonb                    -- copia legible del manifest (para preview)
manifest_jwt       text                     -- firma JWT compact ES256 (mismo flujo que license-sdk) (la misma que va dentro del ZIP)
signed_at           timestamptz
released_at         timestamptz
changelog           md
is_yanked           bool                     -- retirar versión sin borrar
```

### `installations`
```
id              uuid PK
user_id         uuid FK
instance_id     uuid FK → instances.id
module_id       uuid FK
version         text
status          enum('pending','running','success','failed')
job_id          text                          -- job_id devuelto por la instancia
error_message   text NULL
started_at, completed_at
```

---

## 4. Pairing — enlazar una instancia con una cuenta

**Objetivo**: la web debe acabar con un `api_token` compartido y la `base_url` + `public_key_pem` de la instancia. La instancia debe acabar con el `api_token` de su lado.

Se usa un flujo similar a OAuth Device Code, pero iniciado desde la instancia (más natural para self-host).

### 4.1 Flujo

```
[Instancia]                                                    [Web didacta.io]
  │                                                                   │
  │ super_admin entra en /admin/integrations/marketplace              │
  │ click "Conectar con didacta.io"                                   │
  │                                                                   │
  │ 1. Instancia genera:                                              │
  │    - pairing_code = 8 chars random (mostrar al user)              │
  │    - instance_keypair (Ed25519, persiste private en BD instancia) │
  │    - callback_url = {base_url}/api/v1/marketplace/pair/callback   │
  │                                                                   │
  │ 2. Redirect navegador del operador a:                             │
  │    https://didacta.io/instances/pair                              │
  │      ?code={pairing_code}                                         │
  │      &callback={callback_url}                                     │
  │      &public_key={public_key_pem_b64}                             │
  │      &display_name={instance_hostname}                            │
  │ ─────────────────────────────────────────────────────────────────►│
  │                                                                   │
  │                                       3. Web exige login          │
  │                                       4. Web muestra modal:       │
  │                                          "Acme LMS quiere         │
  │                                           conectarse. Confirmar?" │
  │                                       5. User confirma            │
  │                                                                   │
  │                                       6. Web genera api_token     │
  │                                          (32 bytes random b64)    │
  │                                          guarda HMAC en           │
  │                                          instances.api_token_hash │
  │                                                                   │
  │ 7. Web POST {callback_url} con body:                              │
  │ ◄─────────────────────────────────────────────────────────────────┤
  │    {                                                              │
  │      "code": "<pairing_code>",                                    │
  │      "api_token": "<token>",                                      │
  │      "user_email": "<email>",                                     │
  │      "user_id": "<uuid>",                                         │
  │      "web_public_key_pem": "<ed25519 pub>"                        │
  │    }                                                              │
  │                                                                   │
  │ 8. Instancia valida que el code coincida                          │
  │    Persiste api_token + web_public_key_pem                        │
  │                                                                   │
  │ 9. Instancia responde 200 con                                     │
  │    Authorization: HMAC-SHA256({callback body})                    │
  │ ─────────────────────────────────────────────────────────────────►│
  │                                                                   │
  │                                       10. Web marca instance      │
  │                                           status='active' y       │
  │                                           redirect user a         │
  │                                           "/instances" con        │
  │                                           instancia visible       │
```

### 4.2 Endpoints implicados

#### Lado web (lo construye este equipo)

| Método | Path | Quién | Función |
|---|---|---|---|
| GET | `/instances/pair?code=...&callback=...&public_key=...` | navegador del user | UI de confirmación |
| POST | `/api/v1/instances/pair/confirm` | front web | confirma + dispara callback a la instancia |
| GET | `/api/v1/instances` | user autenticado | lista sus instancias |
| DELETE | `/api/v1/instances/:id` | user autenticado | revoca pairing (y notifica a la instancia) |

#### Lado instancia (lo construyo yo, lado Didacta)

| Método | Path | Función |
|---|---|---|
| POST | `/api/v1/marketplace/pair/initiate` | super_admin → genera code + redirect URL |
| POST | `/api/v1/marketplace/pair/callback` | la web → entrega api_token |
| POST | `/api/v1/marketplace/pair/revoke` | la web → invalida pairing |

### 4.3 Seguridad del pairing

- `pairing_code` expira en **5 minutos**, single-use.
- El `callback_url` debe coincidir con `base_url + /api/v1/marketplace/pair/callback`. La web rechaza callbacks fuera de ese path.
- **CSRF**: el redirect lleva el `code` y un `state` random firmado por la instancia que la web devuelve tal cual.
- La instancia valida en el callback que el `state` que recibe es el mismo que generó.
- El `api_token` viaja **una sola vez** (en el callback) por canal HTTPS. Después se usa solo el HMAC.

---

## 5. Push install — instalar un módulo desde la web

### 5.1 Flujo

```
[User en didacta.io]            [Web didacta.io]            [Instancia]
        │                             │                          │
        │ click "Install" en           │                          │
        │ /marketplace/mod.gamification│                          │
        ├─────────────────────────────►│                          │
        │                             │                          │
        │ ◄────────────── modal:       │                          │
        │   "¿En qué instancia?"      │                          │
        │   [LMS Acme] [LMS Beta]     │                          │
        │                             │                          │
        │ select + confirm             │                          │
        ├─────────────────────────────►│                          │
        │                             │ POST {base_url}/api/v1/  │
        │                             │  marketplace/install     │
        │                             │ ────────────────────────►│
        │                             │  Headers:                │
        │                             │   Authorization: HMAC-SHA256
        │                             │   X-Didacta-Web-Signature: <ed25519>
        │                             │  Body:                   │
        │                             │   { module_slug,         │
        │                             │     version,             │
        │                             │     zip_url,             │
        │                             │     zip_sha256,          │
        │                             │     manifest_preview,    │
        │                             │     manifest_jwt,       │
        │                             │     web_install_id }     │
        │                             │                          │
        │                             │ ◄────── 202 Accepted     │
        │                             │   { job_id }             │
        │                             │                          │
        │                             │   (instancia descarga    │
        │                             │    ZIP de zip_url,       │
        │                             │    valida sha256 + firma │
        │                             │    Didacta dentro del ZIP,│
        │                             │    ejecuta flujo ADR-009)│
        │ ◄──── poll /installs/:id    │                          │
        │   "running"                 │                          │
        │                             │                          │
        │                             │ POST didacta.io/api/v1/  │
        │                             │  installs/:web_install_id│
        │                             │  /webhook                │
        │                             │ ◄────────────────────────┤
        │                             │  Body:                   │
        │                             │   { job_id, status,      │
        │                             │     error?, manifest? }  │
        │                             │                          │
        │ ◄──── poll                  │                          │
        │   "success" ✓               │                          │
```

### 5.2 Endpoint instancia: `POST /api/v1/marketplace/install`

**Auth**: doble.
- `Authorization: HMAC-SHA256 instance=<instance_id>, signature=<hex>` — HMAC del body con el `api_token` compartido.
- `X-Didacta-Web-Signature`: Ed25519 del body firmado con la `web_public_key` que la instancia tiene en BD. Defensa contra robo del `api_token`.

**Body**:
```json
{
  "module_slug": "mod.gamification",
  "version": "1.2.0",
  "zip_url": "https://cdn.didacta.io/modules/mod.gamification-1.2.0.zip",
  "zip_sha256": "abc123...",
  "manifest_preview": { ...ADR-008 manifest... },
  "manifest_jwt": "...",
  "web_install_id": "uuid-de-la-fila-en-installations",
  "callback_url": "https://didacta.io/api/v1/installs/<web_install_id>/webhook",
  "callback_secret": "random-32b-hmac-key"
}
```

**Respuesta 202**:
```json
{ "job_id": "j_8a4f...", "status": "queued" }
```

**Errores**:
- `400` — body malformado, sha256 no coincide al descargar, manifest no parsea
- `401` — HMAC inválido
- `403` — Ed25519 inválido
- `409` — módulo ya instalado en esta versión (idempotente)
- `412` — `coreVersionRequired` no compatible con la instancia
- `422` — firma Didacta dentro del ZIP no valida
- `500` — error interno

Mismas respuestas que retornaría una validación local (ADR-009 §3 pasos 1-8); la web debe renderizarlas como mensajes legibles.

### 5.3 Webhook de vuelta: `POST {callback_url}`

Cuando la instancia termina (success/fail), notifica a la web. Body:
```json
{
  "job_id": "j_8a4f...",
  "web_install_id": "...",
  "status": "success" | "failed",
  "error_code": "VM_BOOT_FAILED" | null,
  "error_message": "...",
  "installed_version": "1.2.0",
  "duration_ms": 4380
}
```

**Auth del webhook**: HMAC-SHA256 del body con el `callback_secret` que viajó en la request original. La web verifica.

Si la web no responde 2xx en 5s, la instancia reintenta con backoff exponencial 3 veces. Después archiva el resultado y deja al user pollear `GET /api/v1/marketplace/jobs/:id` desde la propia instancia.

### 5.4 Polling alternativo

La web debe ofrecer `GET /api/v1/installs/:web_install_id` para que el front pollee. La fuente de verdad es lo que llega por webhook; si tarda, la web puede pollear `GET {base_url}/api/v1/marketplace/jobs/:job_id` con HMAC.

---

## 6. Catálogo público — endpoints que la web debe exponer

Endpoints públicos (sin auth) y autenticados:

| Método | Path | Auth | Función |
|---|---|---|---|
| GET | `/api/v1/marketplace/modules` | no | listado paginado, filtros `?category=&vendor=&q=` |
| GET | `/api/v1/marketplace/modules/:slug` | no | detalle con versiones |
| GET | `/api/v1/marketplace/modules/:slug/versions/:version` | no | manifest + zip_url |
| POST | `/api/v1/marketplace/modules/:slug/install` | user | inicia push install (ver §5) |
| GET | `/api/v1/installs/:id` | user | estado de una instalación |
| POST | `/api/v1/installs/:id/webhook` | HMAC instancia | recibe resultado |

### 6.1 Hosting de los `*.zip`

Los ZIP firmados deben servirse desde un **CDN público** (`cdn.didacta.io`) con:
- HTTPS obligatorio
- `Content-Type: application/zip`
- Soporte de `Range` requests (descarga parcial si la instancia lo necesita)
- Cache larga (los archivos son inmutables por versión)
- `ETag` con el sha256

Didacta sube los ZIP a un bucket privado (S3/R2); la web los expone vía CDN con URL firmadas opcionales o públicas estables.

---

## 7. Dependencias NO desarrolladas

Antes de que la web pueda lanzar el marketplace, faltan piezas que dependen de lado Didacta o de infra compartida:

### 7.1 Lado Didacta (lo asume el equipo backend)

| ID | Pieza | Estado | Bloquea |
|---|---|---|---|
| D1 | ADR-009 implementado: endpoint `POST /admin/modules/install` (subida ZIP local), VM aislada, prisma migrate por módulo, firma Didacta verify | propuesto, no iniciado | TODO el marketplace |
| D2 | Endpoints `/api/v1/marketplace/pair/*` en la instancia | no existe | pairing |
| D3 | Endpoint `/api/v1/marketplace/install` (push receiver) | no existe | push install |
| D4 | Endpoint `/api/v1/marketplace/jobs/:id` | no existe | UX feedback |
| D5 | Modelo en BD instancia: tabla `marketplace_pairings` (api_token_hash, web_public_key, status, last_seen) | no existe | pairing |
| D6 | Worker outbox para webhook reintentos web→instancia | no existe (existe outbox del core, ampliar) | webhooks |
| D7 | UI `/admin/integrations/marketplace` (super_admin) — botón "Connect" + lista de pairings activos + revoke | no existe | UX pairing |
| D8 | UI `/admin/modules/install` con dos tabs: "Subir ZIP" (offline) y "Desde marketplace" (link a didacta.io) | no existe | UX |

### 7.2 Lado infra/seguridad (compartido)

| ID | Pieza | Estado | Bloquea |
|---|---|---|---|
| S1 | Esquema definitivo de firma de módulos: clave Didacta, rotación, revocación. Reusa flujo del license-sdk (KMS alias/didacta-issuer-2026, ES256) | propuesto en ADR-009, sin implementación | firma push install |
| S2 | KMS o HSM para custodiar la private key Didacta (no puede vivir en un repo) | no existe | firma producción |
| S3 | Pipeline CI Didacta que firma los `.zip` al publicar | no existe | publicar versión |
| S4 | CDN público `cdn.didacta.io` con bucket detrás | no existe | distribuir ZIP |
| S5 | RLS strict en producción (`docs/RLS-STRICT-PLAN.md`) — pre-requisito de ADR-009 §"Pre-requisitos" | parcial, plan escrito, no aplicado | ACEPTAR primer módulo de terceros |

### 7.3 Lado web (este equipo)

| ID | Pieza | Estado | Bloquea |
|---|---|---|---|
| W1 | Auth/cuentas en didacta.io | TBD por equipo web | TODO |
| W2 | Catálogo de módulos (BD + admin para publicar versiones) | TBD | navegación |
| W3 | "My Instances" panel + flujo de pairing UI | TBD | pairing |
| W4 | Modal "Install on instance" con lista de instancias y polling | TBD | push install |
| W5 | Webhook receiver `/api/v1/installs/:id/webhook` con HMAC verify | TBD | feedback |
| W6 | Worker que reintenta el push si la instancia tarda > N seg | TBD | resiliencia |
| W7 | Página pública por módulo con screenshots, changelog, "compatible con core ≥ X.Y" | TBD | UX |

---

## 8. Roadmap sugerido

Fases incrementales para ir desbloqueando piezas sin esperar todo el sistema:

| Fase | Entregable | Bloqueantes |
|---|---|---|
| **0** | ADR-009 implementado (subida ZIP offline). UX `/admin/modules/install` con drag&drop. | D1, S1, S5 |
| **1** | Pairing instancia ↔ web (sin marketplace todavía). Demo: la instancia aparece en didacta.io/instances. | D2, D5, D7, W1, W3 |
| **2** | Catálogo público de módulos (read-only desde la web). Sin botón "Install" aún. Operadores siguen instalando offline. | W2, W7, S3, S4 |
| **3** | Push install MVP: botón "Install" en la web → push HMAC + Ed25519 → instancia ejecuta ADR-009. | D3, D4, D6, D8, W4, W5, W6 |
| **4** | Multi-tenant marketplace: módulos community publicables por terceros, revisión manual. | Out of scope ahora, retomar tras Fase 3 estabilizada. |

---

## 9. Decisiones abiertas (pendientes de validar)

1. **Identidad de la instancia**: ¿Ed25519 generada al primer pairing y persistida, o por instalación al hacer `setup`? Propuesta: al primer pairing, persistente en `marketplace_pairings`. Permite múltiples pairings con distintas webs en el futuro.
2. **Multi-cuenta por instancia**: ¿una instancia puede estar pareada con varias cuentas web? MVP: NO, una instancia = una cuenta. Simplifica revoke y billing.
3. **Auto-update**: ¿la web puede ofrecer "auto-actualizar este módulo cuando salga nueva versión"? MVP: NO, cada install es manual y firmado por user.
4. **Coste**: ¿módulos premium con pago en la web? Out of scope MVP. Cuando llegue: Stripe Checkout en la web emite un "install entitlement" firmado que viaja en el push install body; la instancia verifica antes de instalar.
5. **Telemetría inversa**: ¿la instancia reporta heartbeat a la web (`last_seen_at`)? Propuesta: sí, cada 24h, opt-out por env var. Permite a la web detectar instancias zombie.

---

## 10. Referencias

- [`docs/adrs/ADR-008-contrato-de-modulo.md`](adrs/ADR-008-contrato-de-modulo.md) — contrato runtime del módulo
- [`docs/adrs/ADR-009-module-marketplace.md`](adrs/ADR-009-module-marketplace.md) — formato `*.zip`, firma, VM, lifecycle
- [`docs/RLS-STRICT-PLAN.md`](RLS-STRICT-PLAN.md) — pre-requisito de seguridad
- [`docs/ARQUITECTURA-MODULAR.md`](ARQUITECTURA-MODULAR.md) — anti-patrones y reglas de módulo
- n8n self-hosted ↔ cloud pairing (referencia de UX): https://docs.n8n.io/hosting/server-setup/

---

## Changelog

- **2026-05-02 — v1**: documento inicial. Modelo de datos web, flujo pairing, push install, dependencias, roadmap.
