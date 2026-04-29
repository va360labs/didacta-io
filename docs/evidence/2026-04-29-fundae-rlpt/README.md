# Evidencia E2E — RLPT Fundae (LMS-80)

Validación de la PR [#236](https://github.com/va360labs/didacta/pull/236) que cierra LMS-80 — segunda historia de Fase 1.B.

## Run E2E

- **URL**: https://github.com/va360labs/didacta/actions/runs/25098286240
- **Conclusión**: `success`
- **Resultados**: **47 passed · 2 skipped · 0 failed** sobre 49 specs.
- **Trigger**: `workflow_dispatch` sobre `feat/fundae-rlpt`.
- **Commit**: `eba2803392633a293b35c3091e709fab638f413a`.

### Spec nuevo verde

```
✓ tests/fundae-rlpt.spec.ts:49:7
  Fundae · Notificaciones RLPT (LMS-80) ›
  upload NOTIFICACION_INICIAL → list → upload ACUSE_RECIBO → delete (164ms)
```

Pasos cubiertos por el spec (todos vía API real con admin verificado MFA):
1. `POST /admin/fundae/companies` con CIF `P9999999G` (distinto del de la spec de empresas para evitar choque con la UNIQUE que sobrevive al soft-delete).
2. `POST /admin/fundae/companies/:id/rlpt-notices` con `tipo=NOTIFICACION_INICIAL` y PDF base64 → **201**, `evidenceHash` SHA-256 verificado regex `^[0-9a-f]{64}$`, `plazoVencimientoAt` = fechaNotif + 15 días naturales.
3. `GET .../rlpt-notices` lista la notificación.
4. `POST` con `tipo=ACUSE_RECIBO` y observaciones → **201**.
5. `GET` ahora devuelve dos notificaciones ordenadas por fecha desc.
6. `DELETE :id` soft-delete → **200**; segundo `DELETE` también **200** (idempotencia).
7. Limpieza: borra la empresa.

### Reporte HTML

[`playwright-report/index.html`](./playwright-report/index.html) — descargado del artifact del run.

## Cobertura unit

- `apps/api`: **292/292** tests pasan (10 nuevos sobre `FundaeRlptController`).
- `modules/fundae`: **75/75** tests pasan (11 nuevos sobre `FundaeRlptService` cubriendo upload, list, get, softDelete y las tres ramas del hook `assertGroupCanStart`).

## Iteración previa

El primer dispatch del E2E falló por colisión de NIF: la spec de RLPT usaba `P1234567D`, el mismo que la spec de empresas, que lo deja soft-deleted al final. La UNIQUE `(tenant, nif)` sobrevive al soft-delete, así que el segundo `create` devolvía 409. Fix `eba2803`: NIF distinto (`P9999999G`) para que ambas specs corran limpias en el mismo CI run sin tocar el orden ni la idempotencia de la spec previa.

## Próximo paso

LMS-81 (grupo bonificable + costes) puede arrancar. Ya tiene los dos prerequisitos:
1. Empresa bonificada (LMS-79) — FK lógica disponible.
2. Hook `fundae.group.before-start` (este) — listo para invocarse desde el flow de inicio del grupo.

## Tests skipped (preexistentes)

- `digest-opt-out.spec.ts:21` — Comunidad · digest opt-out persistente (G5.1)
- `zoom-webhook-hmac.spec.ts:31` — mod.zoom-live · webhook HMAC (G5.3)
