# mod.ai-grader

Corrección asistida IA para preguntas SHORT_ANSWER / LONG_ANSWER.

## Qué hace

- Lee rúbrica + respuesta del alumno.
- Genera nota propuesta + justificación + feedback estructurado vía AI Gateway.
- Workflow de revisión humana (formador) antes de publicar la nota.
- Métricas de acuerdo IA-humano (objetivo ≥ 85%).

## Cómo activar

Toggle desde `/admin/configuracion` → módulo `ai-grader`. Provider IA configurado en `/admin/ai/proveedores`.

## Eventos

- `ai-grader.suggestion.generated` — la IA propone nota.
- `ai-grader.suggestion.failed` — fallo del provider o token limit.

## Permisos

- `ai-grader:read` — formador ve sugerencias.
- `ai-grader:suggest` — sistema dispara generación.
- `ai-grader:admin` — admin gestiona rúbricas.

## Tablas

`mod_ai_grader_rubric`, `mod_ai_grader_suggestion`.
