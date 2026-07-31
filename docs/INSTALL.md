# Instalar Didacta Community (self-host)

Guía de instalación con Docker Compose, el camino recomendado. Al terminar
tendrás la plataforma completa (web + API + Postgres + Redis + buzón de correo
de pruebas) corriendo en tu máquina o servidor.

## Requisitos

- Docker 24+ con Docker Compose v2 (`docker compose version`).
- 2 GB de RAM libres y ~2 GB de disco para imágenes y datos.
- Puertos libres: `3000` (web), `4000` (API), `5432` (Postgres), `6379`
  (Redis), `8025` (UI del buzón de correo). Todos son configurables por env.

> **Postgres**: el compose usa la imagen `pgvector/pgvector:pg16`. Si traes tu
> propio Postgres tiene que ser 16+ **con la extensión `pgvector` disponible**
> (el tutor IA guarda embeddings en columnas `vector`).

## Instalación

```bash
# 1. Descarga el compose y la plantilla de entorno
git clone https://github.com/va360labs/didacta-community.git
cd didacta-community

# 2. Configura el entorno. Con compose solo AUTH_SECRET es obligatoria.
cp .env.example .env
# Edita .env y rellena AUTH_SECRET con un secreto largo y aleatorio:
#   openssl rand -hex 32

# 3. Arranca el stack
docker compose -f docker-compose.alpha.yml up -d

# 4. Comprueba que todo está sano
docker compose -f docker-compose.alpha.yml ps
```

En el primer arranque el contenedor de la app aplica automáticamente las
migraciones versionadas (`prisma migrate deploy`), las políticas RLS y el seed
idempotente de sistema. No hay que ejecutar nada a mano.

### Primer acceso

1. Abre `http://localhost:3000`. La primera vez te llevará al **asistente de
   configuración** (`/setup`): ahí creas la organización (tenant) y la cuenta
   del primer administrador.
2. Entra con esa cuenta y configura tu marca en **Administración → Marca**
   (logo, colores, textos de la pantalla de acceso).
3. El correo saliente apunta por defecto al buzón de pruebas Mailpit
   (`http://localhost:8025`). Para producción configura tu SMTP real en
   **Administración → SMTP**.

## Opciones

### Almacenamiento de ficheros

Por defecto los ficheros (portadas, certificados, evidencias) se guardan en
disco, en el volumen `didacta_data`. Para usar un almacenamiento S3-compatible:

- MinIO local: `docker compose -f docker-compose.alpha.yml --profile s3 up -d`
  y descomenta las variables `S3_*` del bloque `environment` del compose.
- S3 externo (AWS, Hetzner…): rellena las `S3_*` en `.env` y pon
  `STORAGE_DRIVER=s3`.

### Versión de la imagen

La versión se fija con `DIDACTA_IMAGE_TAG` en `.env` (tags publicados en
[Docker Hub — didactaio/community](https://hub.docker.com/r/didactaio/community)).
No existe tag `latest`: fija siempre una versión concreta. Para actualizar,
lee [UPGRADE.md](UPGRADE.md).

### Licencia Enterprise

Community funciona completa sin licencia. Si tienes una licencia Enterprise,
ponla en `DIDACTA_LICENSE_KEY` y las capabilities EE (SAML/OIDC, SCIM,
white-label, dominios propios…) se desbloquean al arrancar. Sin licencia, esas
pantallas quedan visibles con un aviso, nunca ocultas.

## Problemas frecuentes

| Síntoma | Causa y arreglo |
| --- | --- |
| La app no arranca y el log dice `type "vector" does not exist` | Tu Postgres no tiene pgvector. Usa `pgvector/pgvector:pg16` o instala la extensión (`CREATE EXTENSION vector;`). |
| `Error: P3009 — migrate found failed migrations` | Una migración quedó a medias (p. ej. por un corte). Revisa el log, corrige la causa y marca la migración con `prisma migrate resolve`; el arranque nunca borra datos por su cuenta. |
| El navegador carga pero la API da 502/timeout | El primer arranque tarda hasta ~60 s (healthcheck `start_period`). Mira `docker compose -f docker-compose.alpha.yml logs -f didacta`. |
| No llegan los correos | En la instalación por defecto los correos van al Mailpit local (`http://localhost:8025`), no a internet. Configura SMTP real en Administración → SMTP. |
| Puerto ocupado | Cambia `WEB_PORT`, `API_PORT`, `POSTGRES_PORT`… en `.env`. |

## Copias de seguridad

Lo que hay que salvar son dos cosas: la base de datos y el volumen de ficheros.

```bash
# Base de datos
docker exec didacta-postgres pg_dump -U didacta -d didacta -Fc > didacta-$(date +%F).dump

# Ficheros (storage local + clave de cifrado autogenerada)
docker run --rm -v didacta-community_didacta_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/didacta-data-$(date +%F).tar.gz -C /data .
```

Haz siempre una copia antes de actualizar de versión.
