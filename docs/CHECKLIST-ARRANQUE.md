# LearnShip — Checklist de arranque

> **Propósito**: asegurar que todo el entorno está listo antes de ejecutar los prompts
> de Claude Code y empezar a construir el proyecto.
>
> **Tiempo estimado**: 1-2 horas para completar todos los checks.

---

## 1. Requisitos previos

### 1.1 Software local

- [ ] Node.js 22 LTS instalado (`node --version` devuelve `v22.x`).
- [ ] pnpm 9+ instalado (`pnpm --version`).
- [ ] Docker Desktop o Docker Engine + Compose instalado y funcionando.
- [ ] Git configurado con usuario y email correctos.
- [ ] GitHub CLI instalado y autenticado (`gh auth status`).
- [ ] Claude Code instalado (`claude --version`).
- [ ] Editor principal (VS Code o Cursor) listo.

### 1.2 Accesos y credenciales

- [ ] Cuenta GitHub con permisos para crear repositorios en la organización VA360 LABS.
- [ ] Acceso administrador a Hetzner Cloud.
- [ ] Acceso administrador a Easypanel (`easypanel.va360-labs.com` o similar).
- [ ] Credenciales Zoom: cuenta de pago con acceso a API.
  - [ ] Crear app "LearnShip Dev" en Zoom Marketplace (Server-to-Server OAuth).
  - [ ] Anotar Account ID, Client ID, Client Secret.
- [ ] API key de Anthropic con créditos (para pruebas de Fase 1.C; no necesario en Fase 0).
- [ ] Credenciales Brevo SMTP (ya en uso).
- [ ] Acceso a Notion con workspace activo y MCP conectado.
- [ ] Acceso al MCP de n8n (opcional en Fase 0, necesario en Fase 1.C).

## 2. Preparación del repositorio

### 2.1 Crear el repositorio

```bash
# Desde tu directorio de proyectos
gh repo create va360-labs/learnship --private \
  --description "LearnShip - Modular LMS platform (VA360 LABS)" \
  --clone

cd learnship
```

- [ ] Repositorio creado en GitHub como privado.
- [ ] Clonado localmente.

### 2.2 Poner la documentación en su sitio

Copiar los siguientes archivos al repo en la estructura indicada:

```
learnship/
├── deep-research-report.md          # PRD v1 original (referencia normativa)
├── docs/
│   ├── PRD.md                       # v2 nuevo
│   ├── PLAN-FASES.md
│   ├── ARQUITECTURA-MODULAR.md
│   └── CHECKLIST-ARRANQUE.md        # este documento
├── prompts/
│   ├── prompt-01-casos-uso.md
│   ├── prompt-02-tareas-tecnicas.md
│   └── prompt-03-notion-kanban.md
└── .gitignore
```

- [ ] Documentación copiada.
- [ ] `.gitignore` básico creado (Node, TS, dotenv, OS files).

### 2.3 Commit inicial

```bash
git add .
git commit -m "docs: initial project documentation (PRD, phases, modular architecture, prompts)"
git push -u origin main
```

- [ ] Commit y push realizado.

## 3. Preparación del entorno Notion

### 3.1 Espacio de trabajo

- [ ] Crear un espacio o sección en Notion llamado "LearnShip" (o similar).
- [ ] Asegurar que el MCP de Notion tiene permisos sobre ese espacio.
- [ ] Verificar desde Claude que el MCP está activo:
  ```
  /mcp
  ```
  Debe mostrar Notion conectado.

### 3.2 Plantillas opcionales (recomendado)

- [ ] (Opcional) Crear plantilla de página para ADRs.
- [ ] (Opcional) Crear plantilla de página para retros.

## 4. Preparación del entorno de desarrollo

### 4.1 Configuración de Easypanel

- [ ] Acceder a Easypanel.
- [ ] Crear el proyecto `learnship`.
- [ ] Planificar los 3 entornos (crear solo dev por ahora):
  - `learnship-dev` — desarrollo con branch `main` auto-deploy.
  - `learnship-staging` — se crea al acabar Fase 0.
  - `learnship-prod` — se crea antes del piloto de Fase 1.C.

### 4.2 Servicios compartidos locales

Por simplicidad, durante Fase 0 y parte de Fase 1.A el desarrollo será 100% local.
Verificar que tu equipo puede correr:

- [ ] Postgres 16 vía Docker.
- [ ] Redis 7 vía Docker.
- [ ] MinIO (para S3 local) vía Docker.
- [ ] MailPit (para capturar emails en dev) vía Docker.

No los arranques aún — se hará con el `docker-compose.yml` generado en Fase 0.

## 5. Preparación de Claude Code

### 5.1 Sesiones separadas

Es **importante** ejecutar los prompts en sesiones de Claude Code separadas para
evitar sobrecarga de contexto:

- [ ] Sesión 1 = Prompt 01 (casos de uso).
- [ ] Sesión 2 = Prompt 02 (tareas técnicas).
- [ ] Sesión 3 = Prompt 03 (volcado a Notion).

### 5.2 Configuración de Claude Code

En la raíz del repo, crear `CLAUDE.md` con contexto base del proyecto:

```markdown
# LearnShip — Contexto para Claude Code

## Sobre el proyecto

LearnShip es una plataforma LMS modular propiedad de VA360 LABS S.L.
Arquitectura: NestJS + Next.js + Postgres (RLS) + Redis + Anthropic API.
Principio rector: **modularidad extrema**.

## Documentos clave (lee antes de cualquier tarea)

1. `docs/PRD.md` — Product Requirements Document completo.
2. `docs/PLAN-FASES.md` — Plan por fases con entregables.
3. `docs/ARQUITECTURA-MODULAR.md` — Contrato de módulo (crítico).
4. `deep-research-report.md` — PRD v1 con detalle normativo Fundae/IFAPA.

## Reglas de trabajo

- Español como idioma por defecto, excepto identificadores técnicos.
- Conventional commits obligatorios.
- Tests obligatorios para lógica de negocio (coverage >70%).
- Respetar el contrato de módulo en todo cambio a `modules/*`.
- No introducir dependencias cruzadas entre módulos.
- ADRs obligatorias para decisiones arquitectónicas no triviales.

## Estado actual

Proyecto en Fase 0 (discovery). El código aún no existe; sólo documentación.
```

- [ ] Archivo `CLAUDE.md` creado en la raíz del repo.

## 6. Validación final

### 6.1 Test de documentación

Hacer una lectura completa de los 4 documentos en este orden:

- [ ] `docs/PRD.md` entero, leído y comprendido.
- [ ] `docs/PLAN-FASES.md` entero.
- [ ] `docs/ARQUITECTURA-MODULAR.md` entero.
- [ ] `prompts/prompt-01-casos-uso.md` revisado.

### 6.2 Cuestiones a resolver antes de Fase 0

Responder por escrito (en un ADR, en Notion, o en un doc de decisiones):

- [ ] Proveedor de autenticación definitivo: **Better-Auth** o **Auth.js v5**?
  Recomendación: Better-Auth por modularidad + MFA nativo + multi-tenancy friendly.
- [ ] MinIO self-hosted o Hetzner Object Storage para prod? (dev siempre MinIO).
- [ ] Observabilidad: **Sentry** (SaaS) o **Grafana/Loki/Tempo** (self-hosted)?
  Recomendación Fase 0-1: Sentry; migrar a self-hosted en Fase 2 si escala.
- [ ] Dominio inicial: `learnship.dev`, `learnship.va360.pro`, u otro?
- [ ] Branch strategy: trunk-based con `main` + PRs (recomendado) vs gitflow?
- [ ] Política de revisión de PRs: ¿autorrevisar está permitido en Fase 0 para ir
  más rápido, o ya desde el principio se exige review externa?
  Recomendación: autorrevisar en Fase 0 hasta que entre un segundo developer.

### 6.3 Validación legal temprana (crítico pero no bloqueante para Fase 0)

Agendar con asesoría jurídica para Fase 1.B:

- [ ] Revisión de requisitos Fundae para LMS (lo que cubre, lo que no).
- [ ] Validez de firma digitalizada/biométrica como evidencia.
- [ ] Contratos de encargado de tratamiento (DPA) con proveedores:
  - Anthropic (Fase 1.C).
  - Zoom (Fase 1.B).
  - Hetzner (inmediato).
  - Brevo (existente).

## 7. Arranque: ejecutar los 3 prompts

Una vez completada la checklist:

### 7.1 Sesión 1 — Prompt 01

```bash
cd learnship
claude
```

En la sesión:

```
Lee el archivo `prompts/prompt-01-casos-uso.md` y ejecútalo siguiendo las
instrucciones al pie de la letra. Empieza por Fase 0 y pausa cuando termines.
```

- [ ] Prompt 01 ejecutado, Fase 0 completada.
- [ ] Revisar calidad, corregir, aprobar.
- [ ] Continuar con Fase 1.A, 1.B, 1.C en la misma sesión (con pausas intermedias).

### 7.2 Sesión 2 — Prompt 02

Nueva sesión de Claude Code:

```
Lee el archivo `prompts/prompt-02-tareas-tecnicas.md` y ejecútalo. Empieza por
convenciones-tecnicas.md y después Fase 0.
```

- [ ] Prompt 02 ejecutado fase a fase con revisiones intermedias.

### 7.3 Sesión 3 — Prompt 03

Nueva sesión de Claude Code (asegurando MCP Notion activo):

```
Lee el archivo `prompts/prompt-03-notion-kanban.md` y ejecútalo. Verifica primero
que tienes acceso al MCP de Notion.
```

- [ ] Prompt 03 ejecutado, Notion configurado con todo el backlog.

## 8. Después del arranque

Una vez las 3 sesiones hayan terminado:

- [ ] Sprint 0 planificado en Notion con tareas de Fase 0 asignadas.
- [ ] Kick-off de Fase 0 (aunque sea un kick-off contigo mismo).
- [ ] Comenzar implementación de Fase 0 con Claude Code asistiendo en tareas
  concretas, una por una, respetando el contrato de módulo desde el día 1.

---

**Importante**: no intentes que Claude Code ejecute los 3 prompts en una sola
sesión. La cantidad de información generada satura el contexto y degrada la
calidad. Respeta las pausas y las sesiones separadas.
