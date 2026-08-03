# mod.surveys

Encuestas y NPS post-clase: recogida de feedback de los asistentes a una sesión en vivo, con recordatorios automáticos y resultados agregados para el admin.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Estable. Módulo first-party built-in (ADR-011/015): la lógica portable vive en `modules/surveys/` y el host NestJS (controller, worker de recordatorios y bridge de Zoom) en `apps/api/src/modules/surveys/`.

## Resumen funcional

- **Encuesta post-clase**: al terminar una sesión en vivo (`zoom.session.ended`) se crea la encuesta de la sesión y se avisa a los inscritos.
- El alumno responde una vez (preguntas escala/NPS/texto); el admin ve **resultados agregados** por encuesta.
- **Recordatorios** a quienes no respondieron, ejecutados por worker (y lanzables a mano desde el admin).
- El admin puede crear la encuesta de una sesión manualmente y **cerrarla** cuando quiera.

## API pública

Prefijo global `/api/v1`, namespace `/modules/surveys`. Sesión (Bearer) obligatoria; las rutas `admin/*` exigen rol de administración:

- `GET /modules/surveys/sessions/:sessionId` — la encuesta de una sesión (para el asistente).
- `POST /modules/surveys/:id/responses` — envía la respuesta (una por usuario).
- `GET /modules/surveys/admin` — encuestas del tenant.
- `GET /modules/surveys/admin/:id/results` — resultados agregados.
- `POST /modules/surveys/admin/sessions/:sessionId` — crea la encuesta de una sesión.
- `POST /modules/surveys/admin/reminders/run` — lanza los recordatorios pendientes.
- `POST /modules/surveys/admin/:id/close` — cierra la encuesta.

## Modelo de datos

- `mod_surveys_survey` — la encuesta (sesión de origen, estado, cierre).
- `mod_surveys_question` — preguntas (tipo, orden).
- `mod_surveys_response` — una respuesta por usuario y encuesta.
- `mod_surveys_answer` — respuestas por pregunta.

Todas con `tenant_id` + RLS (autodescubierta por `rls.sql`).

## Configuración

Sin settings propios de tenant. Los recordatorios corren en el worker del host (BullMQ sobre el Redis de la instalación).

## Dependencias

- `mod.zoom-live` ^0.3.0 (opcional) — **lectura acotada** de `mod_zoom_live_session_registration` (ADR-016, declarada en el manifest): identifica a los inscritos de la sesión para avisarles al crear la encuesta y en los recordatorios. Solo lectura filtrada por `tenant_id`, nunca escritura.

## Eventos

**Emite**:

- `surveys.survey.created` — al crearse la encuesta de una sesión.
- `surveys.response.submitted` — al recibirse una respuesta.

**Consume**:

- `zoom.session.ended` — dispara la creación de la encuesta post-clase.
