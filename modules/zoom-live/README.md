# mod.zoom-live

Aula virtual síncrona vía Zoom S2S API.

## Qué hace

- Programar sesiones Zoom desde el panel formador.
- Vincular sesión a curso o lección concreta.
- Banner "Próxima sesión" en detalle de curso del alumno (TZ local).
- Webhook `recording.completed` → persiste URL grabación + minutos.
- Smoke test de credenciales S2S desde admin.
- Webhook events log para auditoría.
- Guardar la clase en el calendario (Google, Outlook.com, Microsoft 365 y
  `.ics`) desde la propia pantalla y desde los emails. Los endpoints
  `/sessions/:id/calendar*` son **públicos** (un cliente de correo no manda
  bearer) y NUNCA incluyen el `joinUrl` de Zoom.
- Recordatorio automático por email + in-app 2 h antes de empezar
  (`ZOOM_REMINDER_HOURS_BEFORE`, cron `ZOOM_REMINDER_CRON`). Un envío por
  clase; reprogramarla lo rearma.

## Cómo activar

Toggle desde `/admin/configuracion` → módulo `zoom-live`. Requiere Zoom S2S OAuth configurado por tenant.

## Eventos

- `zoom.session.created/updated/cancelled` — del CRUD interno.
- `zoom.session.recording_ready` — del webhook tras `recording.completed`.

## Permisos

`zoom-live:read`, `zoom-live:write`.
