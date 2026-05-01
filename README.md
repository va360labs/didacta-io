# Didacta Community

> 📚 **El LMS de nueva generación. Open-source, modular y listo para Fundae.**

[![Docker](https://img.shields.io/badge/docker-hub-blue)](https://hub.docker.com/r/didactaio/community)
[![License](https://img.shields.io/badge/license-Sustainable%20Use%201.0-orange)](LICENSE)
[![Versioning](https://img.shields.io/badge/versioning-SemVer-green)](docs/versioning.md)
[![Stage](https://img.shields.io/badge/stage-alpha-red)](docs/alpha/INSTALL.md)
[![Web](https://img.shields.io/badge/web-didacta.io-black)](https://didacta.io)

## Estado actual

🚧 **Alpha pública** — primer milestone público en `v0.0.1-alpha.0`. Lanzamiento previsto: mayo de 2026.

Imagen oficial publicada en Docker Hub: [`didactaio/community`](https://hub.docker.com/r/didactaio/community). **Pública** — no requiere `docker login`.

## Verificar acceso a la imagen

```bash
# Tag oficial pinned (recomendado para alpha testers)
docker pull didactaio/community:0.0.1-alpha.0

# Alternativa: tag rolling de la última alpha
docker pull didactaio/community:alpha
```

Si baja sin pedir credenciales, estás listo para cualquiera de los dos caminos de despliegue de abajo.

## Variables de entorno obligatorias

Solo 4 ENVs son **estrictamente obligatorias** para que la app arranque. El resto tienen defaults razonables o se inyectan desde el compose. Set completo y documentado en [`.env.example`](.env.example).

| Variable                  | Qué es                                                                                                                    | Cómo generarla                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Connection string Postgres 16 con extensión `pgvector` instalada.                                                         | Apunta a tu Postgres. Para compose: `postgresql://didacta:didacta_dev@postgres:5432/didacta?schema=public`. |
| `REDIS_URL`               | Connection string Redis 7.                                                                                                | Apunta a tu Redis. Para compose: `redis://redis:6379`.                                                      |
| `AUTH_SECRET`             | Secret para firmar sesiones / cookies. Mínimo 32 chars.                                                                   | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                               |
| `TENANT_SETTINGS_ENC_KEY` | Clave AES-256 (hex 32 bytes) que cifra settings sensibles por tenant en DB (claves API IA, secrets SMTP por tenant, etc). | `openssl rand -hex 32`                                                                                      |

> ⚠️ `TENANT_SETTINGS_ENC_KEY` no se rota a la ligera: perderías acceso a los settings cifrados. Backup antes de tocarla.

## Camino A — Docker Compose (recomendado)

Stack completo en local: API + web + Postgres + Redis + MinIO (S3) + Mailpit (SMTP).

```bash
# 1. Clonar
git clone https://github.com/va360labs/didacta-community.git
cd didacta-community

# 2. Configurar .env
cp .env.example .env

# 3. Generar los 2 secrets obligatorios
echo "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
echo "TENANT_SETTINGS_ENC_KEY=$(openssl rand -hex 32)" >> .env

# 4. Fijar la versión de la imagen (default: alpha)
echo "DIDACTA_IMAGE_TAG=0.0.1-alpha.0" >> .env

# 5. Arrancar
docker compose -f docker-compose.alpha.yml up -d

# 6. Esperar healthchecks (~60-90s la primera vez)
docker compose -f docker-compose.alpha.yml ps

# 7. Abrir
# http://localhost:3000             — Web
# http://localhost:4000/api/docs    — Swagger
# http://localhost:4000/healthz     — health probe
# http://localhost:8025             — Mailpit (emails de prueba)
# http://localhost:9001             — MinIO console
```

Manual completo con troubleshooting, primer admin, actualización de versión y operaciones del día a día: [`docs/alpha/INSTALL.md`](docs/alpha/INSTALL.md) y [`docs/alpha/RUNBOOK.md`](docs/alpha/RUNBOOK.md). Reportar bugs / feedback: [`docs/alpha/FEEDBACK.md`](docs/alpha/FEEDBACK.md).

## Camino B — Docker pull + run manual

Para operadores que ya tienen Postgres 16 + Redis 7 administrados y solo quieren correr el contenedor de la app.

**Pre-requisitos:**

- Postgres 16 con extensión `pgvector` instalada y schema vacío (la app aplica las migraciones Prisma al arrancar).
- Redis 7 accesible desde el contenedor.
- Las 4 ENVs obligatorias listadas arriba.

```bash
docker pull didactaio/community:0.0.1-alpha.0

docker run -d \
  --name didacta-app \
  -p 3000:3000 \
  -p 4000:4000 \
  -e DATABASE_URL='postgresql://USER:PASS@HOST:5432/didacta?schema=public' \
  -e REDIS_URL='redis://HOST:6379' \
  -e AUTH_SECRET='...' \
  -e TENANT_SETTINGS_ENC_KEY='...' \
  -e NODE_ENV=production \
  --restart unless-stopped \
  didactaio/community:0.0.1-alpha.0
```

**Verificar:**

```bash
docker logs -f didacta-app                  # ver bootstrap + migraciones Prisma
curl -fsS http://localhost:4000/healthz     # debe responder 200
```

**Variables opcionales útiles** (set completo en [`.env.example`](.env.example)):

| Variable                                                        | Para qué                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`    | Storage S3-compatible (MinIO, AWS, Hetzner, etc.). Obligatorio para subida de contenido.     |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Envío de emails transaccionales. Sin esto, los emails se loguean pero no salen.              |
| `DIDACTA_LICENSE_KEY`                                           | JWT firmado por Didacta para activar capabilities Enterprise. Sin esto, modo Community puro. |
| `METRICS_TOKEN`                                                 | Bearer token para proteger `/metrics` (Prometheus). Si está vacío, endpoint público.         |

## Sobre el proyecto

Didacta es un LMS (Learning Management System) **open-source de nueva generación**: arquitectura modular, sin licencias por usuario y con cumplimiento legal integrado en el núcleo. Diseñado para academias, formadores y organizaciones que quieren operar su propia plataforma de formación con control total.

Más información y demo en vivo: [didacta.io](https://didacta.io).

### Por qué Didacta

- **Modular de verdad.** Instala solo lo que necesitas. Cada función es un módulo limpio: sin parches, sin temas que rompen en cada actualización, sin deuda técnica acumulada.
- **Software libre.** Tu plataforma, tu código. Audítalo, modifícalo, despliégalo, redistribúyelo. Sin licencias por usuario.
- **Cumplimiento serio.** Fundae, RGPD y WCAG 2.2 AA integrados en el núcleo, no añadidos con plugins de terceros. Trazabilidad, auditoría y exportación de datos listos desde el día uno.
- **IA discreta.** Inteligencia artificial que ayuda sin interrumpir: crea contenido, sugiere itinerarios y resume actividad.

### Tres ediciones, mismo producto

| Edición                   | Para quién                                                            | Incluye                                                                                                          |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Community** (este repo) | Equipos que despliegan y operan ellos mismos.                         | Todo el código fuente. Comunidad activa de contribuidores.                                                       |
| **Cloud**                 | Quien quiere arrancar en minutos, sin infraestructura.                | Hosting gestionado, backups automáticos diarios, actualizaciones sin intervención. Desde 20 €/mes.               |
| **Enterprise**            | Organizaciones con SLA, integraciones a medida y partner certificado. | Account manager dedicado, onboarding guiado, integraciones con sistemas existentes, infraestructura monitoreada. |

Detalles y precios: [didacta.io](https://didacta.io).

## Modelo de licencias

Didacta es **fair-code**: source-available, uso interno empresarial libre, distribución comercial / SaaS de terceros bajo acuerdo. Modelo Open-Core con capabilities Enterprise blindadas:

- **Repo + módulos**: [Didacta Sustainable Use License v1.0](LICENSE) (fair-code, adaptada de n8n SUL). Permite uso interno empresarial libre. Distribución comercial / SaaS / white-label requiere acuerdo con VA360 LABS S.L.
- **Capabilities Enterprise** (archivos `*.ee.*` dentro del CORE): [Didacta Enterprise License](LICENSE_EE). Requieren licencia firmada activa para usarse en producción.
- **Cloud**: SaaS gestionado por VA360 (`cloud.didacta.io`).

Resumen humano: [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md). FAQ: [`docs/licensing/faq.md`](docs/licensing/faq.md). Política de uso comercial: [`COMMERCIAL_USE.md`](COMMERCIAL_USE.md). Marca registrada: [`TRADEMARKS.md`](TRADEMARKS.md).

## Documentación

- 🚀 [`docs/alpha/INSTALL.md`](docs/alpha/INSTALL.md) — Manual completo de instalación.
- 📘 [`docs/alpha/RUNBOOK.md`](docs/alpha/RUNBOOK.md) — Operación día a día.
- 🐛 [`docs/alpha/FEEDBACK.md`](docs/alpha/FEEDBACK.md) — Cómo reportar bugs.
- 🔒 [`SECURITY.md`](SECURITY.md) — Política de seguridad y reporte responsable.
- 📋 [`CHANGELOG.md`](CHANGELOG.md) — Historial de cambios.
- 🤝 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Código de conducta.

## Stack tecnológico

- **Backend**: Node.js 22 + NestJS 11 + TypeScript.
- **Frontend**: Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui.
- **Base de datos**: PostgreSQL 16 con Row-Level Security + Prisma.
- **Cache / colas**: Redis 7 + BullMQ.
- **Object storage**: S3-compatible (MinIO en compose, cualquier proveedor S3 en producción).
- **IA**: capa pluggable — alpha actual usa proveedor LLM externo, futuras versiones permitirán swap.
- **Monorepo**: Turborepo + pnpm workspaces.

## Licencia

Didacta Community © 2026 VA360 LABS S.L. — distribuido bajo [Didacta Sustainable Use License v1.0](LICENSE) (fair-code).

Capabilities Enterprise: [Didacta Enterprise License](LICENSE_EE).

Didacta™ es marca registrada de VA360 LABS S.L. Ver [`TRADEMARKS.md`](TRADEMARKS.md).
