# Prompt 02 — Desglose técnico en tareas atómicas

> **Uso**: ejecutar después de haber completado y revisado el resultado del Prompt 01.
>
> **Precondición**: los casos de uso e historias están generados en `docs/casos-uso/`
> y el PRD, plan de fases y arquitectura modular están aprobados.

---

# Tarea: descomponer historias de usuario en tareas técnicas

Eres un Tech Lead senior en un equipo que va a implementar Didacta. Basándote en los
casos de uso e historias de usuario ya generados, descompón cada historia en tareas
técnicas atómicas listas para ser asignadas a un developer (o a Claude Code como
implementador).

## Precondiciones

Lee en este orden:

1. `docs/PRD.md`.
2. `docs/PLAN-FASES.md`.
3. `docs/ARQUITECTURA-MODULAR.md`.
4. `docs/casos-uso/` completo (explora todos los ficheros).

## Qué hay que producir

Crea la siguiente estructura en `docs/tareas/`:

```
docs/tareas/
├── README.md                                # índice, convenciones, estado
├── convenciones-tecnicas.md                 # etiquetas, tipos, estimaciones
├── fase-0-discovery.md                      # todas las tareas de Fase 0
├── fase-1a-core-learning/
│   ├── README.md                            # índice de la fase
│   ├── backend.md                           # tareas backend
│   ├── frontend.md                          # tareas frontend
│   ├── database.md                          # tareas de schema y migraciones
│   ├── devops.md                            # tareas de infra y CI/CD
│   ├── tests.md                             # tareas de testing e2e
│   └── docs.md                              # tareas de documentación
├── fase-1b-directo-comunidad-fundae/
│   ├── README.md
│   ├── backend.md
│   ├── frontend.md
│   ├── database.md
│   ├── devops.md
│   ├── tests.md
│   └── docs.md
└── fase-1c-ia-piloto/
    ├── README.md
    ├── backend.md
    ├── frontend.md
    ├── database.md
    ├── devops.md
    ├── tests.md
    └── docs.md
```

## Formato por tarea

```markdown
### T-[FASE]-[TIPO]-[NNN]: [Título corto accionable]

**Historia(s) padre**: HU-[...] [, HU-[...]]
**Caso(s) de uso padre**: UC-[...]
**Tipo**: [Backend / Frontend / Database / DevOps / Test / Docs / Design / Spike]
**Módulo**: [core / mod.courses / mod.learning / ...]
**Prioridad**: [P0 / P1 / P2]
**Estimación**: [1h / 2h / 4h / 1d / 2d / 3d / 5d]
**Etiquetas**: [#api #nestjs #prisma #security ...]

**Descripción técnica**:
[Qué hay que hacer a nivel de código. Especificar suficientemente para que otro
developer pueda ejecutar sin ambigüedad, pero sin escribir el código.]

**Archivos afectados (estimación)**:
- [ruta/esperada/archivo.ts] — [qué se hace aquí]
- [ruta/esperada/otro.tsx] — [qué se hace aquí]

**Dependencias técnicas**:
- Tareas previas requeridas: [T-... o "Ninguna"]
- Librerías/paquetes nuevos necesarios: [lista]

**Definición de hecho (DoD)**:
- [ ] Criterio funcional 1 cumplido y verificado manualmente.
- [ ] Tests unitarios escritos y pasando (coverage >70% en nuevo código).
- [ ] Tests de integración escritos si aplica (endpoints, workers).
- [ ] Documentación actualizada (OpenAPI auto-generada, READMEs relevantes).
- [ ] Code review aprobado por al menos 1 reviewer.
- [ ] Pipeline CI verde (lint + typecheck + tests + build).
- [ ] No introduce regresiones en tests existentes.
- [ ] Si es tarea de módulo: respeta el contrato de módulo (ver ARQUITECTURA-MODULAR.md).

**Notas de implementación**:
[Hints técnicos, gotchas, referencias a patrones del proyecto, librerías a usar.]

**Riesgos**:
[Si la tarea tiene incertidumbre, declararla explícitamente.]
```

## Reglas de descomposición

### 1. Atomicidad

- **Ninguna tarea puede superar 5 días de estimación**. Si la supera, divídela.
- **Tarea mínima**: 1 hora. Si es menos, agrúpala con otras.
- **Estimaciones**: usa `1h / 2h / 4h / 1d / 2d / 3d / 5d`. No uses otros valores.

### 2. Separación por capa

Cada historia genera tareas en varias capas según su naturaleza:

| Capa | Qué entra aquí |
|---|---|
| **Database** | Cambios a Prisma schema, migraciones, seeds, índices, RLS policies |
| **Backend** | Services, controllers, DTOs, guards, event handlers, jobs, hooks |
| **Frontend** | Páginas Next.js, componentes React, hooks, extensiones UI |
| **DevOps** | Docker, CI/CD, Easypanel, secrets, monitorización |
| **Tests** | E2E con Playwright (unitarios ya van con las tareas de backend/frontend) |
| **Docs** | READMEs, ADRs, guías, ejemplos, docs de API si no son auto-generadas |

### 3. Reglas específicas

- **Toda tarea de backend que exponga un endpoint público** requiere:
  - 1 tarea correspondiente de tests unitarios (incluida en la misma tarea backend).
  - 1 tarea correspondiente de tests de integración.
  - OpenAPI auto-generada (sin tarea separada).

- **Toda tarea de UI** requiere:
  - 1 tarea de diseño previa si el componente es nuevo (puede ser tan ligera como
    "wireframe + selección de componente shadcn").
  - Tests de componente con Vitest + React Testing Library (incluidos en la tarea UI).

- **Toda tarea de DB** debe incluir:
  - Migración up.
  - Migración down (rollback).
  - Seed de ejemplo si procede.
  - Policy RLS si la tabla tiene `tenant_id`.

- **Tareas de nuevo módulo** deben incluir:
  - Creación del directorio `modules/<nombre>/` con estructura estándar.
  - `module.json` manifest.
  - NestJS `DynamicModule`.
  - Stub de tests (contract tests que verifican cumplimiento del contrato).

### 4. Tipos de tareas especiales

- **Spike**: investigación acotada en tiempo (típicamente 4h-1d). Produce ADR o notas.
- **Bug**: descubierto durante desarrollo, no planificado.
- **Chore**: housekeeping (upgrade de deps, refactor, limpieza).
- **Feature**: el default (todo lo que implementa funcionalidad nueva).

### 5. Numeración

- `T-0-BACKEND-001` (Fase 0, tipo Backend, secuencial).
- `T-1A-FRONTEND-042` (Fase 1.A, tipo Frontend).
- `T-1B-DATABASE-007` (Fase 1.B, tipo Database).

Cada tipo tiene su propio contador por fase.

## Estructura de `convenciones-tecnicas.md`

Este fichero debe documentar:

- **Etiquetas válidas** con su significado (#api, #nestjs, #prisma, #rls, #security,
  #performance, #accessibility, #i18n, #compliance, #ia, #zoom, etc.).
- **Tipos de tarea** con ejemplos.
- **Escala de estimaciones** con criterios.
- **Convenciones de nombrado** para archivos, clases, funciones, endpoints.
- **Convenciones de commits** (conventional commits: feat, fix, chore, docs, refactor,
  test, perf, build, ci).
- **Convenciones de branch** (`feat/T-1A-BACKEND-042-iam-mfa`, `fix/...`).
- **Convenciones de PR** (título + descripción + checklist).

## Estructura de cada `README.md` de fase

Debe contener:

- Objetivo de la fase (copiado de PLAN-FASES.md).
- Módulos involucrados.
- Resumen de tareas: total, por tipo, por módulo.
- Estimación total en días.
- Ruta crítica (tareas bloqueantes).
- Tareas que pueden ejecutarse en paralelo.
- Índice de ficheros de tareas.

## Orden de ejecución

Procede en este orden:

1. Lee todos los casos de uso.
2. Escribe primero `convenciones-tecnicas.md` (referencia para todo lo demás).
3. Genera `fase-0-discovery.md` completo.
4. Pausa y pide confirmación.
5. Genera Fase 1.A (todos los ficheros de la fase en paralelo: backend, frontend, database, devops, tests, docs).
6. Pausa y pide confirmación.
7. Genera Fase 1.B.
8. Pausa y pide confirmación.
9. Genera Fase 1.C.
10. Actualiza `docs/tareas/README.md` con el índice completo y estadísticas globales.

## Criterios de calidad (self-check antes de entregar cada fase)

- [ ] Cada historia de usuario genera al menos 2 tareas (típicamente 3-8).
- [ ] Ninguna tarea excede 5 días de estimación.
- [ ] Cada tarea referencia su historia y caso de uso padre.
- [ ] Cada tarea tiene DoD claro y específico.
- [ ] La ruta crítica está identificada en el README de la fase.
- [ ] Se han identificado tareas paralelizables.
- [ ] Tareas de nuevo módulo incluyen setup del contrato.
- [ ] Tareas de DB incluyen migración up, down, y policy RLS si aplica.
- [ ] Tareas de endpoints incluyen tests.
- [ ] Estimación total de la fase coincide ±20% con la duración prevista (8 sem × 5 d/sem × N devs).

## Output esperado por fase (orientativo)

| Fase | Tareas estimadas totales | Días estimados totales |
|---|---|---|
| Fase 0 | 25-35 | 30-45 |
| Fase 1.A | 130-180 | 120-180 |
| Fase 1.B | 120-160 | 120-180 |
| Fase 1.C | 100-140 | 120-180 |

**Nota**: estos rangos son orientativos. El equipo real irá más rápido con Claude Code
asistiendo, pero el desglose detallado ayuda a priorizar, paralelizar y no olvidar
nada.

---

Empieza ahora escribiendo `convenciones-tecnicas.md`, después `fase-0-discovery.md`.
Cuando termines Fase 0, pausa.
