# mod.member-registration

Inscripción de miembros con validación manual: solicitud → evidencia (verificadores componibles por tenant) → decisión humana. Es la capa genérica de alta que billing/suscripciones/grupos no cubren.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Estable. Extraído del vertical core `apps/api/src/inscripcion/` en la fase F3 de captación (2026-08). El host NestJS (controllers, services Prisma y worker de purga) vive en `apps/api/src/modules/member-registration/` (módulo first-party built-in, ADR-011/015/016).

## Resumen funcional

- El visitante abre `/inscripcion-miembros` (web) y el wizard monta los pasos según la política del tenant: verificación por **Telegram** (Login Widget + pertenencia al grupo), **OTP por email**, ambas, o **registro libre**. Con la política deshabilitada el registro queda **cerrado** (solo altas del admin).
- Los pasos se encadenan con **tickets firmados** (HMAC con `AUTH_SECRET`, sin estado en BD): el ticket de Telegram autoriza el OTP y el `verificationToken` del OTP autoriza el registro.
- El registro crea el User `PENDING` + su perfil (`mod_member_registration_profile`), lanza en background el **lookup de suscripciones/compras** del email en las cuentas de pago conectadas (`mod.payment-connections`) y avisa al **aprobador** por email con dos enlaces firmados de un solo uso (aprobar / rechazar) más el estado de impago si consta.
- La aprobación (email o panel) activa al usuario, le asigna el **grupo de acceso por defecto** del tenant y envía la bienvenida; el rechazo lo desactiva y avisa. Panel admin de solicitudes con re-lanzado de lookup y recordatorios de pago.
- Lista de **impagos** de referencia (alta manual + import CSV) clavada a email/userId (telegramId como clave legacy).
- Worker diario de **purga GDPR**: anonimiza los datos de Telegram de inscripciones nunca decididas tras la ventana de retención.

## API pública

Prefijo global `/api/v1`. Rutas únicas del módulo (las legacy `/inscripcion*` se retiraron en la migración coordinada de F3):

- `GET /modules/member-registration/config` — pública. Disponibilidad + verificadores exigidos + bot del Login Widget.
- `POST /modules/member-registration/telegram/verify` — pública. Valida la firma del widget y devuelve ticket.
- `POST /modules/member-registration/otp/request` / `otp/verify` — públicas. Código OTP por email → `verificationToken`.
- `POST /modules/member-registration/register` — pública. Crea la inscripción `PENDING` con la evidencia exigida.
- `GET /modules/member-registration/decision?token=…` — enlace del email del aprobador; redirige al frontend con el resultado.
- `GET|POST /modules/member-registration/admin/requests[...]` — admin. Solicitudes, alta manual, re-lanzar lookup, decidir, recordatorio de renovación.
- `GET|POST|DELETE /modules/member-registration/payment-flags[...]` — admin. Impagos (upsert, borrado, import CSV).

## Modelo de datos

- `mod_member_registration_profile` — 1:1 con `user` (join lógico por tenant+userId, sin FK): datos propios del flujo (telegram_id, telegram_in_group, approval_decided_at).
- `mod_member_registration_decision_token` — tokens de decisión de un solo uso (hash SHA-256, TTL 7 días); enum `MemberRegistrationDecisionAction` (`APPROVE`/`REJECT`).
- `mod_member_registration_payment_flag` — impagos por email/userId (telegram_id legacy).
- `mod_member_registration_subscription_lookup` — resultado del lookup de suscripciones/compras por solicitante.
- `email_verification_code` (core) — códigos OTP; tabla compartida con otros flujos de verificación del core.

## Configuración

Settings por tenant en `tenant_setting`, scope `member-registration` (UI en `/admin/configuracion`):

| Key            | Qué                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------- |
| `telegram`     | SECRETO cifrado: `botToken`, `groupId`, `botUsername` (Login Widget).                    |
| `verification` | Política: `{ enabled, verifiers: ['telegram'?, 'otp'?] }`. Sin setting → default legacy. |
| `approval`     | `{ email }` del aprobador de solicitudes.                                                |

Fallback global legacy del despliegue (instalaciones mono-tenant ya desplegadas): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `TELEGRAM_BOT_USERNAME`, `MEMBER_APPROVAL_EMAIL`. Otras ENV del host: `MEMBER_RETENTION_DAYS` (default 90), `MEMBER_PURGE_CRON` (default `0 3 * * *` UTC).

El módulo registra además sus 4 plantillas de email (`member_registration.otp_code`, `.approval_request`, `.welcome_approved`, `.rejection`) en el catálogo editable de `/admin/emails`.

## Dependencias

- `mod.payment-connections` ^1.0.0 — lookup de suscripciones y compras del solicitante; enlaces de renovación.
- `mod.access-groups` ^1.0.0 — asignación del grupo por defecto al aprobar (dependencia dura desde su formalización en F6). El wiring corre por el host.

## Eventos

**Emite** (vía outbox del host):

- `member_registration.request.created` — al crear una solicitud `PENDING` (flujo público o alta manual).
- `member_registration.request.approved` — al aprobarse (email 1-click o panel).
- `member_registration.request.rejected` — al rechazarse.

**Consume**: ninguno.
