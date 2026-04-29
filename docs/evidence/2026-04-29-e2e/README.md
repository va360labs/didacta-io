# Evidencia E2E — 2026-04-29

Validación de la solución al fallo persistente del workflow E2E en `main`.

## Origen del fallo

El spec `apps/e2e/tests/enroll-by-code.spec.ts:52` esperaba el heading
`"Empezá este curso"` (castellano argentino) que el PR Cat-2 (#197 —
"Neutralizar castellano") cambió a `"Empieza este curso"` en la página
`/cursos/[slug]`. El test no se actualizó en ese commit y desde entonces
falló en cada push a `main` (≥ 18 runs rojos consecutivos).

## Fix

Branch [`fix/e2e-enroll-by-code-copy`](https://github.com/va360labs/didacta/tree/fix/e2e-enroll-by-code-copy)
— commit `db2c63d`. Ajusta el heading esperado y aclara en comentario
que el regex del label sobrevive variantes de copy.

## Evidencia

- **Run E2E**: https://github.com/va360labs/didacta/actions/runs/25094171713
- **Conclusión**: `success` (3m 13s)
- **Resultados**: **44 passed · 2 skipped · 0 failed** sobre 46 specs.
- **Trigger**: `workflow_dispatch` contra el branch del fix.
- **Commit testeado**: `db2c63d7cc9c71f4369cf5d024b3402d3d789880`.
- **Reporte HTML adjunto**: [`playwright-report/index.html`](./playwright-report/index.html)
  — descargado desde el artifact del run.

### Tests skipped (no son fallo, están desactivados a propósito)

- `digest-opt-out.spec.ts:21` — Comunidad · digest opt-out persistente (G5.1)
- `zoom-webhook-hmac.spec.ts:31` — mod.zoom-live · webhook HMAC (G5.3)

### Test que pasó tras el fix

- ✓ `enroll-by-code.spec.ts:17` — Matriculación por código de invitación
  (1.2 s).

## Próximo paso

Mergear el PR del fix a `main` para que el siguiente push deje de
romper el workflow.
