# Prompt 03 — Creación del kanban en Notion

> **Uso**: ejecutar después de haber completado Prompt 01 y Prompt 02, y haber
> revisado los ficheros generados en `docs/casos-uso/` y `docs/tareas/`.
>
> **Precondición**: MCP de Notion conectado y funcionando. Claude Code debe verificar
> el acceso antes de empezar.

---

# Tarea: crear la estructura de gestión del proyecto Didacta en Notion

Usando el MCP de Notion disponible, crea una estructura de gestión completa que
albergue todo el backlog del proyecto Didacta, organizado por fases, módulos y
tipos, con vistas kanban y trazabilidad completa entre casos de uso, historias y
tareas.

## Precondiciones

Lee en este orden:

1. `docs/PRD.md`.
2. `docs/PLAN-FASES.md`.
3. `docs/ARQUITECTURA-MODULAR.md`.
4. Todo `docs/casos-uso/`.
5. Todo `docs/tareas/`.

## Estructura a crear en Notion

### 1. Página raíz: "Didacta — Proyecto"

Crea una página de Notion en el workspace del usuario. Contenido:

- **Heading 1**: "Didacta — Plataforma LMS modular"
- **Callout** con descripción corta del producto (extraída del resumen ejecutivo del PRD).
- **Heading 2**: "Documentación"
  - Enlaces a los docs clave (incluir placeholders donde se pegarán después URLs
    reales del repo):
    - PRD
    - Plan de fases
    - Arquitectura modular
    - Repositorio GitHub
- **Heading 2**: "Gestión del proyecto"
  - Enlaces embebidos a las bases de datos creadas más abajo.
- **Heading 2**: "Fases del proyecto"
  - Tabla con: fase, duración, objetivo, estado, % completitud.
- **Heading 2**: "Decisiones pendientes"
  - Lista de todas las decisiones pendientes extraídas de
    `docs/casos-uso/decisiones-pendientes.md`.
- **Heading 2**: "Riesgos activos"
  - Lista de riesgos del PRD con owner y mitigación.

### 2. Base de datos: "Didacta — Casos de uso"

**Nombre**: `Didacta — Casos de uso`
**Tipo**: database

**Propiedades**:

| Propiedad | Tipo | Valores |
|---|---|---|
| Título | Title | — |
| ID | Rich Text | UC-... |
| Fase | Select | Fase 0, Fase 1.A, Fase 1.B, Fase 1.C, Fase 2+ |
| Módulo | Select | core, mod.courses, mod.learning, mod.assessments, mod.certificates, mod.zoom-live, mod.community, mod.fundae, mod.ai-tutor, mod.ai-grader, mod.ai-content, mod.ai-analytics, mod.n8n-bridge |
| Actor primario | Select | super_admin, tenant_admin, formador, alumno, auditor, empresa_manager, sistema |
| Prioridad | Select | P0, P1, P2 |
| Estimación | Select | S, M, L, XL |
| Etiquetas | Multi-select | #fundae, #ia, #evidencia, #modularidad, #rgpd, #seguridad, ... |
| Reglas de negocio | Multi-select | RN-001, RN-002, ... (crear al vuelo) |
| Estado | Status | Draft, Refinado, Aprobado, En implementación, Completado |
| Historias (relación) | Relation → "Historias de usuario" | — |
| Tareas (relación) | Relation → "Backlog" | — |

**Cuerpo de cada página (UC)**: pegar el contenido completo del UC desde los
ficheros markdown de `docs/casos-uso/`.

### 3. Base de datos: "Didacta — Historias de usuario"

**Nombre**: `Didacta — Historias de usuario`

**Propiedades**:

| Propiedad | Tipo | Valores |
|---|---|---|
| Título | Title | — |
| ID | Rich Text | HU-... |
| Caso de uso padre | Relation → "Casos de uso" | — |
| Fase | Select | (igual que UCs) |
| Módulo | Select | (igual que UCs) |
| Rol | Select | (igual que Actor primario) |
| Prioridad | Select | P0, P1, P2 |
| Estado | Status | Draft, Refinado, Lista para desarrollo, En desarrollo, En QA, Hecha |
| Sprint | Select | (vacío al inicio; se usará después) |
| Tareas (relación) | Relation → "Backlog" | — |

**Cuerpo de cada página**: pegar la historia completa con escenarios Gherkin.

### 4. Base de datos principal: "Didacta — Backlog"

**Nombre**: `Didacta — Backlog`

Esta es la base de datos central donde vive el kanban.

**Propiedades**:

| Propiedad | Tipo | Valores |
|---|---|---|
| Título | Title | — |
| ID | Rich Text | T-... |
| Tipo | Select | Feature, Bug, Chore, Spike, Refactor |
| Capa | Select | Backend, Frontend, Database, DevOps, Test, Docs, Design |
| Fase | Select | (igual que UCs) |
| Módulo | Select | (igual que UCs) |
| Prioridad | Select | P0, P1, P2 |
| Estimación | Select | 1h, 2h, 4h, 1d, 2d, 3d, 5d |
| Estado | Status | Backlog, Refinado, Ready, In progress, Blocked, In review, Done, Won't do |
| Sprint | Select | (vacío al inicio) |
| Etiquetas | Multi-select | (mismas que convenciones-tecnicas.md) |
| Historia padre | Relation → "Historias de usuario" | — |
| Dependencias | Relation → "Backlog" (self) | Tareas bloqueantes |
| Bloqueos | Relation → "Backlog" (self, rollup inverso) | — |
| Asignado | People | — |
| Fecha start | Date | — |
| Fecha due | Date | — |
| Github PR | URL | — |
| Notas | Rich text | — |

### 5. Base de datos: "Didacta — Reglas de negocio"

**Nombre**: `Didacta — Reglas de negocio`

**Propiedades**:

| Propiedad | Tipo | Valores |
|---|---|---|
| Título | Title | — |
| ID | Rich Text | RN-... |
| Categoría | Select | Fundae, IFAPA, RGPD, ENS, Producto, Seguridad |
| Fuente normativa | Rich Text | — |
| Parametrizable | Checkbox | — |
| Módulos afectados | Multi-select | — |
| UCs relacionados | Relation → "Casos de uso" | — |

**Cuerpo**: contenido completo de la regla.

### 6. Base de datos: "Didacta — ADRs"

**Nombre**: `Didacta — ADRs`

**Propiedades**:

| Propiedad | Tipo | Valores |
|---|---|---|
| Título | Title | — |
| ID | Rich Text | ADR-... |
| Estado | Select | Propuesta, Aceptada, Rechazada, Superseded |
| Fecha decisión | Date | — |
| Autor | People | — |
| Supersede | Relation → "ADRs" (self) | — |

**Cuerpo**: contenido del ADR (contexto, decisión, consecuencias, alternativas).

### 7. Base de datos: "Didacta — Decisiones pendientes"

Para todos los UCs y puntos marcados como `DECISIÓN PENDIENTE`.

**Propiedades**:

| Propiedad | Tipo | Valores |
|---|---|---|
| Título | Title | — |
| Categoría | Select | Producto, Legal, Técnica, Comercial |
| Fase bloqueada | Select | — |
| Owner | People | — |
| Due date | Date | — |
| Estado | Status | Pendiente, En análisis, Decidida, Bloqueada externamente |
| Impacto si no se decide | Select | Bajo, Medio, Alto, Crítico |

## Vistas a crear en "Didacta — Backlog"

Crear estas vistas (todas sobre la misma base de datos):

1. **🗂 Todo el backlog** (tabla, sin filtros, ordenado por Fase y Prioridad).
2. **📋 Por refinar** (tabla, filtro: Estado = Backlog).
3. **🎯 Sprint actual** (kanban por Estado, filtro: Sprint = [actual] — configurable).
4. **🚧 En progreso** (kanban por Asignado, filtro: Estado = In progress).
5. **🔴 Bloqueadas** (tabla, filtro: Estado = Blocked, ordenado por Prioridad).
6. **📅 Timeline** (timeline, agrupado por Fase, usando Start/Due dates).
7. **🧱 Por módulo** (tabla, agrupada por Módulo).
8. **🎨 Fase 0** (kanban por Estado, filtro: Fase = Fase 0).
9. **🎨 Fase 1.A** (kanban por Estado, filtro: Fase = Fase 1.A).
10. **🎨 Fase 1.B** (kanban por Estado, filtro: Fase = Fase 1.B).
11. **🎨 Fase 1.C** (kanban por Estado, filtro: Fase = Fase 1.C).
12. **🏗 Backend** (tabla, filtro: Capa = Backend, agrupado por Módulo).
13. **🎨 Frontend** (tabla, filtro: Capa = Frontend, agrupado por Módulo).
14. **💾 Database** (tabla, filtro: Capa = Database).
15. **🔐 Compliance** (tabla, filtro: Etiquetas contiene #fundae OR #rgpd OR #evidencia).
16. **🤖 IA** (tabla, filtro: Etiquetas contiene #ia).

## Procedimiento de carga

### Paso 1: crear infraestructura

1. Crea la página raíz "Didacta — Proyecto".
2. Crea las 6 bases de datos como subpáginas.
3. Define todas las propiedades con los valores correctos.
4. Configura todas las vistas de la base "Backlog".
5. Añade los enlaces cruzados en la página raíz.

### Paso 2: poblar reglas de negocio

Lee `docs/casos-uso/reglas-negocio.md` y crea una página por cada RN con todas sus
propiedades. Esto debe ir primero porque los UCs las referencian.

### Paso 3: poblar casos de uso

Lee todos los ficheros `docs/casos-uso/fase-*/uc-*.md` y crea una página por cada UC
con:
- Título = "UC-... : Título"
- Todas las propiedades rellenadas.
- Cuerpo = contenido del UC.
- Relaciones a reglas de negocio establecidas.

### Paso 4: poblar historias de usuario

Lee todas las historias de `docs/casos-uso/fase-*/historias-usuario.md` y crea una
página por historia con:
- Relación al UC padre establecida.
- Cuerpo con los escenarios Gherkin.

### Paso 5: poblar backlog de tareas

Lee todos los ficheros `docs/tareas/fase-*/*.md` y crea una página por tarea con:
- Todas las propiedades (Tipo, Capa, Fase, Módulo, Prioridad, Estimación, Etiquetas).
- Estado inicial = Backlog.
- Relación a la historia padre establecida.
- Cuerpo con descripción técnica, DoD, notas, riesgos.

### Paso 6: resolver dependencias

Segunda pasada sobre las tareas: para cada tarea que tenga "Dependencias técnicas"
referenciando otras tareas por ID, establece la relación `Dependencias`.

### Paso 7: añadir decisiones pendientes

Lee `docs/casos-uso/decisiones-pendientes.md` y crea una página por decisión en la
base "Decisiones pendientes".

### Paso 8: resumen final

Al terminar, actualiza la página raíz con un resumen:

- Número total de UCs por fase.
- Número total de historias por fase.
- Número total de tareas por fase, por capa.
- Estimación total en días por fase.
- Ruta crítica identificada.
- Decisiones pendientes abiertas.

## Reglas de robustez

1. **Idempotencia**: antes de crear cualquier página, verifica si ya existe buscando
   por ID. Si existe, actualiza en lugar de duplicar.
2. **Rate limiting**: respeta los límites del MCP de Notion. Si hay 429, espera y
   reintenta con backoff exponencial.
3. **Batching**: agrupa creaciones relacionadas para minimizar llamadas al MCP.
4. **Logging**: imprime progreso cada 10 items creados con resumen acumulado.
5. **Resumen de errores**: al final, lista cualquier item que no se haya podido
   crear con el motivo.

## Output final esperado

Al terminar, entrega al usuario:

```
✅ Notion configurado para Didacta

📊 Estadísticas:
- Casos de uso creados: XXX
- Historias de usuario: XXX
- Tareas en backlog: XXX
- Reglas de negocio: XXX
- Decisiones pendientes: XXX

📍 URLs:
- Página raíz del proyecto: <url>
- Backlog principal: <url>
- Vista Sprint actual: <url>
- Timeline: <url>

⚠️ Elementos con problemas (si los hubo): [lista]

🎯 Próximos pasos sugeridos:
1. Revisar decisiones pendientes y asignar owners/due dates.
2. Hacer grooming de las primeras tareas de Fase 0.
3. Definir Sprint 1 arrastrando tareas de Fase 0 a la propiedad Sprint.
4. Arrancar implementación.
```

---

Empieza por verificar acceso al MCP de Notion. Después procede con el Paso 1.
Si en cualquier momento encuentras un problema estructural (por ejemplo una propiedad
de Notion que no puedas crear con el tipo deseado), detente y pregunta antes de
improvisar.
