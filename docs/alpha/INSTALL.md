# Instalación — Didacta Community Alpha

> Guía para alpha testers. ~10 minutos en una máquina con Docker Desktop / Linux con Docker.

## Pre-requisitos

- **Docker Desktop** (Mac/Windows) o **Docker Engine + Compose** (Linux). Versión 24+.
- **Acceso al repo privado** `va360labs/didacta-community` (te lo damos como collaborator).
- **Credencial Docker Hub** del namespace `didactaio` (te la damos por canal privado durante el onboarding alpha).
- 4 GB de RAM libres y 5 GB de disco libre.

## Pasos

### 1. Login en Docker Hub (registro de imágenes alpha)

La imagen vive en `docker.io/didactaio/community`. Durante alpha cerrada el repo del registry es privado, así que necesitas hacer login con la credencial que te pasamos.

```bash
docker login -u didactaio
# Password: la credencial read-only que te damos en el kickoff
```

> **Si en futuras versiones publicamos la imagen como pública**, este paso podrá saltarse y `docker compose pull` funcionará sin login.

### 2. Clonar el repo

```bash
git clone https://github.com/va360labs/didacta-community.git
cd didacta-community
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y rellena al menos:

- `AUTH_SECRET`: genera uno con
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- `DIDACTA_IMAGE_TAG`: pon el último alpha que te indiquemos (ej. `0.0.1-alpha.0`).

El resto puedes dejarlo en valores por defecto para alpha local.

### 4. Arrancar Didacta

```bash
docker compose -f docker-compose.alpha.yml up -d
```

Esto descarga la imagen + dependencias y levanta el stack completo. La primera vez tarda ~3-5 min.

### 5. Validar que arrancó

Abre en el navegador:

- `http://localhost:4000/api/docs` → Swagger del API. Si lo ves, el backend funciona.
- `http://localhost:4000/healthz` → debe devolver 200.
- `http://localhost:4000/api/license` → debe devolver `{"status":"community", "capabilities":[], ...}`.
- `http://localhost:3000` → frontend (puede tardar un poco más en arrancar la primera vez).
- `http://localhost:8025` → Mailpit (servidor SMTP de prueba para ver emails enviados).
- `http://localhost:9001` → MinIO console (storage S3-compatible).

### 6. Crear primer admin

(Pendiente: el flow de bootstrap de admin estará listo en MIG-026 / Sprint 1).

Por ahora, mira los logs:

```bash
docker compose -f docker-compose.alpha.yml logs -f didacta
```

## Comandos útiles

### Parar y reiniciar

```bash
docker compose -f docker-compose.alpha.yml down       # parar (datos persisten)
docker compose -f docker-compose.alpha.yml up -d      # reiniciar
```

### Ver logs

```bash
docker compose -f docker-compose.alpha.yml logs -f             # todos
docker compose -f docker-compose.alpha.yml logs -f didacta     # solo app
```

### Borrar TODO y empezar limpio

```bash
docker compose -f docker-compose.alpha.yml down -v    # ⚠️ borra volúmenes (DB, archivos)
```

### Actualizar a un nuevo alpha

Cuando lancemos `0.0.1-alpha.1`:

```bash
# Edita .env: DIDACTA_IMAGE_TAG=0.0.1-alpha.1
docker compose -f docker-compose.alpha.yml pull
docker compose -f docker-compose.alpha.yml up -d
```

## Si algo va mal

1. Comprueba `docker compose -f docker-compose.alpha.yml ps` — todos los servicios deben estar `Up (healthy)`.
2. Revisa logs del servicio que esté unhealthy.
3. Si todo lo demás falla, abre una issue siguiendo `docs/alpha/FEEDBACK.md`.

## Lo que NO funciona en alpha

- ⚠️ **Sistema de registro opt-in con Cloud god**: no contacta servidor remoto (Cloud god aún no existe — Sprint 2). El registro queda local.
- ⚠️ **Imagen Docker pública**: la imagen está en Docker Hub privado (`didactaio/community`). Solo accesible con la credencial que te damos.
- ⚠️ **Capabilities Enterprise**: solo white-label como piloto. Resto vendrá en próximos alphas.
- ⚠️ **Marketplace de módulos**: no existe todavía. Los módulos oficiales vienen pre-instalados.

## Próximos pasos

Cuando hayas instalado, ve a [`docs/alpha/FEEDBACK.md`](FEEDBACK.md) para saber cómo reportar bugs y feedback.

¡Bienvenido al alpha de Didacta! 🎉
