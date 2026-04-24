# Contribuir a LearnShip

Guía rápida de flujo de trabajo.

## Requisitos

- Node.js 22 LTS (`.nvmrc` incluido — usa `nvm use` si tenés nvm).
- pnpm 9 o superior (`corepack enable` si no lo tenés).
- Docker Desktop o Docker Engine + Compose.
- Git + GitHub CLI autenticado.

## Setup inicial

```bash
pnpm install
cp .env.example .env       # cuando exista
docker compose up -d       # levanta Postgres, Redis, MinIO, MailPit (cuando exista)
pnpm dev                   # arranca todos los servicios en watch mode
```

El primer `pnpm install` activa automáticamente los hooks de Husky.

## Ramas

- `main` — rama protegida, siempre deployable.
- `feat/<descripción>` — nuevas features.
- `fix/<descripción>` — correcciones de bugs.
- `chore/<descripción>` — tareas de mantenimiento.
- `docs/<descripción>` — cambios de documentación.

Ejemplos:

- `feat/T-F0-007-module-registry`
- `fix/learning-progress-race-condition`
- `docs/adr-003-auth-provider`

## Convenciones de commit

Usamos **Conventional Commits**. Commitlint valida en cada commit.

```
<type>(<scope>): <descripción corta en español>

[body opcional explicando el porqué]

[footer opcional]
```

Tipos permitidos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Ejemplos:

```
feat(api): añadir endpoint /healthz con métricas de uptime
fix(learning): evitar doble emisión de learning.course.completed
docs(adr): aprobar ADR-005 sobre Prisma 5 como ORM
chore: actualizar dependencias del monorepo
```

**Nunca** añadir "Co-Authored-By" ni referencias a asistentes IA en el cuerpo del commit.

## Pull Requests

Uno por feature. Formato del título: igual que un commit convencional.

Descripción:

```markdown
## Resumen

Qué se hace y por qué.

## Cambios

- Lista concreta de archivos o módulos afectados.

## Plan de test

- [ ] Pasos manuales o automáticos para verificar.

## Referencias

- Notion: LMS-<N>
- ADR: <número si aplica>
```

## Estructura del repositorio

```
learnship/
├── apps/              # Aplicaciones desplegables (api, web, super-admin, workers)
├── packages/          # Paquetes del core y utilidades (core-kernel, database, sdk, ui)
├── modules/           # Módulos de negocio (courses, learning, fundae, ai-tutor, ...)
├── docs/              # Documentación viva (PRD, ADRs, arquitectura, runbooks)
├── prompts/           # Prompts para generación asistida
└── infra/             # Docker, Easypanel, GitHub Actions
```

## Tests y calidad

Antes de abrir PR:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Coverage mínimo 70% en lógica de negocio (services, handlers). E2E con Playwright para flujos críticos.

## Contrato de módulo

Crítico. Cualquier cambio a `modules/*` debe respetar el contrato definido en [`docs/ARQUITECTURA-MODULAR.md`](docs/ARQUITECTURA-MODULAR.md). Un cambio al contrato exige **ADR aprobada** y major bump del core.

## Licencia

Proprietary © 2026 VA360 LABS S.L. No contribuciones externas sin acuerdo previo.
