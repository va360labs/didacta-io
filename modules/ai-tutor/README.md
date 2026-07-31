# mod.ai-tutor

Tutor conversacional por curso con RAG (Retrieval-Augmented Generation).

## Qué hace

- Indexa contenido del curso al publicarlo (`courses.course.published`).
- Genera embeddings (Anthropic / Voyage / OpenAI configurable per-tenant).
- Almacena en pgvector con índice ivfflat.
- Chat embebido en `/cursos/[slug]/tutor` con citas a lecciones específicas.
- Límite de tokens por alumno/día/tenant.
- AI Gateway multi-provider con failover.

## Cómo activar

Toggle desde `/admin/configuracion` → módulo `ai-tutor`. Configurar provider en `/admin/ai/proveedores`.

## Eventos

- `ai-tutor.conversation.created` — primer mensaje del alumno.
- `ai-tutor.message.sent` — cada mensaje (con métricas tokens).
- `ai-tutor.indexing.completed` — tras indexar un curso.

## Permisos

- `ai-tutor:read` — alumno consulta.
- `ai-tutor:chat` — alumno puede chatear (sujeto a quota).
- `ai-tutor:admin` — formador / admin gestiona reindex y providers.

## Revisión y realimentación del conocimiento

Superficie de admin en `/admin/ia/tutor`, tres pestañas que son un mismo ciclo:

1. **Revisión** — pares pregunta→respuesta con quién preguntó, en qué curso y en
   qué lecciones se apoyó el tutor. El filtro «solo sin respaldo» aísla las
   respuestas que salieron sin citar nada: o están mal o señalan material que
   falta.
2. **Conocimiento validado** — respuestas escritas por una persona. Se crean al
   corregir una respuesta concreta, o a mano. `AiTutorChatService.ask` las
   recupera por similitud (`CORRECTION_MAX_DISTANCE`) y las inyecta en el prompt
   por encima del contexto RAG. Entran en caliente: no hay que reindexar.
3. **Informe mensual** — preguntas del mes agrupadas por embedding
   (`clustering.ts`), ordenadas por volumen, con alumnos distintos y quiénes.

Las correcciones viven en tabla propia y **no** como chunks: reindexar un curso
hace `DELETE` + `INSERT` de todos sus chunks, así que una corrección guardada
ahí duraría hasta el siguiente `courses.lesson.updated`.

## Tablas

`mod_ai_tutor_conversation`, `mod_ai_tutor_message` (con `question_embedding` y
el estado de revisión), `mod_ai_tutor_chunk` (vector 1536),
`mod_ai_tutor_correction` (vector 1536) y `mod_ai_tutor_token_usage`.
