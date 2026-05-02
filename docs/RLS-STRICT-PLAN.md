# Plan: RLS estricto a nivel BD (follow-up `feat:multi_tenant.real`)

> Estado actual: el rol Postgres `didacta` que usa Prisma tiene `BYPASSRLS=t` y `SUPERUSER=t`, por lo que las policies definidas en `packages/database/prisma/rls.sql` **no enforzan a nivel BD**. El aislamiento por tenant es lógico (filtros `WHERE tenantId=X` en el código).
> Este documento define cómo migrar a enforcement real para holdings con varias filiales en EE.

## Por qué importa

`feat:multi_tenant.real` (ART-010, 11º piloto License SDK) habilita N tenants por instancia. Sin RLS estricto, un bug de filtro en cualquier query (olvidar `tenantId` en un `where`) puede leakear datos entre filiales del mismo holding. Con BYPASSRLS las policies de `rls.sql` no son una segunda línea de defensa — son decoración.

El listing cross-tenant `/super/users` (entregado junto con este plan) está gateado por rol + capability, pero la integridad real depende de filtros explícitos en el service. Eso es aceptable para CE 1-tenant; insuficiente para EE multi-filial.

## Estado actual confirmado

```sql
-- Verificación local (didacta-postgres):
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
WHERE rolname IN ('didacta','didacta_super','postgres');

--    rolname     | rolbypassrls | rolsuper
-- ---------------+--------------+----------
--  didacta       | t            | t          ← rol app actual
--  didacta_super | t            | f          ← rol "super" para jobs (correcto)
```

`rls.sql` activa `ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + policy `tenant_isolation` en toda tabla con columna `tenant_id`. La policy compara contra `current_setting('app.current_tenant_id')`. `withTenantContext()` setea ese GUC dentro de una transacción. Todo el cableado existe; solo falta que el rol Prisma deje de ser superuser.

## Plan en 5 fases

### Fase 1 — Crear rol app no-superuser (`didacta_app`)

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'didacta_app') THEN
    CREATE ROLE didacta_app WITH LOGIN PASSWORD :'app_password' NOBYPASSRLS NOSUPERUSER;
  END IF;
END $$;

-- Permisos en el schema public
GRANT USAGE ON SCHEMA public TO didacta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO didacta_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO didacta_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO didacta_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO didacta_app;
```

Añadir migración en `packages/database/prisma/migrations/<ts>_create_app_role/migration.sql` y exponer la password vía nueva env `DATABASE_APP_PASSWORD`.

### Fase 2 — Cross-tenant GUC opcional

Modificar `rls.sql` para que la policy permita queries cross-tenant cuando `app.cross_tenant=true`:

```sql
EXECUTE format(
  'CREATE POLICY tenant_isolation ON %I.%I
     USING (
       tenant_id = current_tenant_id()
       OR current_setting(''app.cross_tenant'', true) = ''true''
     )
     WITH CHECK (
       tenant_id = current_tenant_id()
       OR current_setting(''app.cross_tenant'', true) = ''true''
     )',
  t.table_schema, t.table_name
);
```

Añadir helper en `packages/database/src/tenant-context.ts`:

```ts
export async function withCrossTenantContext<T>(
  prisma: PrismaClient,
  callback: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.cross_tenant = 'true'`);
    return callback(tx as TransactionClient);
  });
}
```

Y migrar `SuperUsersService.list` a usarlo (envolver `findMany`/`count` dentro del helper).

### Fase 3 — Configurar Prisma con dos URLs

```env
# Conexión normal del request path (sin BYPASSRLS).
DATABASE_URL=postgresql://didacta_app:${DATABASE_APP_PASSWORD}@postgres:5432/didacta?schema=public

# Conexión privilegiada para migraciones, seeds, jobs cross-tenant globales.
DATABASE_MIGRATE_URL=postgresql://didacta:didacta_dev@postgres:5432/didacta?schema=public
```

`prisma/schema.prisma`:

```prisma
datasource db {
  provider          = "postgresql"
  url               = env("DATABASE_URL")
  directUrl         = env("DATABASE_MIGRATE_URL") // usado por `prisma migrate`
}
```

`prisma migrate deploy` y el seed siguen usando el rol `didacta` (BYPASSRLS) porque crean estructura y datos sin contexto de tenant. El runtime de la API usa `didacta_app`.

### Fase 4 — Auditoría exhaustiva del request path

Cualquier query Prisma fuera de `withTenantContext` o `withCrossTenantContext` falla en runtime con `didacta_app` (si el filtro implícito de la policy no matchea). Inventario de servicios a migrar:

- `AuthService.signin` (lookup user + password) — ya vive en path tenant-resolved.
- `AdminUsersService` — usa `tenantId` del JWT pero llamadas Prisma directas. Envolver en `withTenantContext`.
- `AdminTenantsService` — opera sobre tabla `tenant` (sin RLS) y `tenantDomain` (sin RLS); seguro.
- `AdminStatsService` — agregaciones. Si usa `tenantId`, envolver.
- Bridges (`billing-learning`, `assessments-learning`, etc.) — corren en background, sin tenant en contexto. Necesitan `withTenantContext(orderTenantId, ...)` antes de cualquier query.
- Workers (`subscriptions-grace-expiration`) — iteran sobre tenants; envolver cada iteración en su propio contexto.

### Fase 5 — Tests de leakage en CI

Test de integración sobre la BD real:

```ts
// tests/integration/rls-leakage.test.ts
it('una query sin contexto sobre user devuelve 0 filas', async () => {
  const result = await prisma.$queryRaw`SELECT * FROM "user" LIMIT 1`;
  expect(result).toEqual([]);
});

it('withTenantContext(t1) no ve filas de t2', async () => {
  await withTenantContext(prisma, t1.id, async (tx) => {
    const users = await tx.user.findMany({});
    expect(users.every((u) => u.tenantId === t1.id)).toBe(true);
  });
});

it('withCrossTenantContext ve filas de todos los tenants', async () => {
  await withCrossTenantContext(prisma, async (tx) => {
    const users = await tx.user.findMany({});
    const tenantIds = new Set(users.map((u) => u.tenantId));
    expect(tenantIds.size).toBeGreaterThan(1);
  });
});
```

Estos tests deben correr con el rol `didacta_app` (no `didacta`), idealmente en `docker-compose.test.yml` con un usuario dedicado.

## Riesgos de la migración

| Riesgo | Mitigación |
|---|---|
| Queries fuera de `withTenantContext` empiezan a fallar en runtime | Migración por servicio con tests; bandera `STRICT_RLS=true` para activar/desactivar el rol no-superuser por env |
| Performance: cada request abre transacción por `SET LOCAL` | Ya es el caso del wrapper actual; medir p95 con load test antes/después |
| Background jobs sin contexto leakean | Auditoría exhaustiva en Fase 4; asserts en bridges para detectar `current_tenant_id() IS NULL` |
| Breaking change para self-host alpha | Activar tras `0.0.1-beta.1`; en alpha dejar `STRICT_RLS=false` por defecto |

## Estimación

- Fase 1+2: 1 día (migración SQL + helper).
- Fase 3: 0.5 día (config Prisma + envs).
- Fase 4: 1.5-2 días (auditoría + migración servicios).
- Fase 5: 0.5-1 día (tests integración).

**Total: 3.5-4.5 días**. No urgente: la community alpha es 1-tenant y no necesita RLS estricto. Activar antes de `0.0.1-beta.1` para EE multi-filial.

## Decisión

NO ejecutar en este sprint. Dejar como tracking item bajo `feat:multi_tenant.real` en Notion. Ejecutar cuando:

1. Haya un cliente EE con licencia `feat:multi_tenant.real` real (no dev bypass).
2. O antes de `0.0.1-beta.1` como hardening preventivo.

Mientras: el listing `/super/users` está protegido por gate de rol (super_admin) + gate de capability (402 sin licencia). Filtros `WHERE tenantId` son responsabilidad del service.
