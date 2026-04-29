# 🚨 TODO — Cloud god integration

> **No olvidar**: cuando exista el servicio Cloud god con el endpoint
> `/registry/install` desplegado en `registry.didacta.io`, hay que:
>
> 1. Configurar la variable de entorno **`DIDACTA_REGISTRY_URL=https://registry.didacta.io/registry`** en el deployment de cada instalación community que quiera registrarse (lo distribuyen los alpha testers en su `.env`).
> 2. Implementar reintento automático en `RegistryService.optIn()` para los registros que se hicieron en local sin Cloud god disponible (campo `registryToken` actualmente NULL en BBDD).
> 3. Activar el cron diario de envío de telemetría (`buildTelemetrySnapshot()` ya genera el payload — falta el scheduler).
> 4. Documentar en el panel admin que ahora el registro está conectado a Cloud god.
>
> ## Estado actual (Sprint 0, alpha v0.0.1)
>
> - El sistema opt-in **persiste local únicamente**. Los registros NO contactan Cloud god.
> - `DIDACTA_REGISTRY_URL` no se define en el `.env.example` por defecto. Si un tester la define, el SDK intentará conectar al endpoint indicado.
> - Issues Notion relacionadas: **MIG-049** (endpoint Cloud god), **MIG-050** (DNS + Easypanel), **MIG-051** (distribución a testers + reintento).
>
> ## Por qué Opción A
>
> Para alpha cerrada (v0.0.1), `cloud.didacta.io` está corriendo `learnship` (el LMS productivo), no el futuro Cloud god. Implementar `registry.didacta.io` ahora añade fricción al sprint sin valor inmediato — los testers no necesitan el ping a Cloud god para usar el producto. Lo dejamos para Sprint 2 / Fase 4.
>
> Aprobado por Valentín 2026-04-29.
