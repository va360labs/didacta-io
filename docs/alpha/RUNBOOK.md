# Runbook — Operación Alpha de Didacta

> Procedimientos para deploy, troubleshoot, restore y monitorización del stack alpha cerrada.
> Audiencia: equipo VA360 (no para alpha testers).

## 1. Stack desplegado

- **Hosting**: Easypanel sobre VPS Hetzner (`lab-learnship.3qntut.easypanel.host` legacy).
- **Imagen**: `docker.io/didactaio/community:0.0.1-alpha.0` (mirror GHCR deshabilitado por billing).
- **Bases de datos**: Postgres 16 + pgvector + Redis 7 + MinIO/S3, todo dentro del compose alpha.
- **Versión actual**: ver `docs/versioning.md`.

## 2. Deploy de un nuevo alpha

### 2.1 Build local + push manual a Docker Hub

```bash
cd /d/Test/didacta-community
docker build -t didactaio/community:0.0.1-alpha.X -f Dockerfile .
docker tag didactaio/community:0.0.1-alpha.X didactaio/community:alpha
docker push didactaio/community:0.0.1-alpha.X
docker push didactaio/community:alpha
```

Tag git también:

```bash
git tag -a v0.0.1-alpha.X -m "Notas del release"
git push origin v0.0.1-alpha.X
```

### 2.2 Aviso a alpha testers

- Mensaje en `#didacta-alpha` (Discord/Slack) anunciando el bump.
- Cada tester actualiza con:
  ```bash
  # Edita .env: DIDACTA_IMAGE_TAG=0.0.1-alpha.X
  docker compose -f docker-compose.alpha.yml pull
  docker compose -f docker-compose.alpha.yml up -d
  ```

### 2.3 Smoke test post-deploy

```bash
DIDACTA_IMAGE_TAG=alpha docker compose -f docker-compose.alpha.yml up -d
sleep 30
curl -fsS http://localhost:4000/healthz
curl -fsS http://localhost:4000/api/license
curl -fsS http://localhost:4000/api/v1/branding/options
curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost:4000/api/docs
curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost:3000
docker compose -f docker-compose.alpha.yml down
```

Esperado: 6 HTTP 200/307 verde antes de comunicar a testers.

## 3. Troubleshooting frecuente

### 3.1 "Container didacta no arranca" → revisar logs

```bash
docker compose -f docker-compose.alpha.yml logs --tail 200 didacta
```

Causas más comunes:
- **Falta `AUTH_SECRET` o tiene formato inválido**: el bootstrap aborta. Genera uno con `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- **Postgres aún arrancando**: el entrypoint reintenta `prisma db push` 3 veces. Si falla las 3, revisar logs del servicio `postgres`.
- **Volumen corrupto** tras `docker compose down -v` mal hecho: limpiar con `docker volume prune` + reiniciar (PIERDE datos).

### 3.2 "No puedo descargar la imagen"

- Verifica login: `docker login -u didactaio` con la credencial del kickoff.
- Si la credencial es inválida, regenérala desde Docker Hub (cuenta `didactaio`).

### 3.3 "La UI Next.js está caída pero el API funciona"

- El primer arranque de Next.js puede tardar 1-2 min en compilar páginas. `docker compose logs didacta | grep "ready"`.
- Si pasados 5 min sigue caído, revisa `apps/web/.next/standalone/` dentro del contenedor.

### 3.4 "Quiero borrar todo y empezar limpio (DESTRUCTIVO)"

```bash
docker compose -f docker-compose.alpha.yml down -v
docker volume prune -f
# vuelve a arrancar
docker compose -f docker-compose.alpha.yml up -d
```

⚠️ Esto borra DB, archivos subidos y cache. **Solo en dev**.

## 4. Backup y restore

### 4.1 Backup Postgres

```bash
# Dentro del host del compose alpha:
docker compose -f docker-compose.alpha.yml exec postgres pg_dump -U didacta -F c didacta > backup-$(date +%F).dump
```

Programar cron diario y rotación 7 días.

### 4.2 Restore

```bash
docker compose -f docker-compose.alpha.yml down
# Levantar SOLO postgres, dropear schema, restaurar:
docker compose -f docker-compose.alpha.yml up -d postgres
sleep 10
docker compose -f docker-compose.alpha.yml exec postgres pg_restore -U didacta -d didacta --clean --if-exists < backup-YYYY-MM-DD.dump
docker compose -f docker-compose.alpha.yml up -d
```

### 4.3 Backup MinIO

```bash
docker compose -f docker-compose.alpha.yml exec minio mc mirror /data /backups/minio-$(date +%F)
```

## 5. Monitorización

### 5.1 Endpoints de salud

| Endpoint | Qué reporta |
|----------|-------------|
| `GET /healthz` | api+db+redis+s3 vivos |
| `GET /admin/system/health-detail` | breakdown por servicio (super_admin) |
| `GET /metrics` | Prometheus scrape (ver `docs/PRD.md` §10) |
| `GET /audit/verify` | cadena de hashes de audit log (super_admin) |

### 5.2 Logs en producción

```bash
# Tail en vivo
docker compose -f docker-compose.alpha.yml logs -f didacta

# Buscar errores últimas 24h
docker compose -f docker-compose.alpha.yml logs --since 24h didacta | grep -i "error\|fatal"
```

### 5.3 Outbox lag

Métrica clave para EventBus:
- `outbox_pending_oldest_age_seconds`: si > 60s sostenido, dispatcher caído.
- `outbox_pending_events`: si > 100 sostenido, recovery worker no procesa.

Dashboard Grafana: `infra/grafana/dashboards/didacta-platform.json`.

## 6. Rotación de secretos

| Secreto | Cómo regenerar | Frecuencia |
|---------|----------------|-----------|
| `AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | Solo si comprometido (invalida sessions) |
| `TENANT_SETTINGS_ENC_KEY` | `openssl rand -hex 32` | Solo si comprometido (rota encryption AES-256-GCM at-rest, requiere migración) |
| `DIDACTA_LICENSE_KEY` | Reemitir desde Cloud god | Cuando expira o cambia plan |

## 7. Procedimiento ante incidente de seguridad

1. **Triage**: identificar si es leak, RCE, credenciales, etc.
2. **Contención**: pausar contenedor afectado (`docker compose stop didacta`).
3. **Notificación**: email a `security@didacta.io` (o canal dedicado).
4. **Evidencia**: copiar logs + audit log antes de cualquier mitigación destructiva.
5. **Mitigación**: rotar secretos, deploy patch, etc.
6. **Postmortem**: documentar en `docs/postmortems/YYYY-MM-DD-incidente.md` (crear directorio si no existe).

## 8. Comunicación con alpha testers

- **Avisos de release**: mensaje en `#didacta-alpha` con notas del cambio + comando de update.
- **Avisos de downtime**: 24h de antelación si es planificado, ASAP si no.
- **Avisos de breaking change**: NO hacer breaking en alpha si se puede evitar. Si imprescindible, doc en `CHANGELOG.md` con instrucciones explícitas y mensaje individual a cada tester.
- **Office hour**: jueves 18:00 CET, 30 min, opcional.

## 9. Escalación

- Bug P0 (data loss / data leak / outage): inmediato, parar todo.
- Bug P1 (función crítica no disponible para algún tester): mismo día.
- Bug P2 (función no crítica rota): siguiente release.
- Bug P3 (cosmético, mejora): backlog.

Etiquetado en GitHub Issues: labels `priority:P0..P3` + `alpha-tester`.

## 10. Cuando terminar el alpha

Cuando se cumplen los 6 criterios de v0.0.1 → v0.0.2 → ... → v0.1.0 (ver `docs/alpha/INSTALL.md` → "Cuando v0.0.1 sea estable"). Reunión de cierre + retro. Comunicación pública prevista en MIG-033 (bloqueado-valen).
