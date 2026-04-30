# mod.fundae

Cumplimiento regulatorio para acciones formativas bonificables en España (Fundae / RD 694/2017).

## Qué hace

- Empresas bonificadas (NIF + CCC + crédito anual).
- RLPT — notificación a la Representación Legal de Personas Trabajadoras (15 días naturales mínimo).
- Grupos bonificables con costes y matriculación nominal.
- Cálculo de finalización con umbral 75% configurable.
- Export XML inicio + fin de grupo.
- ZIP de presentación con evidencias PDF firmadas + manifest SHA-256 verificable offline.
- Endpoints específicos por rol: admin, auditor (read-only sanitizado), empresa_manager (sus empleados).

## Cómo activar

Toggle desde `/admin/configuracion` → módulo `fundae`.

## Eventos

Ver `module.json` para la lista completa. Los más importantes:
- `fundae.group.before-start` — síncrono, valida RLPT vencida.
- `fundae.audit.zip-exported` — emite tras export con hash del manifest.

## Validador offline

`tools/audit-zip-verify.mjs` valida el ZIP de auditoría sin dependencias externas. Soporta schemas `v1` (admin) y `v1-auditor` (redactado).

## Tablas

`mod_fundae_company`, `mod_fundae_rlpt_notice`, `mod_fundae_group`, `mod_fundae_group_participant`, `mod_fundae_company_manager`, etc.
