# Didacta Community

> 📚 **El LMS de nueva generación. Fair-code, modular y listo para Fundae.**

[![Docker](https://img.shields.io/badge/ghcr-didacta--community-blue)](https://github.com/va360labs/didacta-io/pkgs/container/didacta-community)
[![License](https://img.shields.io/badge/license-Sustainable%20Use%201.0-orange)](LICENSE)
[![Versioning](https://img.shields.io/badge/versioning-SemVer-green)](https://semver.org)
![Stage](https://img.shields.io/badge/stage-beta-orange)
[![Web](https://img.shields.io/badge/web-didacta.io-black)](https://didacta.io)
[![Creado por VA360 LABS](https://img.shields.io/badge/creado%20por-VA360%20LABS-1f2937)](https://va360labs.com)

🌍 **Español** · [English](README.en.md)

Creado y mantenido por **[VA360 LABS S.L.](https://va360labs.com)**, autora
original del proyecto.

## Enlaces de interés

|                               |                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| 🌐 **Producto y precios**     | [didacta.io](https://didacta.io) · [ediciones y precios](https://didacta.io/es/pricing)                 |
| 📚 **Documentación**          | [docs.didacta.io](https://docs.didacta.io) — instalación, actualización, operación y versionado (es/en) |
| 📦 **Imagen oficial**         | `ghcr.io/va360labs/didacta-community`                                                                   |
| 📋 **Versiones publicadas**   | [Releases](https://github.com/va360labs/didacta-io/releases)                                            |
| ⚖️ **Licencia, en cristiano** | [didacta.io/es/license](https://didacta.io/es/license) · [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)       |
| 🏢 **Quién lo hace**          | [va360labs.com](https://va360labs.com)                                                                  |

## Estado actual

🧪 **Beta pública** (`0.1.0-beta.N`). El producto maduró entre mayo y julio de 2026 sirviendo en
producción real a su primer despliegue; desde el 31 de julio de 2026 el repo
es el producto whitelabel, y en agosto de 2026 entró en beta pública. Guías de
instalación, actualización y versionado en
[docs.didacta.io](https://docs.didacta.io); el historial de cada versión, en
[Releases](https://github.com/va360labs/didacta-io/releases).

Imagen oficial en GitHub Container Registry:
`ghcr.io/va360labs/didacta-community`. **Pública** — no requiere
`docker login`, y es la única fuente al día. El espejo en
[Docker Hub](https://hub.docker.com/r/didactaio/community)
(`didactaio/community`) existe pero está **desactualizado** (se quedó en
`0.0.1-alpha.86`): no lo uses para desplegar.

## Verificar acceso a la imagen

```bash
# Fija SIEMPRE una versión concreta: los tags móviles (`beta`) son para
# entornos de prueba y `latest` existirá solo para versiones estables.
docker pull ghcr.io/va360labs/didacta-community:<versión>
```

Si se descarga sin pedir credenciales, ya puedes seguir cualquiera de los caminos de despliegue descritos abajo.

## Instalación en un comando

La vía rápida. Requiere **Docker** y el plugin **Docker Compose v2** (`docker compose`), nada más.

```bash
curl -fsSL https://raw.githubusercontent.com/va360labs/didacta-io/main/install.sh | bash
```

El instalador descarga el compose, **genera tu `AUTH_SECRET`**, fija la versión de la imagen, levanta el stack, espera a que responda y termina imprimiendo **el enlace del asistente de configuración con su token** — que es donde se atasca todo el mundo la primera vez, porque si no hay que ir a buscarlo a los logs.

No pregunta nada y no pisa nada: si ya existe un `.env` con `AUTH_SECRET`, lo reutiliza en vez de regenerarlo (regenerarlo echaría a todos los usuarios de su sesión sin avisar).

Ejecutar un script de internet a ciegas no es buena idea con ningún instalador, así que puedes leerlo antes:

```bash
curl -fsSL https://raw.githubusercontent.com/va360labs/didacta-io/main/install.sh -o install.sh
less install.sh
bash install.sh
```

Al terminar tendrás una carpeta `didacta/` con el `docker-compose.alpha.yml` y el `.env` generado. A partir de ahí se opera como cualquier instalación de compose.

**Variables opcionales**, todas con valor por defecto razonable:

| Variable               | Para qué                                                     | Default       |
| ---------------------- | ------------------------------------------------------------ | ------------- |
| `DIDACTA_DIR`          | Carpeta donde instalar                                       | `didacta`     |
| `DIDACTA_IMAGE_TAG`    | Versión de la imagen a desplegar                             | la del script |
| `WEB_PORT`             | Puerto de la web                                             | `3000`        |
| `API_PORT`             | Puerto de la API                                             | `4000`        |
| `MAILPIT_UI_PORT`      | Puerto de Mailpit                                            | `8025`        |
| `DIDACTA_PROJECT`      | Nombre del proyecto de compose, para convivir con otra copia | —             |
| `DIDACTA_COMPOSE_FILE` | Usar un compose local en vez de descargarlo                  | —             |

```bash
# Ejemplo: instalar en ./aula, con la web en el 8080
DIDACTA_DIR=aula WEB_PORT=8080 bash install.sh
```

Si prefieres hacerlo a mano, o ya tienes Postgres y Redis administrados, sigue el Camino A o el B.

## Paneles de autoalojado (Coolify, Dokploy, Easypanel)

Si ya administras tu servidor con uno de estos paneles, [`deploy/`](deploy/) trae una plantilla por plataforma, en el formato nativo de cada una: generan los secretos con sus propios helpers, publican **un solo dominio** (la web reescribe `/api/*` a la API interna) y fuerzan el Postgres con `pgvector` que Didacta necesita.

Se pueden usar hoy pegándolas en el panel, sin esperar a que estén en los catálogos oficiales. El detalle de cada una y sus advertencias están en [`deploy/README.md`](deploy/README.md).

## Variables de entorno obligatorias

Solo **3 variables de entorno** son estrictamente obligatorias para arrancar. El resto tienen valores por defecto razonables o se inyectan desde el compose. El conjunto completo está documentado en [`.env.example`](.env.example).

| Variable       | Qué es                                                                  | Cómo generarla                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Connection string de Postgres 16 con la extensión `pgvector` instalada. | Apunta a tu Postgres. Formato: `postgresql://<USUARIO>:<CONTRASEÑA>@<HOST>:5432/didacta?schema=public`. Con el compose de este repo se construye sola a partir de `POSTGRES_USER` y `POSTGRES_PASSWORD`.                                                                                                                                                                                                                                     |
| `REDIS_URL`    | Connection string de Redis 7.                                           | Apunta a tu Redis. Para compose: `redis://redis:6379`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `AUTH_SECRET`  | Secreto para firmar sesiones y cookies. Mínimo 32 caracteres.           | Cualquier cadena aleatoria de **32+ caracteres** sirve. Opciones: 1) un generador online de contraseñas con longitud 40+; 2) un gestor de contraseñas como 1Password o Bitwarden → "Generar contraseña" de 40 caracteres; 3) `openssl rand -base64 32`; 4) `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Lo importante: que sea aleatoria y que la guardes. Si la cambias, todas las sesiones se invalidan. |

## Camino A — Docker Compose

Recomendado para la mayoría de instalaciones.

Stack: API + web + Postgres + Redis + Mailpit (SMTP). Storage local por defecto en un volumen Docker, sin S3 externo.

```bash
# 1. Clonar
git clone https://github.com/va360labs/didacta-io.git
cd didacta-io

# 2. Configurar .env
cp .env.example .env

# 3. Pegar tu AUTH_SECRET en .env.
#    Debe ser una cadena aleatoria de 32+ caracteres.
#    Opciones rápidas:
#    - Un generador online de contraseñas con longitud 40+.
#    - Tu gestor de contraseñas → "Generar contraseña" de 40 caracteres.
#    - openssl rand -base64 32
#    - node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#    Edita .env y completa AUTH_SECRET=...

# 4. Fijar la versión de la imagen (las publicadas están en Releases:
#    https://github.com/va360labs/didacta-io/releases)
echo "DIDACTA_IMAGE_TAG=<versión>" >> .env

# 5. Arrancar
docker compose -f docker-compose.alpha.yml up -d

# 6. Esperar healthchecks (~60-90s la primera vez)
docker compose -f docker-compose.alpha.yml ps

# 7. Copiar el token de setup de un solo uso (obligatorio para crear la
#    cuenta admin — sin él /setup/init responde 403). Deja de valer en
#    cuanto termine el asistente o el contenedor se reinicie sin terminarlo.
docker compose -f docker-compose.alpha.yml logs didacta | grep "Setup token"

# 8. Abrir (usa la URL /setup?token=... que imprimió el paso anterior)
# http://localhost:3000             — Web
# http://localhost:4000/api/docs    — Swagger
# http://localhost:4000/healthz     — health probe
# http://localhost:8025             — Mailpit, emails de prueba
```

### Persistencia: volúmenes Docker

El compose declara cuatro volúmenes nombrados que sobreviven a `down`/`up` y reinicios:

| Volumen         | Qué guarda                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `postgres_data` | Toda la base de datos.                                                                                                           |
| `redis_data`    | Cola persistente (`appendonly yes`) — outbox + jobs.                                                                             |
| `didacta_data`  | Storage local de la aplicación: uploads de cursos, certificados y evidencias + clave de cifrado autogenerada para datos at-rest. |
| `minio_data`    | Solo si activas el profile `s3`. Guarda los buckets de MinIO.                                                                    |

**Importante**: `docker compose down -v` borra los volúmenes y, por tanto, los datos. Para detener sin borrar, usa `docker compose down` sin `-v`.

Backup recomendado para producción: `pg_dump` + `tar` del volumen `didacta_data`.

### Storage opcional con MinIO

Si quieres probar el flujo S3-compatible sin pagar AWS, Hetzner u otro proveedor, arranca MinIO con el profile `s3`:

```bash
docker compose -f docker-compose.alpha.yml --profile s3 up -d
# Consola de MinIO disponible en http://localhost:9001
```

Después, descomenta las líneas `S3_*` en `docker-compose.alpha.yml`, dentro del servicio `didacta`, para que la aplicación use MinIO en lugar del disco local.

Para producción real, apunta a tu Hetzner Object Storage, AWS S3 u otro proveedor compatible configurando las variables `S3_*` en `.env`.

El quickstart de esta página cubre el arranque; el manual completo de instalación, actualización y operación vive en [docs.didacta.io](https://docs.didacta.io). Para dudas, bugs o feedback, abre una issue en GitHub — hay plantillas de bug, feedback y feature request. Para vulnerabilidades de seguridad, sigue [`SECURITY.md`](SECURITY.md).

## Camino B — Docker pull + run manual

Para operadores que ya tienen Postgres 16 + Redis 7 administrados y solo quieren ejecutar el contenedor de la aplicación.

**Requisitos previos:**

- Postgres 16 con extensión `pgvector` instalada y schema vacío. La aplicación aplica las migraciones Prisma al arrancar.
- Redis 7 accesible desde el contenedor.
- Las 3 variables de entorno obligatorias listadas arriba.

```bash
docker pull ghcr.io/va360labs/didacta-community:0.1.0-beta.6

# Crear volumen para uploads + clave de cifrado autogenerada.
# El volumen sobrevive a reinicios.
docker volume create didacta_data

docker run -d \
  --name didacta-app \
  -p 3000:3000 \
  -p 4000:4000 \
  -v didacta_data:/app/data \
  -e DATABASE_URL='postgresql://<USUARIO>:<CONTRASEÑA>@<HOST>:5432/didacta?schema=public' \
  -e REDIS_URL='redis://<HOST>:6379' \
  -e AUTH_SECRET='<tu-cadena-aleatoria-de-32+-caracteres>' \
  -e STORAGE_DRIVER=local \
  -e STORAGE_ROOT=/app/data/storage \
  -e NODE_ENV=production \
  --restart unless-stopped \
  ghcr.io/va360labs/didacta-community:0.1.0-beta.6
```

> El volumen `didacta_data` guarda los archivos subidos —cursos, certificados y evidencias— **y** una clave de cifrado autogenerada en el primer arranque para los secretos at-rest. Sin ese volumen montado, todo se borra al recrear el contenedor.

> Si prefieres S3-compatible en lugar de disco local: elimina `STORAGE_DRIVER` y `STORAGE_ROOT`, y añade `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. Aun así, conviene mantener el volumen montado para la clave de cifrado.

**Verificar:**

```bash
docker logs -f didacta-app                  # ver bootstrap + migraciones Prisma
curl -fsS http://localhost:4000/healthz     # debe responder 200
docker logs didacta-app | grep "Setup token"  # token de un solo uso para /setup?token=...
```

**Variables opcionales útiles** — conjunto completo en [`.env.example`](.env.example):

| Variable                                                        | Para qué                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`    | Storage S3-compatible: MinIO, AWS, Hetzner, etc. Obligatorio para subida de contenido.         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Envío de emails transaccionales. Sin esto, los emails se registran en logs pero no se envían.  |
| `DIDACTA_LICENSE_KEY`                                           | JWT firmado por Didacta para activar capabilities Enterprise. Sin esto, modo Community puro.   |
| `METRICS_TOKEN`                                                 | Bearer token para proteger `/metrics` en Prometheus. Si está vacío, el endpoint queda público. |

## Sobre el proyecto

Didacta es un LMS (Learning Management System) **fair-code de nueva generación**: código fuente disponible bajo la [Didacta Sustainable Use License v1.0](LICENSE), arquitectura modular, sin licencias por usuario y con cumplimiento legal integrado en el núcleo. Diseñado para academias, formadores y organizaciones que quieren operar su propia plataforma de formación con control total.

Lo crea y lo mantiene **[VA360 LABS S.L.](https://va360labs.com)**, autora
original del proyecto y titular de la marca. El código es de quien lo
despliegue —audítalo, modifícalo, úsalo internamente sin pedir permiso—; la
dirección del proyecto se queda con quien lo empezó, que es lo que significa
fair-code.

Más información y demo en vivo: [didacta.io](https://didacta.io).

### Por qué Didacta

- **Modular de verdad.** Instala solo lo que necesitas. Cada función es un módulo limpio: sin parches, sin temas que rompen en cada actualización, sin deuda técnica acumulada.
- **Fair-code.** Tu plataforma, tu código: audítalo, modifícalo y despliégalo con uso interno libre bajo la [Didacta Sustainable Use License v1.0](LICENSE). Sin licencias por usuario. La distribución comercial, el SaaS o el white-label de terceros requieren acuerdo (ver [Modelo de licencias](#modelo-de-licencias)).
- **Cumplimiento serio.** Fundae, RGPD y WCAG 2.2 AA integrados en el núcleo, no añadidos con plugins de terceros. Trazabilidad, auditoría y exportación de datos listos desde el día uno.
- **IA discreta.** Inteligencia artificial que ayuda sin interrumpir: crea contenido, sugiere itinerarios y resume actividad.

### Tres formas de llenar tu academia de alumnos

Los tres caminos conviven en la misma instalación y se combinan libremente:

1. **Tú los das de alta.** Invita alumnos uno a uno o por lotes desde el panel: eliges su grupo de acceso al invitarles, reciben un email para crear su contraseña y entran directamente a sus cursos. Desde la ficha de cada alumno gestionas sus grupos, matrículas y bajas. Ideal para formación interna, bonificada o clases presenciales que se llevan al aula virtual.

2. **Vendes cursos sueltos.** Publica un curso, ponle precio —con varias opciones de compra si quieres— y comparte tu catálogo público en `/catalogo`. El visitante paga con tarjeta vía Stripe sin registrarse antes: su cuenta se crea automáticamente con el email confirmado en el pago y queda matriculado al instante. Los reembolsos retiran el acceso solos.

3. **Vendes membresías.** Crea planes con la periodicidad (1–12 meses) y la moneda que quieras, con periodo de prueba opcional. Tu página pública de venta en `/unete` muestra el catálogo real; al suscribirse, el alumno accede a todos los cursos del grupo que definas. Si deja de pagar, el acceso se revoca automáticamente — sin tocar lo que hayas concedido a mano.

Y si tu comunidad exige aprobación previa, activa el **registro con solicitud**: configura los verificadores que pida tu caso (verificación de email, Telegram o ninguno), revisa la evidencia de cada solicitud y aprueba o rechaza con un clic.

### Tres ediciones, mismo producto

| Edición                   | Para quién                                                            | Incluye                                                                                                              |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Community** (este repo) | Equipos que despliegan y operan ellos mismos.                         | Todo el código fuente. Comunidad activa de contribuidores.                                                           |
| **Cloud**                 | Quien quiere arrancar en minutos, sin infraestructura.                | Hosting gestionado por [VA360 LABS](https://va360labs.com) con actualizaciones sin intervención. **En preparación.** |
| **Enterprise**            | Organizaciones con SLA, integraciones a medida y partner certificado. | Account manager dedicado, onboarding guiado, integraciones con sistemas existentes, infraestructura monitorizada.    |

Detalles y precios: [didacta.io/es/pricing](https://didacta.io/es/pricing).

## Modelo de licencias

Didacta es **fair-code**: source-available, uso interno empresarial libre, distribución comercial / SaaS de terceros bajo acuerdo. Modelo Open-Core con capabilities Enterprise protegidas:

- **Repo + módulos**: [Didacta Sustainable Use License v1.0](LICENSE) (fair-code, adaptada de n8n SUL). Permite uso interno empresarial libre. Distribución comercial / SaaS / white-label requiere acuerdo con [VA360 LABS S.L.](https://va360labs.com)
- **Capabilities Enterprise** (archivos `*.ee.*` dentro del CORE): [Didacta Enterprise License](LICENSE_EE). Requieren licencia firmada activa para usarse en producción.
- **Cloud**: SaaS gestionado por [VA360 LABS](https://va360labs.com). **En preparación**, todavía no abierto.

Resumen humano: [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md). Política de uso comercial: [`COMMERCIAL_USE.md`](COMMERCIAL_USE.md). Marca registrada: [`TRADEMARKS.md`](TRADEMARKS.md). Dudas de licensing: `licensing@didacta.io`.

## Telemetría

Cada instalación envía **un latido diario anónimo** a `registry.didacta.io` para que sepamos cuántas instalaciones de Didacta existen. El payload completo es este y nada más:

| Campo                 | Contenido                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceId`          | UUID **aleatorio** generado en la primera ejecución (`.didacta-instance-id` en el volumen de datos). No identifica a ninguna persona ni organización. |
| `version` / `edition` | Versión de Didacta y edición (`community` o el plan Enterprise).                                                                                      |
| `node` / `os`         | Versión de Node y plataforma (`linux/x64`…).                                                                                                          |
| `sentAt`              | Fecha del latido.                                                                                                                                     |

Sin PII, sin datos de negocio (ni usuarios, ni cursos, ni dominios), sin bloquear nada: si no hay salida a internet, el latido falla en silencio y la plataforma funciona igual. **Se desactiva con una variable de entorno**:

```bash
DIDACTA_TELEMETRY_DISABLED=true
```

Aparte existe un **registro opt-in** voluntario (Administración → Registro) donde el operador puede identificarse con email y organización a cambio de canal directo con el equipo; ese nivel envía métricas agregadas y tiene opt-out y borrado RGPD desde el propio panel.

## Documentación

- 📚 [docs.didacta.io](https://docs.didacta.io) — Documentación oficial (es/en): instalación, actualización, operación y versionado.
- 🤝 [`CONTRIBUTING.md`](CONTRIBUTING.md) — Guía de contribución.
- 🔒 [`SECURITY.md`](SECURITY.md) — Política de seguridad y reporte responsable.
- 📋 [Releases](https://github.com/va360labs/didacta-io/releases) — Historial de cambios de cada versión publicada.
- 📜 [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md) — Resumen humano del modelo de licencias.
- 🧭 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Código de conducta.
- 🐛 Bugs y feedback — issues de GitHub (plantillas de bug, feedback y feature request).

## Stack tecnológico

- **Backend**: Node.js 22 + NestJS 11 + TypeScript.
- **Frontend**: Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui.
- **Base de datos**: PostgreSQL 16 con Row-Level Security + Prisma.
- **Cache / colas**: Redis 7 + BullMQ.
- **Object storage**: S3-compatible (MinIO en compose, cualquier proveedor S3 en producción).
- **IA**: capa pluggable — hoy usa proveedor LLM externo; futuras versiones permitirán cambiar de proveedor.
- **Monorepo**: Turborepo + pnpm workspaces.

## Licencia

Didacta Community © 2026 [VA360 LABS S.L.](https://va360labs.com) — creadora original del proyecto. Distribuido bajo [Didacta Sustainable Use License v1.0](LICENSE) (fair-code).

Capabilities Enterprise: [Didacta Enterprise License](LICENSE_EE).

Didacta™ es una marca de [VA360 LABS S.L.](https://va360labs.com) Ver [`TRADEMARKS.md`](TRADEMARKS.md).
