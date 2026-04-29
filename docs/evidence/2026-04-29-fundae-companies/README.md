# Evidencia E2E — empresas bonificadas Fundae (LMS-79)

Validación de la PR [#234](https://github.com/va360labs/didacta/pull/234) que abre la Fase 1.B del plan: primera historia de mod.fundae para que los siguientes work items (RLPT, grupo bonificable, comunicaciones, paquete auditoría) puedan referenciar a la empresa por FK.

## Run E2E

- **URL**: https://github.com/va360labs/didacta/actions/runs/25096683495
- **Conclusión**: `success` (3 m 27 s)
- **Resultados**: **46 passed · 2 skipped · 0 failed** sobre 48 specs.
- **Trigger**: `workflow_dispatch` sobre `feat/fundae-companies`.
- **Commit**: `5e9f719008930d7cea9e48e6f76b6d00e14061bf`.

### Spec nuevo verde

```
✓ tests/fundae-companies.spec.ts:48:7
  Fundae · CRUD de empresas bonificadas (LMS-79) ›
  crear → list → get → update → duplicado → delete (125ms)
```

Pasos cubiertos por el spec (todos vía API real con admin verificado MFA):
1. `POST /admin/fundae/companies` con NIF " P1234567-D " → **200**, NIF queda normalizado a `P1234567D`, crédito disponible calculado.
2. `GET /admin/fundae/companies` lista lo creado.
3. `GET /admin/fundae/companies/:id` devuelve el detalle.
4. `PATCH /admin/fundae/companies/:id` actualiza razón social y plantilla. NIF se preserva.
5. `POST` con el mismo NIF → **409** + `code=FUNDAE_COMPANY_NIF_DUPLICADO`.
6. `POST` con NIF inválido (checksum) → 400 (Zod).
7. `DELETE` → soft-delete; el listado por defecto no la incluye, con `?includeDeleted=true` aparece con `deletedAt` poblado.

### Reporte HTML

[`playwright-report/index.html`](./playwright-report/index.html) — descargado del artifact del run.

## Cobertura unit

- `apps/api`: **282/282** tests pasan (10 nuevos cubriendo `FundaeCompaniesController`).
- `modules/fundae`: **64/64** tests pasan (40 nuevos: 26 sobre `spanish-tax-id` con DNI/NIE/CIF + 14 sobre `FundaeCompanyService`).

## Próximo paso

LMS-80 (registrar RLPT) puede arrancar — esta historia ya añade el campo
`mod_fundae_company.id` al que el modelo `mod_fundae_rlpt_notice` se va a
vincular por FK lógica (sin FK física por la regla del proyecto de
no-cross-module-FK).

## Tests skipped (preexistentes)

- `digest-opt-out.spec.ts:21` — Comunidad · digest opt-out persistente (G5.1)
- `zoom-webhook-hmac.spec.ts:31` — mod.zoom-live · webhook HMAC (G5.3)
