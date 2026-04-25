# mod.assessments

Módulo de evaluaciones de LearnShip.

## Alcance v0.1 (este package)

- Modelos Prisma: `Quiz`, `Question`, `Option`, `Attempt`, `Answer`.
- Tipos de pregunta: `SINGLE_CHOICE`, `MULTIPLE_CHOICE`, `TRUE_FALSE`.
- **Scoring engine** puro (función testable sin DB) que evalúa respuestas y calcula nota.
- Service base con CRUD interno (creación de quizzes y preguntas) y flujo de intentos (`startAttempt`, `submitAttempt`).
- Eventos: `assessments.quiz.published`, `assessments.attempt.started`, `assessments.attempt.submitted`, `assessments.attempt.passed`, `assessments.attempt.failed`.

## Fuera de alcance v0.1 (PRs futuros)

- Endpoints HTTP (PR B y PR C en `apps/api`).
- Integración con `mod.learning` para auto-completar la lección QUIZ (PR D vía evento).
- Tipos de pregunta `FILL_IN_BLANK`, `SHORT_ANSWER`, `LONG_ANSWER` (PR posterior).
- Banco de preguntas y orden aleatorio.
- Corrección manual.
- UI formador y alumno (`apps/web`).

## Anti-patrones que el módulo respeta

- Sin FKs cross-module: `lessonId` se guarda como UUID lógico (sin `@relation`).
- Todo modelo persiste `tenantId` y se filtra por él en cada query.
- El service no se acopla a HTTP: `apps/api` lo expone vía controllers en otra capa.
