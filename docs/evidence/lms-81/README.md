# Evidencia LMS-81 — Grupo bonificable + costes Fundae

## Run E2E

- **Branch**: `feat/lms-81-grupo-bonificable`
- **Commit**: `80c12ce`
- **Workflow run**: <https://github.com/va360labs/didacta/actions/runs/25102650313>
- **Resultado**: ✅ success
- **Spec**: `apps/e2e/tests/fundae-groups.spec.ts`

El report HTML completo (con trazas, screenshots y vídeo si hubo retry) está en
`playwright-report/playwright-report/index.html`.

## Cobertura del spec

1. Setup: empresa bonificada (NIF `B12345674`) + acción formativa.
2. Crear grupo en `DRAFT` → list → get.
3. PATCH metadatos (modalidad, crédito).
4. Duplicado de `numeroGrupo` → 409 `FUNDAE_GROUP_NUMERO_DUPLICADO`.
5. Coste DIRECTO add → list → delete.
6. `start` → 422 `FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING` (verifica el guard
   RLPT integrado desde LMS-80).
7. `cancel` → grupo en `CANCELLED`.
8. Coste sobre grupo cancelado → 409 `FUNDAE_GROUP_CERRADO`.
9. Cleanup empresa.

## Run CI (lint + typecheck + test + build)

- **Workflow run**: <https://github.com/va360labs/didacta/actions/runs/25102648099>
- **Resultado**: ✅ success
- 14 tests unitarios `FundaeCompanyService` + 12 tests `FundaeGroupsController`
  + el resto del monorepo en verde.
