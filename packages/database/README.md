# @learnship/database

Cliente Prisma compartido, schema v1 del core y políticas RLS.

## Contenido

- `prisma/schema.prisma` — schema v1 con modelos del core (ver PRD §9.1)
- `prisma/rls.sql` — políticas Row-Level Security + triggers append-only
- `src/client.ts` — factoría de `PrismaClient`
- `src/tenant-context.ts` — wrapper `withTenantContext(prisma, tenantId, cb)` que setea `app.current_tenant_id` vía `SET LOCAL`

## Flujo de migración

```bash
# 1. Aplicar migraciones Prisma
pnpm --filter @learnship/database db:migrate:dev

# 2. Aplicar políticas RLS (después de cada migración)
pnpm --filter @learnship/database db:rls:apply

# 3. Generar cliente tipado
pnpm --filter @learnship/database db:generate
```

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
