# ADR-002 — Multi-tenancy strategy: Row-Level Security

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa

## Contexto

El aislamiento multi-tenant es crítico para un SaaS. Tres estrategias posibles:

1. **Base de datos por tenant**: aislamiento máximo, operacionalmente costoso.
2. **Schema por tenant**: aislamiento fuerte, limites de Postgres con miles de schemas.
3. **Row-Level Security (RLS)** con `tenant_id` en tablas compartidas: aislamiento impuesto por el motor.

## Decisión

**RLS con `tenant_id UUID NOT NULL`** en todas las tablas. Políticas aplicadas dinámicamente por bloque `DO $$` que escanea `information_schema.columns` y activa `ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` en cada tabla con esa columna.

El contexto de tenant se propaga vía `SET LOCAL app.current_tenant_id = '<uuid>'` al inicio de cada transacción. El helper `withTenantContext(prisma, tenantId, cb)` en `@didacta/database` encapsula el patrón.

## Consecuencias

Positivas:

- **Operación simple**: una sola BD, un solo schema, migraciones únicas.
- **Escalable**: soporta miles de tenants sin explosión de schemas.
- **Backups triviales**: `pg_dump` estándar.
- **Aislamiento a nivel motor**: incluso un bug de aplicación no puede leer datos cross-tenant si las políticas están activas.

Negativas / riesgos:

- **Rendimiento con millones de filas** y muchos tenants: debe benchmarkarse en Fase 0 con dataset sintético de ≥100 tenants × 10k filas.
- **Riesgo de olvido**: si una migración crea tabla con `tenant_id` pero sin política, se filtra data. **Mitigación**: test de CI que verifica RLS en el 100% de tablas con `tenant_id`.
- **Particionado futuro**: si una tabla supera cientos de millones de filas, se puede particionar por tenant sin cambiar la política.
- **Rol `didacta_super`** con `BYPASSRLS` necesario para jobs globales. Nunca usar en request path de usuario final.

## Alternativas consideradas

- **DB por tenant**: rechazado por costes (backup, conexiones, monitorización × N tenants) y complejidad de migraciones sincronizadas.
- **Schema por tenant**: rechazado por límites prácticos de Postgres con miles de schemas y tooling inadecuado (Prisma, pg_dump).

## Referencias

- `packages/database/prisma/rls.sql`
- `packages/database/src/tenant-context.ts`
- `docs/PRD.md` §4.1, §9
- [PostgreSQL RLS docs](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)
