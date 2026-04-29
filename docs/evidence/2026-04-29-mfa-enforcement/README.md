# Evidencia E2E — MFA enforcement (LMS-109)

Validación de la PR [#232](https://github.com/va360labs/didacta/pull/232) que cierra el bypass de MFA para roles administrativos.

## Contexto

Hasta antes de esta PR, la infraestructura MFA estaba lista (setup,
enable, verify, claim `mfaVerified` en el JWT) pero **ningún endpoint
admin la imponía en runtime**. Un `super_admin` / `tenant_admin` podía
operar normalmente con un token recién emitido (`mfaVerified=false`)
hasta verificar voluntariamente. El guard ahora rechaza con
**HTTP 403 + `{ code: 'mfa_required' }`** salvo que la ruta lleve
`@MfaExempt()` (sólo el flow MFA y `/me/profile`).

## Run E2E

- **URL**: https://github.com/va360labs/didacta/actions/runs/25095525172
- **Conclusión**: `success` (3 m 24 s)
- **Resultados**: **45 passed · 2 skipped · 0 failed** sobre 47 specs
- **Trigger**: `workflow_dispatch` contra el branch `feat/mfa-enforcement`
- **Commit testeado**: `f5bf05b8091084c7934ccf35dfbbc37d9510f355`

### Spec nuevo que valida el enforcement

```
✓ tests/mfa-enforcement.spec.ts:47:7
  Auth · MFA enforcement (LMS-109) ›
  admin sin mfaVerified queda bloqueado en endpoint admin hasta completar setup
  (78ms)
```

Pasos cubiertos por el spec:
1. Signin del admin → `mfaRequired=true`, token con `mfaVerified=false`.
2. `GET /api/v1/admin/system/health-detail` con ese token → **403** + `{ code: 'mfa_required' }`.
3. `GET /api/v1/me/profile` con el mismo token → **200** (ruta exenta para que el cliente pueda mostrar el flow).
4. `POST /auth/mfa/setup` + `POST /auth/mfa/enable` → token elevado.
5. `GET /admin/system/health-detail` con el token elevado → **200**.

### Reporte HTML

[`playwright-report/index.html`](./playwright-report/index.html) — descargado del artifact del run.

## Tests skipped (no son fallo, están desactivados a propósito)

- `digest-opt-out.spec.ts:21` — Comunidad · digest opt-out persistente (G5.1)
- `zoom-webhook-hmac.spec.ts:31` — mod.zoom-live · webhook HMAC (G5.3)

## Cobertura unit

`apps/api`: **272/272 tests pasan** tras el cambio del guard. La suite
`jwt-guard.test.ts` añade 7 specs nuevos cubriendo el shape exacto del
error `mfa_required`, el comportamiento de `@MfaExempt`, y el aislamiento
para roles no admin.
