# Prompt 01 — Generación de casos de uso e historias de usuario

> **Uso**: copiar y pegar este prompt completo en una nueva sesión de Claude Code
> (en la raíz del repo `didacta` con los docs ya en su sitio).
>
> **Precondición**: los siguientes archivos están en el repo:
> - `docs/PRD.md`
> - `docs/PLAN-FASES.md`
> - `docs/ARQUITECTURA-MODULAR.md`
> - `deep-research-report.md` (original, como referencia normativa)

---

# Tarea: generar casos de uso e historias de usuario para Didacta

Eres un Product Engineer senior con experiencia en LMS, cumplimiento Fundae y
arquitecturas modulares. Tu tarea es leer los documentos del repositorio y generar
documentación ejecutable que alimente el backlog del proyecto.

## Contexto

Didacta es una plataforma LMS modular (documentación completa en `docs/PRD.md`).
Se construye en fases:

- **Fase 0** (2 semanas): Discovery técnico y fundaciones.
- **Fase 1.A** (8 semanas): CORE + cursos asíncronos + certificados.
- **Fase 1.B** (8 semanas): Zoom directo + comunidad + Fundae básico.
- **Fase 1.C** (8 semanas): IA integrada + piloto + auditoría externa.
- **Fase 2+**: módulos futuros (migradores, SSO, comercial, IFAPA).

El stack, los módulos y el contrato de modularidad están cerrados. Lee antes de
empezar:

1. `docs/PRD.md` (completo).
2. `docs/PLAN-FASES.md` (completo).
3. `docs/ARQUITECTURA-MODULAR.md` (completo).
4. `deep-research-report.md` (secciones 2 y 3 sobre normativa Fundae).

## Qué hay que producir

Crea la siguiente estructura en `docs/casos-uso/`:

```
docs/casos-uso/
├── README.md                              # índice y convenciones
├── actores.md                              # definición de actores
├── glosario.md                             # términos del dominio
├── reglas-negocio.md                       # RN-NNN con referencias normativas
├── decisiones-pendientes.md                # UCs marcados como DECISIÓN PENDIENTE
├── fase-0-discovery.md                     # casos de uso técnicos de Fase 0
├── fase-1a-core-learning/
│   ├── README.md                           # índice de la fase
│   ├── uc-core-iam.md                      # UCs de IAM
│   ├── uc-core-tenancy.md                  # UCs de multi-tenancy
│   ├── uc-core-audit-evidence.md           # UCs de audit log + evidence vault
│   ├── uc-core-notifications.md            # UCs del notification hub
│   ├── uc-courses.md                       # UCs del módulo mod.courses
│   ├── uc-learning.md                      # UCs del módulo mod.learning
│   ├── uc-assessments.md                   # UCs del módulo mod.assessments
│   ├── uc-certificates.md                  # UCs del módulo mod.certificates
│   └── historias-usuario.md                # historias en Gherkin de la fase
├── fase-1b-directo-comunidad-fundae/
│   ├── README.md
│   ├── uc-zoom-live.md
│   ├── uc-community.md
│   ├── uc-fundae.md
│   └── historias-usuario.md
└── fase-1c-ia-piloto/
    ├── README.md
    ├── uc-ai-tutor.md
    ├── uc-ai-grader.md
    ├── uc-ai-content.md
    ├── uc-ai-analytics.md
    ├── uc-n8n-bridge.md
    └── historias-usuario.md
```

## Formato por caso de uso

Usa este formato EXACTO para cada UC:

```markdown
### UC-[FASE]-[MÓDULO]-[NNN]: [Título corto]

**Módulo**: [core / mod.courses / mod.learning / ...]
**Actor primario**: [super_admin / tenant_admin / formador / alumno / auditor / empresa_manager / sistema]
**Actores secundarios**: [lista o "Ninguno"]
**Prioridad**: [P0 / P1 / P2]
**Estimación**: [S / M / L / XL]
**Etiquetas**: [#fundae #ia #evidencia ...]

**Precondiciones**:
- [condición 1]
- [condición 2]

**Flujo principal**:
1. [paso 1]
2. [paso 2]
3. ...

**Flujos alternativos**:
- **A1 — [nombre]**: [paso donde diverge], [qué pasa].
- **A2 — [nombre]**: ...

**Postcondiciones**:
- [estado resultante 1]
- [estado resultante 2]

**Reglas de negocio aplicables**: [RN-NNN, RN-NNN]

**Dependencias**:
- UCs previos: [UC-... o "Ninguno"]
- Módulos requeridos: [lista]

**Eventos emitidos**: [event.name.action]
**Eventos consumidos**: [event.name.action]

**Notas**:
[observaciones, decisiones, referencias a docs]
```

## Formato por historia de usuario (Gherkin)

```markdown
### HU-[FASE]-[NNN]: [Título]

**Caso de uso padre**: UC-[...]
**Como** [rol]
**Quiero** [acción u objetivo]
**Para** [beneficio / motivación]

#### Escenario: [Escenario feliz]

```gherkin
Dado que [precondición]
Y [precondición adicional]
Cuando [acción del actor]
Entonces [resultado esperado]
Y [resultado adicional]
```

#### Escenario: [Escenario alternativo / error]

```gherkin
Dado ...
Cuando ...
Entonces ...
```

**Criterios de aceptación adicionales**:
- [criterio 1]
- [criterio 2]

**Notas técnicas** (si aplica):
[hints para implementación]
```

## Formato de reglas de negocio

En `reglas-negocio.md`:

```markdown
### RN-[NNN]: [Título]

**Descripción**: [regla en lenguaje natural, 1-3 frases]
**Fuente**: [normativa / decisión de producto / referencia]
**Módulos afectados**: [lista]
**UCs donde aplica**: [lista]
**Parametrizable**: [Sí (con default X) / No]
**Ejemplo**: [ejemplo concreto]
```

## Reglas para la generación

1. **Idioma**: todo en español excepto identificadores técnicos.
2. **Numeración estable**: UC-1A-CORE-IAM-001, HU-1A-001, RN-001. Comienza desde 001
   en cada fichero de UCs y desde 001 en cada fichero de historias.
3. **Exhaustividad**: cubre todos los módulos de la fase. Si el PRD menciona algo
   relevante, debe haber al menos un UC.
4. **No inventes requisitos**: si algo no está en los docs, NO lo añadas; en su lugar
   crea un UC de tipo `DECISIÓN PENDIENTE` y muévelo a `decisiones-pendientes.md`.
5. **Marcas especiales**:
   - `[FUNDAE]` en tag para UCs vinculados a cumplimiento Fundae.
   - `[IA]` para UCs que usan el módulo de IA.
   - `[EVIDENCIA]` para UCs que producen artefactos para evidence vault.
   - `[MODULARIDAD]` para UCs que testean el contrato de módulo.
6. **Cada UC debe tener al menos 1 historia de usuario**. UCs complejos pueden tener
   varias.
7. **Cada historia debe tener al menos 1 escenario feliz + 1 escenario de error**.
8. **Gherkin en español**: Dado / Y / Cuando / Entonces / Pero.
9. **No escribas código**. Solo casos de uso, historias, reglas.

## Cobertura mínima por fase

### Fase 0 (mínimo 8 UCs)

- Setup del repo monorepo.
- Configuración de CI/CD.
- Prisma schema inicial.
- Implementación del contrato de módulo (`packages/core-kernel`).
- Módulo de ejemplo `hello-world`.
- Configuración de entornos en Easypanel.
- Migraciones iniciales.
- Healthcheck y observabilidad básica.

### Fase 1.A (mínimo 35-45 UCs)

Core (15-20 UCs): IAM, MFA, tenancy, RLS, audit log, evidence vault, notification hub,
module registry, API gateway, i18n.

Módulos de negocio (20-25 UCs):
- `mod.courses`: crear/editar/publicar cursos, estructura jerárquica, versionado.
- `mod.learning`: matriculación (3 modalidades), player, progreso, reanudación,
  import SCORM/xAPI.
- `mod.assessments`: tipos de quiz, corrección manual, retries.
- `mod.certificates`: plantilla, emisión, descarga, verificación pública.

### Fase 1.B (mínimo 35-45 UCs)

- `mod.zoom-live` (10-12 UCs): configuración OAuth/S2S, crear meeting, registro
  asistencia, grabación, evidencia para Fundae.
- `mod.community` (10-12 UCs): espacios, feed, posts, comentarios, reacciones,
  menciones, moderación, notificaciones.
- `mod.fundae` (15-20 UCs): empresa bonificada, RLPT, acción formativa, grupo,
  comunicación inicio/fin, costes, cierre, paquete auditoría.

### Fase 1.C (mínimo 25-35 UCs)

- `mod.ai-tutor` (7-9 UCs): indexación, chat, límites, histórico.
- `mod.ai-grader` (6-8 UCs): rúbricas, corrección, HITL, métricas.
- `mod.ai-content` (5-7 UCs): resúmenes, flashcards, quizzes generados.
- `mod.ai-analytics` (4-6 UCs): detección abandono, dashboard, triggers.
- `mod.n8n-bridge` (4-6 UCs): webhooks, HMAC, catálogo eventos, nodo n8n.
- Hardening y piloto (3-5 UCs): RGPD review, MFA obligatorio, pentest, migración
  completa de un curso VA360, auditoría externa.

## Orden de ejecución

Procede fase por fase. Al terminar cada fase:

1. Genera todos los ficheros de esa fase.
2. Escribe un resumen: "Generados N UCs, M historias, K reglas para Fase X".
3. **Pausa y pide confirmación** antes de continuar con la siguiente fase.

Orden recomendado: Fase 0 → Fase 1.A → Fase 1.B → Fase 1.C. Al finalizar, actualiza
`docs/casos-uso/README.md` con el índice completo.

## Criterios de calidad (self-check antes de entregar cada fase)

- [ ] Todos los UCs tienen actor, precondiciones, flujo, postcondiciones.
- [ ] Todos los UCs están numerados y el esquema es consistente.
- [ ] Todas las historias tienen al menos un escenario feliz y uno de error.
- [ ] Todas las reglas de negocio están referenciadas desde al menos un UC.
- [ ] No hay UCs huérfanos (sin al menos una historia).
- [ ] Las decisiones pendientes están listadas en `decisiones-pendientes.md`.
- [ ] El glosario cubre todos los términos técnicos del dominio usados en los UCs.
- [ ] La cobertura mínima por fase se cumple.

---

Empieza ahora con **Fase 0**. Cuando termines, pausa y espera confirmación.
