# mod.zoom-live

Aula virtual síncrona vía Zoom S2S API.

## Qué hace

- Programar sesiones Zoom desde el panel formador.
- Vincular sesión a curso o lección concreta.
- Banner "Próxima sesión" en detalle de curso del alumno (TZ local).
- Webhook `recording.completed` → persiste URL grabación + minutos.
- Smoke test de credenciales S2S desde admin.
- Webhook events log para auditoría.

## Cómo activar

Toggle desde `/admin/configuracion` → módulo `zoom-live`. Requiere Zoom S2S OAuth configurado por tenant.

## Eventos

- `zoom.session.created/updated/cancelled` — del CRUD interno.
- `zoom.session.recording_ready` — del webhook tras `recording.completed`.

## Permisos

`zoom-live:read`, `zoom-live:write`.
