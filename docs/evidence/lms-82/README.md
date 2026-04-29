# Evidencia LMS-82 — Matriculación nominal en grupo bonificable Fundae

## Run E2E

- **Branch**: `feat/lms-82-grupo-participantes`
- **Workflow run**: <https://github.com/va360labs/didacta/actions/runs/25103546488>
- **Resultado**: ✅ success **al primer push** (sin retry)
- **Spec**: `apps/e2e/tests/fundae-group-participants.spec.ts`

## Cobertura del spec

1. Setup: empresa (NIF `A12345674`) + acción SIN courseId + grupo en DRAFT.
2. Enroll del admin (userId real del JWT) → list lo devuelve ENROLLED.
3. Enroll duplicado → 409 `FUNDAE_GROUP_PARTICIPANT_DUPLICADO`.
4. Bulk enroll en grupo cuya acción no tiene curso → 422 `FUNDAE_GROUP_SIN_CURSO`.
5. Remove (soft-delete) → desaparece de list por defecto.
6. List con `?includeRemoved=true` → vuelve en status REMOVED.
7. Re-enroll del mismo userId → reactiva la fila REMOVED a ENROLLED (sin
   duplicar por la UNIQUE constraint).
8. Cancel grupo + enroll en grupo cancelado → 409 `FUNDAE_GROUP_CERRADO`.
9. Cleanup empresa (idempotente).

## Run CI (lint + typecheck + test + build)

- **Workflow run**: <https://github.com/va360labs/didacta/actions/runs/25103550585>
- **Resultado**: ✅ success **al primer push**
- 10 tests unitarios `FundaeGroupParticipantsController` + tests previos del módulo.
