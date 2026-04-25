# mod.learning

Matriculación, progreso por lección, finalización con umbral configurable (default 75%).

## Modelos (`mod_learning_*`)

- `mod_learning_enrollment` — única por (tenant, user, course), status ACTIVE/COMPLETED/CANCELLED, completionThreshold, progressPercent, source ADMIN/CODE/INVITATION_LINK/PURCHASE/IMPORT
- `mod_learning_progress` — única por (enrollment, lesson). watchedSeconds, resumePositionSec, completed
- `mod_learning_invitation` — código corto + token URL, maxUses, expiresAt, usedCount

## Eventos

- `learning.enrollment.created`
- `learning.enrollment.cancelled`
- `learning.progress.updated` (con `progressPercent` calculado en cada update)
- `learning.course.completed` (cuando `progressPercent >= completionThreshold` por primera vez)
- `learning.invitation.created`

## Reglas

- Solo se enrolla en cursos PUBLISHED (lanza `CourseNotPublishedError` si DRAFT/ARCHIVED)
- Idempotencia: ya hay enrollment ACTIVE → lanza `AlreadyEnrolledError`
- Threshold por defecto 75% del total de lecciones
- Invitaciones por código (visible al usuario) y token URL (compartible). Validan revocación, expiración y maxUses.

## Próximos PRs

- Controller HTTP en `apps/api`
- Página alumno con player y reanudación
- Player por tipo de lección (vídeo Video.js, HTML iframe, PDF, texto, quiz)
