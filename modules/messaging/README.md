# mod.messaging

Mensajería en tiempo real de la plataforma: mensajes directos entre miembros, salas ligadas a espacios de comunidad y el canal directo con el equipo docente.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Estable. Módulo first-party built-in (ADR-011/015): la lógica portable vive en `modules/messaging/` y el host NestJS (controllers, servicios Prisma, stream SSE y presencia vía Redis) en `apps/api/src/modules/messaging/`.

## Resumen funcional

- **Mensajes directos (DM)** entre dos miembros del tenant, con creación idempotente de la conversación.
- **Salas de espacio**: cada espacio de comunidad puede abrir su sala de chat compartida.
- **Canal de profesores**: conversación directa del alumno con el equipo docente del tenant.
- **Tiempo real** por SSE con ticket firmado de corta vida (el `EventSource` del navegador no puede enviar el bearer), indicador de escritura (typing) y presencia de conectados vía Redis.
- Marcado de leído por conversación y contadores de no-leídos.

## API pública

Prefijo global `/api/v1`, namespace `/modules/messaging`. Todos los endpoints exigen sesión (Bearer); la moderación de mensajes usa los permisos declarados en el manifest:

- `GET /modules/messaging/conversations` — conversaciones del usuario con no-leídos.
- `POST /modules/messaging/dm` — abre (o recupera) el DM con otro miembro.
- `POST /modules/messaging/spaces/:slug/open` — abre la sala del espacio.
- `POST /modules/messaging/faculty/open` — abre el canal con el equipo docente.
- `GET | POST /modules/messaging/conversations/:id/messages` — histórico paginado / envío.
- `POST /modules/messaging/conversations/:id/typing` · `GET /modules/messaging/presence` — typing y presencia.
- `POST /modules/messaging/conversations/:id/read` — marca leído.
- `POST /modules/messaging/stream-ticket` (Bearer) + `GET /modules/messaging/stream?ticket=…` (SSE, sin bearer) — tiempo real.

## Modelo de datos

- `mod_messaging_conversation` — la conversación (`kind` DM/espacio/facultad, referencia lógica al espacio).
- `mod_messaging_participant` — participantes con su estado de lectura.
- `mod_messaging_message` — mensajes (autor, cuerpo, moderación).

Todas con `tenant_id` + RLS (autodescubierta por `rls.sql`).

## Configuración

Sin settings propios de tenant ni ENV del host. El tiempo real (SSE + presencia) usa el Redis de la instalación (`REDIS_URL`); sin Redis el chat sigue funcionando sin push instantáneo.

## Dependencias

Sin dependencias de otros módulos. Las salas de espacio referencian el espacio de comunidad por identificador lógico, sin FK cross-module (ADR-016).

## Eventos

**Emite**:

- `messaging.conversation.created` — al crearse una conversación nueva.
- `messaging.message.sent` — al enviarse un mensaje.

**Consume**: ninguno.
