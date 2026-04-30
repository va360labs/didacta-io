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

## Tablas

`mod_ai_tutor_conversation`, `mod_ai_tutor_message`, `mod_ai_embeddings` (con vector column).
