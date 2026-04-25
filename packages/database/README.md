# @learnship/database

Cliente Prisma compartido, schema v1 del core y políticas RLS.

## Contenido

- `prisma/schema.prisma` — schema v1 con modelos del core (ver PRD §9.1)
- `prisma/rls.sql` — políticas Row-Level Security + triggers append-only
- `src/client.ts` — factoría de `PrismaClient`
- `src/tenant-context.ts` — wrapper `withTenantContext(prisma, tenantId, cb)` que setea `app.current_tenant_id` vía `SET LOCAL`

## Flujo de migración

Las migraciones viven en `prisma/migrations/` versionadas en git. La baseline `0_init` captura todo el schema hasta el cierre de `mod.assessments` (PRs #44–49).

### Setup en una máquina nueva (o un Postgres recién creado)

```bash
# 1. Aplicar todas las migraciones pendientes
pnpm --filter @learnship/database db:migrate:deploy

# 2. Aplicar políticas RLS (idempotente)
pnpm --filter @learnship/database db:rls:apply

# 3. Generar cliente Prisma tipado
pnpm --filter @learnship/database db:generate
```

### Cambios al schema

```bash
# 1. Editar prisma/schema.prisma
# 2. Crear y aplicar la migración localmente
pnpm --filter @learnship/database db:migrate:dev --name <descripción-corta>
# 3. Reaplicar RLS si los nuevos modelos lo necesitan
pnpm --filter @learnship/database db:rls:apply
# 4. Commitear el contenido de prisma/migrations/<timestamp>_<descripción>/
```

### DBs existentes (Easypanel) que vienen del flujo `prisma db push`

La primera vez tras este PR hay que marcar la baseline como ya aplicada (sin reejecutar el SQL), porque las tablas ya existen:

```bash
pnpm --filter @learnship/database exec prisma migrate resolve --applied 0_init
```

A partir de ese momento, los próximos `db:migrate:deploy` aplicarán solo las migraciones nuevas posteriores a `0_init`.

## Regla de oro

**Todos los módulos deben leer/escribir a través del Prisma que reciben en `ModuleContext`**. El backend (apps/api) envuelve cada request con `withTenantContext` para que RLS se aplique automáticamente.

Si necesitás saltar RLS (workers globales, seeders), usá el rol `learnship_super` que se crea en `rls.sql`. **Nunca** en request path de usuario final.

## Modelos incluidos (v1)

Multi-tenancy:

- `Tenant`, `Module`, `TenantModule`

IAM:

- `User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `Session`, `ApiKey`

Cross-cutting del core:

- `AuditLog` (append-only via trigger en `rls.sql`)
- `EvidenceVaultEntry`
- `OutboxEvent` (event bus)
- `Webhook`
- `NotificationTemplate`

Los modelos de módulos (`mod_courses_*`, `mod_learning_*`, etc.) se añaden en PRs posteriores con prefijo obligatorio.
