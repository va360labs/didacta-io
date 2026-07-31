# mod.ai-content

Generador IA de borradores formativos: resúmenes, flashcards y quizzes a partir del texto de una lección. **Todo es DRAFT** hasta que el formador lo apruebe — human-in-the-loop por defecto, sin publicación automática.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Alpha. MVP cubre 3 tipos de draft y revisión manual. Regeneración con feedback queda fuera.

## Resumen funcional

- Formador pide generar (`POST /modules/ai-content/generate`) un summary, flashcards o quiz para una lección.
- El service llama al AI Gateway (provider configurable per-tenant — Anthropic / OpenAI) con un prompt específico al tipo.
- El resultado se guarda como `ModAiContentDraft` en estado `DRAFT`.
- El formador revisa, edita el JSON si quiere y aprueba (`PATCH /modules/ai-content/drafts/:id`) o rechaza con razón.
- Eventos emitidos: `draft.generated`, `draft.published`, `draft.rejected` — listeners pueden ingerir el contenido publicado (ej. crear `ModAssessmentsQuiz` desde un draft QUIZ aprobado).

## API pública

- `POST /modules/ai-content/generate` — formador. Body: `{ lessonId, courseId, type: 'SUMMARY' | 'FLASHCARDS' | 'QUIZ' }`. Devuelve el draft generado.
- `GET /modules/ai-content/drafts` — formador. Query: `lessonId?`, `courseId?`, `status?`. Lista drafts del tenant.
- `GET /modules/ai-content/drafts/:id` — formador. Detalle.
- `PATCH /modules/ai-content/drafts/:id/publish` — formador. Marca como `PUBLISHED` y emite evento.
- `PATCH /modules/ai-content/drafts/:id/reject` — formador. Body: `{ reason?: string }`. Marca como `REJECTED`.
- `PATCH /modules/ai-content/drafts/:id/content` — formador. Edita el JSON del draft antes de publicar.

## Modelo de datos

- `mod_ai_content_draft`:
  - `type`: `SUMMARY | FLASHCARDS | QUIZ`.
  - `status`: `DRAFT | PUBLISHED | REJECTED`.
  - `content` (JSON):
    - SUMMARY: `{ text: string }`.
    - FLASHCARDS: `{ cards: Array<{ front, back }> }`.
    - QUIZ: `{ questions: Array<{ prompt, options?, answer, explanation? }> }`.
  - `provider` / `model` / `inputTokens` / `outputTokens`: telemetría IA.

## Configuración

No requiere ENVs propias. Usa el AI Gateway del CORE (`apps/api/src/ai/`) con la config per-tenant. Si el tenant no tiene provider configurado, la generación falla con `AiContentProviderError` (HTTP 503).

## Dependencias

- `mod.courses` ^1.0.0 — para resolver `courseId` y validar que la lección pertenece al curso.
- AI Gateway del CORE (no es módulo): provider per-tenant Anthropic / OpenAI.

## Eventos

- **Emite**: `ai-content.draft.generated`, `ai-content.draft.published`, `ai-content.draft.rejected`.
- **Consume**: ninguno.

## Permisos

- `ai-content:generate` — formador o admin pide generación.
- `ai-content:review` — formador o admin aprueba / rechaza / edita.
- `ai-content:read` — leer borradores.

## Riesgos / fuera de alcance MVP

- **Regeneración con feedback**: si un draft no convence, el formador hoy lo rechaza y vuelve a pedir. Iteración con feedback ("hazlo más corto", "más técnico") queda para v0.2.
- **Ingestión automática a `mod.assessments`**: cuando un QUIZ se publica, el listener para crear `ModAssessmentsQuiz` queda como item separado (`AiContentAssessmentsBridge`). MVP solo emite el evento.
- **Streaming**: la respuesta del AI no se streamea; el formador espera ~5–30s a que termine. Para UX fluida en lessons largas, añadir SSE/streaming en v0.2.
- **Cuota / rate limit**: por ahora solo respeta los límites del AI Gateway. Cuotas por tenant/curso quedan para mod.ai-analytics.

## Tests

`pnpm --filter @didacta/mod-ai-content test` — vitest unit con mock chatFn (sin red).
