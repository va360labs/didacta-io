# ADR-005 — ORM: Prisma 5

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa

## Contexto

LearnShip es TypeScript end-to-end. Necesita un ORM con:

- Tipos auto-generados compartibles entre backend y frontend.
- Migraciones versionadas y reproducibles.
- Soporte para características avanzadas de Postgres: RLS, JSONB, pgvector.
- Buena DX y documentación.

Candidatos evaluados: Prisma, Drizzle, TypeORM, Kysely.

## Decisión

**Prisma 5** como ORM principal. Schema único en `packages/database/prisma/schema.prisma` versionado con Git, migraciones con `prisma migrate`.

Cada módulo añade sus modelos al mismo archivo con **prefijo obligatorio** `mod_<nombre>_` en tablas (enforced en el contrato de módulo, ADR-008 y tests de CI futuros).

## Consecuencias

Positivas:

- **Tipos TS auto-generados** compartidos end-to-end (`@prisma/client` con tipos inferidos del schema).
- **Migraciones versionadas** con rollback automático en dev.
- **Ecosistema maduro**: Prisma Studio, logs detallados, amplia comunidad.
- **Soporte Postgres extensiones** vía `previewFeatures: ["postgresqlExtensions"]` (uuid-ossp, pgcrypto, vector).

Negativas / riesgos:

- **RLS requiere raw SQL** (no hay abstracción nativa). Políticas aplicadas vía `rls.sql` ejecutado tras cada migración.
- **pgvector como preview**: hasta que Prisma lo soporte estable, usar `Unsupported("vector(N)")` o queries raw.
- **Schema único** exige coordinación: dos módulos no pueden añadir el mismo modelo a la vez (conflict en Git). Aceptable dado el tamaño del equipo.
- **Performance con queries complejas**: Prisma genera SQL que a veces no es óptimo; si un endpoint tiene latencia crítica, caerle con `$queryRaw` está permitido y documentado.

## Alternativas consideradas

- **Drizzle**: más SQL-first, pero menos maduro, migración tooling más verde.
- **TypeORM**: descartado por decorators pesados, bugs recurrentes en multi-tenant, y lentitud del roadmap.
- **Kysely**: demasiado low-level para productividad en el equipo; excelente para casos específicos (si aparecen queries que Prisma no maneja bien, se puede usar junto a Prisma).

## Consecuencias operacionales

Después de cada migración Prisma:

```bash
pnpm --filter @learnship/database db:migrate:dev
pnpm --filter @learnship/database db:rls:apply   # reaplica políticas RLS
pnpm --filter @learnship/database db:generate    # regenera cliente tipado
```

## Referencias

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/rls.sql`
- `docs/ARQUITECTURA-MODULAR.md` §4.1
